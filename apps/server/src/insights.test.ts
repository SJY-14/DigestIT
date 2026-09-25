import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@digestit/core';
import { describe, expect, it } from 'vitest';
import { computeAreas, computeDigest, computeDrill } from './insights.js';

function workspaceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'digestit-fixture-'));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  return dir;
}

// --- computeAreas: bucketing (T4-b), acceptance criteria --------------------------------------

describe('computeAreas', () => {
  function makeDb() {
    const db = openDb(':memory:');
    const repoId = Number(db.prepare('INSERT INTO repo (name, path) VALUES (?, ?)').run('r', workspaceRepo()).lastInsertRowid);

    const commit = (sha: string, at: string, isMerge = 0) =>
      db.prepare(
        `INSERT INTO commit_ (sha, repo_id, parents, author_name, authored_at, committed_at, message, is_merge)
         VALUES (?, ?, '[]', 'a', ?, ?, 'm', ?)`,
      ).run(sha, repoId, at, at, isMerge);
    const changeUnit = (id: number, kind: 'commit' | 'range', headSha: string) =>
      db.prepare("INSERT INTO change_unit (id, repo_id, kind, head_sha, title) VALUES (?, ?, ?, ?, 't')")
        .run(id, repoId, kind, headSha);
    const file = (changeUnitId: number, path: string, oldPath: string | null, status: string, add: number, del: number, filtered: string | null = null) =>
      db.prepare('INSERT INTO file_change (change_unit_id, path, old_path, status, additions, deletions, filtered_reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(changeUnitId, path, oldPath, status, add, del, filtered);
    const workUnit = (id: number, key: string) =>
      db.prepare(
        `INSERT INTO work_unit (id, repo_id, key, kind, title, state, tip_sha, first_commit_at, last_commit_at)
         VALUES (?, ?, ?, 'issue', ?, 'active', 'x', '2026-09-01', '2026-09-02')`,
      ).run(id, repoId, key, key);
    const member = (workUnitId: number, sha: string) =>
      db.prepare('INSERT INTO unit_commit (work_unit_id, sha) VALUES (?, ?)').run(workUnitId, sha);
    const event = (workUnitId: number, kind: string, at: string, detail = '{}') =>
      db.prepare('INSERT INTO unit_event (repo_id, work_unit_id, kind, at, detail) VALUES (?, ?, ?, ?, ?)')
        .run(repoId, workUnitId, kind, at, detail);

    // c1 + c2 (rename) -> DIG-300, attention "deep" (opened + L3 >= 10s, no reviewed).
    commit('c1', '2026-09-01T10:00:00Z');
    changeUnit(1, 'commit', 'c1');
    file(1, 'apps/web/src/a.ts', null, 'M', 10, 2);
    file(1, 'packages/core/src/b.ts', null, 'A', 5, 0);
    commit('c2', '2026-09-01T11:00:00Z');
    changeUnit(2, 'commit', 'c2');
    file(2, 'apps/web/src/renamed.ts', 'apps/web/src/old.ts', 'R', 3, 1);
    workUnit(300, 'DIG-300');
    member(300, 'c1'); member(300, 'c2');
    event(300, 'opened', '2026-09-01T12:00:00Z');
    event(300, 'level_viewed', '2026-09-01T12:05:00Z', JSON.stringify({ level: 3, ms: 15000 }));

    // c3 (filtered) + c4 (docs, non-workspace top-level) -> DIG-301, attention "notOpened".
    commit('c3', '2026-09-02T09:00:00Z');
    changeUnit(3, 'commit', 'c3');
    file(3, 'apps/web/src/generated.ts', null, 'M', 100, 50, 'generated');
    commit('c4', '2026-09-02T09:30:00Z');
    changeUnit(4, 'commit', 'c4');
    file(4, 'docs/readme.md', null, 'M', 4, 1);
    workUnit(301, 'DIG-301');
    member(301, 'c3'); member(301, 'c4');

    // c5: a merge commit whose (first-parent) diff would otherwise double-count c1's file.
    commit('c5', '2026-09-02T10:00:00Z', 1);
    changeUnit(5, 'commit', 'c5');
    file(5, 'apps/web/src/a.ts', null, 'M', 999, 999);

    // A 'range' snapshot over the same file: must not be double-counted alongside the commit rows.
    changeUnit(6, 'range', 'c1');
    file(6, 'apps/web/src/a.ts', null, 'M', 500, 500);

    return { db, now: new Date('2026-09-03T00:00:00Z') };
  }

  it('buckets workspace packages as <prefix>/<name>, renames under the new path', () => {
    const { db, now } = makeDb();
    const res = computeAreas(db, { window: '7d', now });
    const web = res.areas.find((a) => a.area === 'apps/web')!;
    // c1 (12) + c2 rename (4) = 16; filtered c3 (150) and the merge/range rows are excluded by default.
    expect(web.totalLines).toBe(16);
    const core = res.areas.find((a) => a.area === 'packages/core')!;
    expect(core.totalLines).toBe(5);
  });

  it('excludes filtered files by default and includes them with includeFiltered', () => {
    const { db, now } = makeDb();
    const without = computeAreas(db, { window: '7d', now });
    expect(without.areas.find((a) => a.area === 'apps/web')!.totalLines).toBe(16);
    const withFiltered = computeAreas(db, { window: '7d', now, includeFiltered: true });
    expect(withFiltered.areas.find((a) => a.area === 'apps/web')!.totalLines).toBe(16 + 150);
  });

  it('does not double-count a merge commit or a range snapshot over the same file', () => {
    const { db, now } = makeDb();
    const res = computeAreas(db, { window: '7d', now, includeFiltered: true });
    // If the merge (999+999) or the range snapshot (500+500) leaked in, this would be far higher.
    expect(res.areas.find((a) => a.area === 'apps/web')!.totalLines).toBe(16 + 150);
  });

  it('buckets a non-workspace top-level dir as itself', () => {
    const { db, now } = makeDb();
    const res = computeAreas(db, { window: '7d', now });
    const docs = res.areas.find((a) => a.area === 'docs')!;
    expect(docs.totalLines).toBe(5);
  });

  it('splits lines by attention at unit granularity (T5-b)', () => {
    const { db, now } = makeDb();
    const res = computeAreas(db, { window: '7d', now });
    const web = res.areas.find((a) => a.area === 'apps/web')!;
    expect(web.blindSpot).toEqual({ reviewed: 0, deep: 16, opened: 0, notOpened: 0 });
    const docs = res.areas.find((a) => a.area === 'docs')!;
    expect(docs.blindSpot).toEqual({ reviewed: 0, deep: 0, opened: 0, notOpened: 5 });
  });

  it('root= expands one level under the given area', () => {
    const { db, now } = makeDb();
    const res = computeAreas(db, { window: '7d', now, root: 'apps/web' });
    const sub = res.areas.find((a) => a.area === 'apps/web/src')!;
    expect(sub.totalLines).toBe(16);
    expect(res.areas.every((a) => a.area.startsWith('apps/web'))).toBe(true);
  });

  it('buckets 90d windows by ISO week', () => {
    const { db } = makeDb();
    const res = computeAreas(db, { window: '90d', now: new Date('2026-09-03T00:00:00Z') });
    expect(res.bucketKind).toBe('week');
    // 2026-09-01 is a Tuesday; its ISO week starts Monday 2026-08-31.
    expect(res.buckets).toContain('2026-08-31');
  });
});

// --- computeDigest: backlog reconstruction + percentiles, hand-computed -----------------------

describe('computeDigest', () => {
  function makeDb() {
    const db = openDb(':memory:');
    const repoId = Number(db.prepare('INSERT INTO repo (name, path) VALUES (?, ?)').run('r', '/tmp/x').lastInsertRowid);
    const workUnit = (id: number, key: string) =>
      db.prepare(
        `INSERT INTO work_unit (id, repo_id, key, kind, title, state, tip_sha, first_commit_at, last_commit_at)
         VALUES (?, ?, ?, 'issue', ?, 'active', 'x', '2026-09-01', '2026-09-01')`,
      ).run(id, repoId, key, key);
    const event = (workUnitId: number, kind: string, at: string, detail = '{}') =>
      db.prepare('INSERT INTO unit_event (repo_id, work_unit_id, kind, at, detail) VALUES (?, ?, ?, ?, ?)')
        .run(repoId, workUnitId, kind, at, detail);

    // U4: landed and fully resolved the day before the window starts (tests full-history backlog).
    workUnit(4, 'DIG-4');
    event(4, 'landed', '2026-09-01T00:00:00Z');
    event(4, 'opened', '2026-09-01T01:00:00Z');
    event(4, 'reviewed', '2026-09-01T02:00:00Z');

    // U1: landed day 1 of the window, opened same day, reviewed day 2.
    workUnit(1, 'DIG-1');
    event(1, 'landed', '2026-09-02T10:00:00Z');
    event(1, 'opened', '2026-09-02T12:00:00Z');
    event(1, 'level_viewed', '2026-09-02T13:00:00Z', JSON.stringify({ level: 1 }));
    event(1, 'reviewed', '2026-09-03T10:00:00Z');

    // U2: landed day 2, opened same day, merged (decided) same day.
    workUnit(2, 'DIG-2');
    event(2, 'landed', '2026-09-03T00:00:00Z');
    event(2, 'opened', '2026-09-03T06:00:00Z');
    event(2, 'level_viewed', '2026-09-03T07:00:00Z', JSON.stringify({ level: 2 }));
    event(2, 'merged', '2026-09-03T12:00:00Z');

    // U3: landed day 4, never opened or decided (stays in backlog through the window).
    workUnit(3, 'DIG-3');
    event(3, 'landed', '2026-09-05T00:00:00Z');

    db.prepare('INSERT INTO explain_call (at, reason, duration_ms, outcome) VALUES (?, ?, ?, ?)')
      .run('2026-09-02T05:00:00Z', 'merged', 1000, 'ok');
    db.prepare('INSERT INTO explain_call (at, reason, duration_ms, outcome) VALUES (?, ?, ?, ?)')
      .run('2026-09-02T06:00:00Z', 'handoff', 1000, 'ok');
    db.prepare('INSERT INTO explain_call (at, reason, duration_ms, outcome) VALUES (?, ?, ?, ?)')
      .run('2026-09-03T05:00:00Z', 'rollup', 1000, 'ok');
    db.prepare('INSERT INTO explain_call (at, reason, duration_ms, outcome) VALUES (?, ?, ?, ?)')
      .run('2026-09-03T23:59:00Z', 'rollup', 0, 'budget');

    return db;
  }

  it('reconstructs landed/decided per day from unit_event', () => {
    const db = makeDb();
    const res = computeDigest(db, { window: '7d', now: new Date('2026-09-08T00:00:00Z') });
    const byDay = Object.fromEntries(res.perDay.map((d) => [d.day, d]));
    expect(byDay['2026-09-02']).toEqual({ day: '2026-09-02', landed: 1, decided: 0 });
    expect(byDay['2026-09-03']).toEqual({ day: '2026-09-03', landed: 1, decided: 2 });
    expect(byDay['2026-09-05']).toEqual({ day: '2026-09-05', landed: 1, decided: 0 });
  });

  it('rebuilds unread/undecided backlog per end of day from full history, not window-scoped', () => {
    const db = makeDb();
    const res = computeDigest(db, { window: '7d', now: new Date('2026-09-08T00:00:00Z') });
    const byDay = Object.fromEntries(res.backlog.map((d) => [d.day, d]));
    expect(byDay['2026-09-02']).toEqual({ day: '2026-09-02', unread: 0, undecided: 1 }); // U1 landed+opened, undecided
    expect(byDay['2026-09-03']).toEqual({ day: '2026-09-03', unread: 0, undecided: 0 }); // U1+U2 resolved
    expect(byDay['2026-09-05']).toEqual({ day: '2026-09-05', unread: 1, undecided: 1 }); // U3 lands, untouched
    expect(byDay['2026-09-08']).toEqual({ day: '2026-09-08', unread: 1, undecided: 1 }); // still outstanding
  });

  it('computes p50/p90 land->open and land->decide for the window, hand-computed', () => {
    const db = makeDb();
    const res = computeDigest(db, { window: '7d', now: new Date('2026-09-08T00:00:00Z') });
    // U1: open 2h=7200s, decide 24h=86400s. U2: open 6h=21600s, decide 12h=43200s.
    expect(res.latency.current).toEqual({
      landToOpenP50: 7200, landToOpenP90: 21600,
      landToDecideP50: 43200, landToDecideP90: 86400,
      n: 2,
    });
  });

  it('computes the previous window from full history for comparison', () => {
    const db = makeDb();
    const res = computeDigest(db, { window: '7d', now: new Date('2026-09-08T00:00:00Z') });
    // U4 landed the day before the window (previous window), open 1h=3600s, decide 2h=7200s.
    expect(res.latency.previous).toEqual({
      landToOpenP50: 3600, landToOpenP90: 3600,
      landToDecideP50: 7200, landToDecideP90: 7200,
      n: 1,
    });
  });

  it('reports the deepest level reached before deciding', () => {
    const db = makeDb();
    const res = computeDigest(db, { window: '7d', now: new Date('2026-09-08T00:00:00Z') });
    expect(res.deepestLevelDistribution).toEqual({ '0': 0, '1': 1, '2': 1, '3': 0, none: 0 });
  });

  it('buckets explain_call per day by reason, and flags days that hit the budget', () => {
    const db = makeDb();
    const res = computeDigest(db, { window: '7d', now: new Date('2026-09-08T00:00:00Z') });
    const byDay = Object.fromEntries(res.explainCalls.map((d) => [d.day, d]));
    expect(byDay['2026-09-02']).toMatchObject({ total: 2, hitBudget: false, cap: 40 });
    expect(byDay['2026-09-02']!.reasons).toMatchObject({ merged: 1, handoff: 1 });
    expect(byDay['2026-09-03']).toMatchObject({ total: 1, hitBudget: true });
    expect(byDay['2026-09-03']!.reasons).toMatchObject({ rollup: 1 });
  });
});

// --- computeDrill: the five drill modes --------------------------------------------------------

describe('computeDrill', () => {
  function makeDb() {
    const db = openDb(':memory:');
    const repoId = Number(db.prepare('INSERT INTO repo (name, path) VALUES (?, ?)').run('r', workspaceRepo()).lastInsertRowid);
    db.prepare("INSERT INTO commit_ (sha, repo_id, parents, author_name, authored_at, committed_at, message) VALUES ('c1', ?, '[]', 'a', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', 'm')").run(repoId);
    db.prepare("INSERT INTO change_unit (id, repo_id, kind, head_sha, title) VALUES (1, ?, 'commit', 'c1', 't')").run(repoId);
    db.prepare("INSERT INTO file_change (change_unit_id, path, status, additions, deletions) VALUES (1, 'apps/web/src/a.ts', 'M', 10, 0)").run();
    db.prepare(
      `INSERT INTO work_unit (id, repo_id, key, kind, title, state, tip_sha, first_commit_at, last_commit_at)
       VALUES (10, ?, 'DIG-10', 'issue', 'w1', 'active', 'c1', '2026-09-01', '2026-09-01')`,
    ).run(repoId);
    db.prepare("INSERT INTO unit_commit (work_unit_id, sha) VALUES (10, 'c1')").run();
    db.prepare("INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (?, 10, 'landed', '2026-09-01T10:00:00Z')").run(repoId);
    db.prepare("INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (?, 10, 'opened', '2026-09-01T11:00:00Z')").run(repoId);

    db.prepare(
      `INSERT INTO work_unit (id, repo_id, key, kind, title, state, tip_sha, first_commit_at, last_commit_at)
       VALUES (11, ?, 'DIG-11', 'issue', 'w2', 'active', 'c2', '2026-09-01', '2026-09-01')`,
    ).run(repoId);
    db.prepare("INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (?, 11, 'landed', '2026-09-01T09:00:00Z')").run(repoId);
    return db;
  }

  it('area+day: returns the units that touched that area on that day', () => {
    const db = makeDb();
    const res = computeDrill(db, { area: 'apps/web', day: '2026-09-01' });
    expect(res.workUnits.map((u: { key: string }) => u.key)).toEqual(['DIG-10']);
  });

  it('area(+window): returns the units that touched that area within the window', () => {
    const db = makeDb();
    const res = computeDrill(db, { area: 'apps/web', window: '7d', now: new Date('2026-09-03T00:00:00Z') });
    expect(res.workUnits.map((u: { key: string }) => u.key)).toEqual(['DIG-10']);
  });

  it('day+metric: unreadBacklog lists units landed but not opened by end of day', () => {
    const db = makeDb();
    const res = computeDrill(db, { day: '2026-09-01', metric: 'unreadBacklog', now: new Date('2026-09-01T23:00:00Z') });
    expect(res.workUnits.map((u: { key: string }) => u.key)).toEqual(['DIG-11']);
  });

  it('week+bucket: lists units landed that week classified into the attention bucket', () => {
    const db = makeDb();
    const res = computeDrill(db, { week: '2026-08-31', bucket: 'opened' });
    expect(res.workUnits.map((u: { key: string }) => u.key)).toEqual(['DIG-10']);
  });

  it('ids: direct lookup', () => {
    const db = makeDb();
    const res = computeDrill(db, { ids: [11] });
    expect(res.workUnits.map((u: { key: string }) => u.key)).toEqual(['DIG-11']);
  });
});
