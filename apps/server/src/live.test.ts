import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@digestit/core';
import { RANGE_PROMPT_VERSION } from '@digestit/explain';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { computeMetrics, parseSince } from './live.js';

const T = (m: number) => `2026-09-24T10:${String(m).padStart(2, '0')}:00Z`;

function seed(path = ':memory:') {
  const db = openDb(path);
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'r', '/x')").run();
  const commit = db.prepare(
    "INSERT INTO commit_ (sha, repo_id, author_name, authored_at, committed_at, message) VALUES (?, 1, 'a', ?, ?, ?)",
  );
  const cu = db.prepare("INSERT INTO change_unit (id, repo_id, kind, head_sha, base_sha, title) VALUES (?, 1, ?, ?, ?, ?)");
  for (let i = 1; i <= 4; i++) {
    commit.run(`c${i}`, T(i), T(i), `commit ${i}\n\nbody`);
    cu.run(i, 'commit', `c${i}`, null, `commit ${i}`);
  }
  cu.run(10, 'range', 'c2', 'c0', 'DIG-1 old range');
  cu.run(11, 'range', 'c3', 'c0', 'DIG-1 range');
  const wu = db.prepare(
    `INSERT INTO work_unit (id, repo_id, key, kind, title, state, tip_sha, base_sha, first_commit_at, last_commit_at, merged_at, latest_range_unit_id)
     VALUES (?, 1, ?, ?, ?, ?, ?, 'c0', ?, ?, ?, ?)`,
  );
  wu.run(1, 'DIG-1', 'issue', 'First', 'handoff', 'c3', T(1), T(3), null, 11);
  wu.run(2, 'feature/x', 'branch', 'Slashy', 'active', 'c4', T(4), T(4), null, null);
  wu.run(3, 'DIG-3', 'issue', 'Old', 'merged', 'c1', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z', null);
  const member = db.prepare('INSERT INTO unit_commit VALUES (?, ?)');
  for (const s of ['c1', 'c2', 'c3']) member.run(1, s);
  member.run(2, 'c4');
  db.prepare("INSERT INTO file_change (change_unit_id, path, status, additions, deletions) VALUES (11, 'a.ts', 'M', 5, 2)").run();
  const ex = db.prepare("INSERT INTO explanation VALUES (?, ?, ?, 'ok', 'stub', 'm', 'v1', 'h', '2026-09-24')");
  ex.run(10, 0, '{"text":"old why"}');
  ex.run(11, 0, '{"text":"why"}');
  db.prepare("INSERT INTO worktree_state VALUES (1, '/wt', 'DIG-1-slug', 'c3', 4, 120, 30, 0, '2026-09-24T10:05:00Z')").run();
  return db;
}

const closers: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!.close();
});
const make = (db = seed(), live = {}) => {
  const app = buildApp({ db, webDir: '/nonexistent', live });
  closers.push(app);
  return app;
};

describe('work units', () => {
  it('lists newest-first with cursor pagination and state filter', async () => {
    const app = make();
    const p1 = (await app.inject('/api/work-units?limit=2')).json();
    expect(p1.workUnits.map((w: { key: string }) => w.key)).toEqual(['feature/x', 'DIG-1']);
    expect(p1.workUnits[1]).toMatchObject({ commitCount: 3, l0: { status: 'ok', content: { text: 'why' } } });
    expect(p1.workUnits[1].dirty).toEqual([expect.objectContaining({ files: 4, additions: 120, deletions: 30 })]);
    expect(p1.workUnits[0].l0.status).toBe('pending');
    const p2 = (await app.inject(`/api/work-units?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.workUnits.map((w: { key: string }) => w.key)).toEqual(['DIG-3']);
    expect(p2.nextCursor).toBeNull();
    const merged = (await app.inject('/api/work-units?state=merged')).json();
    expect(merged.workUnits.map((w: { key: string }) => w.key)).toEqual(['DIG-3']);
  });

  it('rejects bad parameters', async () => {
    const app = make();
    for (const q of ['state=nope', 'limit=0', 'cursor=zzz', 'repoId=x']) {
      expect((await app.inject(`/api/work-units?${q}`)).statusCode).toBe(400);
    }
  });

  it('returns members, range snapshots, latest explanation and dirty diffstat', async () => {
    const app = make();
    const d = (await app.inject('/api/work-units/DIG-1')).json();
    expect(d.members.map((m: { sha: string }) => m.sha)).toEqual(['c3', 'c2', 'c1']);
    expect(d.members[0]).toMatchObject({ title: 'commit 3', changeId: 3 });
    expect(d.ranges.map((r: { id: number }) => r.id)).toEqual([11, 10]);
    expect(d.ranges[0]).toMatchObject({ isLatest: true, stats: { files: 1, additions: 5, deletions: 2 } });
    expect(d.explanation).toMatchObject({ changeUnitId: 11, stale: false, levels: { l0: { content: { text: 'why' } } } });
    expect(d.dirty[0].branch).toBe('DIG-1-slug');
  });

  it('marks the explanation stale when only an older snapshot has one, and handles slash keys', async () => {
    const db = seed();
    db.prepare('DELETE FROM explanation WHERE change_unit_id = 11').run();
    const app = make(db);
    expect((await app.inject('/api/work-units/DIG-1')).json().explanation).toMatchObject({ changeUnitId: 10, stale: true });
    const slashy = await app.inject(`/api/work-units/${encodeURIComponent('feature/x')}`);
    expect(slashy.json()).toMatchObject({ key: 'feature/x', explanation: null, ranges: [] });
    expect((await app.inject('/api/work-units/nope')).statusCode).toBe(404);
  });
});

describe('pending (budget)', () => {
  it('flags units the scheduler left waiting on the budget, in list and detail', async () => {
    const db = seed();
    // DIG-1's latest range (11) has an L0 in seed; drop it so the unit counts as unexplained.
    db.prepare('DELETE FROM explanation WHERE change_unit_id = 11').run();
    db.prepare("INSERT INTO explain_call (at, change_unit_id, reason, outcome) VALUES (?, 11, 'handoff', 'budget')").run(new Date().toISOString());
    const app = make(db);
    const list = (await app.inject('/api/work-units')).json().workUnits as { key: string; pendingBudget: boolean }[];
    expect(Object.fromEntries(list.map((u) => [u.key, u.pendingBudget]))).toEqual({ 'feature/x': false, 'DIG-1': true, 'DIG-3': false });
    expect((await app.inject('/api/work-units/DIG-1')).json().pendingBudget).toBe(true);
    expect((await app.inject('/api/work-units/DIG-3')).json().pendingBudget).toBe(false);
    // Explained since: no longer pending.
    db.prepare("INSERT INTO explanation VALUES (11, 0, '{\"text\":\"why\"}', 'ok', 'stub', 'm', ?, 'h', '2026-09-24')").run(RANGE_PROMPT_VERSION);
    expect((await app.inject('/api/work-units/DIG-1')).json().pendingBudget).toBe(false);
  });
});

describe('window', () => {
  it('lists units that moved since, with a null roll-up before any exists', async () => {
    const app = make();
    const w = (await app.inject('/api/window?since=2026-09-24T10:02:00Z')).json();
    expect(w.workUnits.map((x: { key: string }) => x.key)).toEqual(['feature/x', 'DIG-1']);
    expect(w.rollup).toBeNull();
    const all = (await app.inject('/api/window?since=2026-09-20T00:00:00Z')).json();
    expect(all.workUnits).toHaveLength(3);
    // A state change inside the window counts as movement even without new commits.
    const db = seed();
    db.prepare("INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (1, 3, 'merged', '2026-09-24T12:00:00Z')").run();
    // Viewer events are not movement.
    db.prepare("INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (1, 1, 'opened', '2026-09-24T12:00:00Z')").run();
    const moved = (await make(db).inject('/api/window?since=2026-09-24T11:00:00Z')).json();
    expect(moved.workUnits.map((x: { key: string }) => x.key)).toEqual(['DIG-3']);
  });

  it('includes the roll-up when present and validates since', async () => {
    const db = seed();
    db.exec(`INSERT INTO rollup (id, window_start, window_end, work_unit_ids, content, created_at)
      VALUES (1, '2026-09-24T09:00:00Z', '2026-09-24T10:30:00Z', '[1,2]', '{"l0":"busy hour"}', '2026-09-24T10:30:00Z')`);
    const app = make(db);
    expect((await app.inject('/api/window?since=2026-09-24T10:00:00Z')).json().rollup)
      .toMatchObject({ id: 1, workUnitIds: [1, 2], content: { l0: 'busy hour' } });
    expect((await app.inject('/api/window')).statusCode).toBe(400);
    expect((await app.inject('/api/window?since=garbage')).statusCode).toBe(400);
  });

  it('parses relative and absolute since values', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(parseSince('1h', now)).toBe(Date.parse('2026-09-24T11:00:00Z') / 1000);
    expect(parseSince('2026-09-24T11:00:00Z')).toBe(Date.parse('2026-09-24T11:00:00Z') / 1000);
    expect(parseSince('nope')).toBeNull();
  });
});

describe('metrics', () => {
  it('is an empty-but-valid stub with no events', async () => {
    const m = (await make().inject('/api/metrics')).json();
    expect(m.global).toMatchObject({ unreadBacklog: 0, undecidedBacklog: 0, digestVsProduction: { ratio: null } });
    expect(m.units).toHaveLength(3);
    expect(m.units[0]).toMatchObject({ timeToOpenSec: null, timeToDecideSec: null });
  });

  it('derives times, backlog and digest-vs-production from unit_event', () => {
    const db = seed();
    const ev = db.prepare('INSERT INTO unit_event (repo_id, work_unit_id, kind, at, detail) VALUES (1, ?, ?, ?, ?)');
    ev.run(1, 'landed', '2026-09-24T10:03:10Z', '{}'); // first commit 10:01 → 130 s to land
    ev.run(1, 'explained', '2026-09-24T10:13:10Z', '{}');
    ev.run(1, 'opened', '2026-09-24T10:23:10Z', '{}');
    ev.run(1, 'level_viewed', '2026-09-24T10:23:20Z', '{"level":0,"ms":10000}');
    ev.run(1, 'level_viewed', '2026-09-24T10:24:10Z', '{"level":3,"ms":50000}');
    ev.run(1, 'reviewed', '2026-09-24T10:33:10Z', '{}');
    ev.run(1, 'level_viewed', '2026-09-24T10:40:00Z', '{"level":1}'); // after deciding: not counted
    ev.run(1, 'opened', '2026-09-24T11:00:00Z', '{}'); // re-open
    ev.run(2, 'landed', '2026-09-24T10:04:00Z', '{}');
    const m = computeMetrics(db, new Date('2026-09-24T12:00:00Z'));
    const u1 = m.units.find((u) => u.key === 'DIG-1')!;
    expect(u1).toMatchObject({
      timeToLandSec: 130, timeToExplainSec: 600, timeToOpenSec: 1200, timeToDecideSec: 1800,
      decidedBy: 'reviewed', levelsViewedBeforeDeciding: [0, 3], timeAtLevelSec: { 0: 10, 3: 50 }, reopens: 1,
    });
    expect(m.global.unreadBacklog).toBe(1);
    expect(m.global.undecidedBacklog).toBe(1);
    expect(m.global.digestVsProduction).toMatchObject({ landed: 2, decided: 1, ratio: 0.5 });
    expect(m.global.digestVsProduction.perDay.at(-1)).toEqual({ day: '2026-09-24', landed: 2, decided: 1 });
  });
});

async function readUntil(res: Response, pred: (text: string) => boolean, ms = 4000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (!pred(text) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 200))]);
    if (r && !r.done) text += dec.decode(r.value);
    else if (r?.done) break;
  }
  reader.releaseLock();
  return text;
}

describe('sse', () => {
  const listen = async (path: string, live = {}) => {
    const app = make(seed(path), { pollMs: 25, ...live });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as { port: number };
    return { app, url: `http://127.0.0.1:${addr.port}/api/stream` };
  };
  const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'sse-')), 'd.sqlite');

  it('emits changed{unitIds} after another connection writes, plus heartbeats', async () => {
    const path = tmpDb();
    const { url } = await listen(path, { heartbeatMs: 50 });
    const ctrl = new AbortController();
    const res = await fetch(url, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    const writer = openDb(path); // the `digest watch` process, a separate connection
    setTimeout(() => {
      writer.prepare("UPDATE work_unit SET state = 'merged', merged_at = '2026-09-24T11:00:00Z' WHERE id = 2").run();
    }, 100);
    const text = await readUntil(res, (t) => t.includes('event: changed') && t.includes('heartbeat'));
    ctrl.abort();
    expect(text).toContain('event: ready');
    expect(text).toMatch(/event: changed\ndata: {"unitIds":\[2\]}/);
    expect(text).toContain(': heartbeat');
  });

  it('caps concurrent streams and frees a slot on disconnect', async () => {
    const { url } = await listen(tmpDb(), { maxStreams: 1 });
    const a = new AbortController();
    const first = await fetch(url, { signal: a.signal });
    expect(first.status).toBe(200);
    const second = await fetch(url);
    expect(second.status).toBe(503);
    expect(second.headers.get('retry-after')).toBe('5');
    a.abort();
    let status = 503;
    const c = new AbortController();
    for (let i = 0; i < 40 && status !== 200; i++) {
      await new Promise((ok) => setTimeout(ok, 50));
      status = (await fetch(url, { signal: c.signal })).status;
    }
    c.abort();
    expect(status).toBe(200);
  });

  it('does not accept writes on the stream route', async () => {
    expect((await make().inject({ method: 'POST', url: '/api/stream' })).statusCode).toBe(405);
  });
});
