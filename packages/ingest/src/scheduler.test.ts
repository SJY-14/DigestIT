import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { RepoNotAllowedError, StubProvider, type ExplanationProvider, type RangeInput } from '@digestit/explain';
import { ingestRepo } from './ingest.js';
import { ExplainScheduler, pendingBudgetUnitIds, stubCommits } from './scheduler.js';
import { pollOnce } from './watch.js';
import { syncWorkUnits } from './workunits.js';

const MIN = 60_000;
let dir: string;
let clock: Date;
const tick = (ms: number) => { clock = new Date(clock.getTime() + ms); };
const iso = () => clock.toISOString().slice(0, 19) + 'Z';
const g = (...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_COMMITTER_DATE: iso(), GIT_AUTHOR_DATE: iso() },
  }).trim();
const commit = (file: string, msg: string) => {
  writeFileSync(join(dir, file), `${msg} ${Math.random()}\n`);
  g('add', '-A'); g('commit', '-q', '-m', msg);
  return g('rev-parse', 'HEAD');
};
const branch = (name: string, file: string, msg = `work on ${name}`) => {
  g('checkout', '-q', '-b', name); commit(file, msg); g('checkout', '-q', 'main');
};

/** Stub provider that records calls, can fail, and advances the injected clock while "running". */
class Recording implements ExplanationProvider {
  readonly id = 'rec'; readonly model = 'rec-1';
  inner = new StubProvider();
  titles: string[] = [];
  active = 0; maxActive = 0;
  fail = false;
  latencyMs = 0;
  async explain(i: Parameters<StubProvider['explain']>[0]) { return this.inner.explain(i); }
  async explainRange(input: RangeInput) {
    this.titles.push(input.title);
    this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, 2));
    tick(this.latencyMs);
    this.active--;
    if (this.fail) throw new Error('provider down');
    return this.inner.explainRange(input);
  }
}

type Db = ReturnType<typeof openDb>;
let db: Db;
let provider: Recording;
const calls = () => db.prepare('SELECT * FROM explain_call ORDER BY id').all() as any[];
const sync = async () => { await ingestRepo(db, dir, { landedEvents: true }); await syncWorkUnits(db, dir, { now: () => clock }); };
const sched = (o: Partial<ConstructorParameters<typeof ExplainScheduler>[2]> = {}) =>
  new ExplainScheduler(db, provider, { repoPath: dir, now: () => clock, ...o });
const state = (key: string) => (db.prepare('SELECT state FROM work_unit WHERE key = ?').get(key) as any).state as string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'digest-sched-')));
  clock = new Date(2026, 8, 25, 10, 0, 0); // local time, so "midnight" is well defined
  g('init', '-q', '-b', 'main');
  commit('root.txt', 'root');
  db = openDb(':memory:');
  provider = new Recording();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('stub L0 on land', () => {
  it('gives a new commit its subject line as L0 with no provider call and no explain_call row', async () => {
    branch('DIG-1-a', 'a.txt', 'Add the a thing');
    const r = await ingestRepo(db, dir, { landedEvents: true });
    expect(stubCommits(db, r.repoId, r.newCommits)).toBe(r.newCommits.length);
    const row = db.prepare(
      "SELECT e.content, e.status, e.provider FROM explanation e JOIN change_unit cu ON cu.id = e.change_unit_id WHERE cu.title = 'Add the a thing'",
    ).get() as any;
    expect(JSON.parse(row.content)).toEqual({ text: 'Add the a thing' });
    expect(row).toMatchObject({ status: 'pending', provider: 'subject' });
    expect(provider.titles).toEqual([]);
    expect(calls()).toEqual([]);
    expect(stubCommits(db, r.repoId, r.newCommits)).toBe(0); // idempotent
  });

  it('pollOnce stubs new commits and a watch-mode tick never explains per commit', async () => {
    branch('DIG-1-a', 'a.txt');
    await pollOnce(db, dir, { refHash: null });
    const n = (db.prepare("SELECT count(*) AS n FROM explanation WHERE prompt_version = 'stub'").get() as any).n;
    expect(n).toBeGreaterThan(0);
    await syncWorkUnits(db, dir, { now: () => clock });
    await sched().tick(); // unit is active: nothing to do
    expect(provider.titles).toEqual([]);
  });
});

describe('handoff trigger, debounce and re-explain cap', () => {
  it('waits for the quiet period, explains once as a range, then only when the tip moves, at most 3 times', async () => {
    branch('DIG-1-a', 'a.txt');
    const s = sched();
    await sync();
    expect(state('DIG-1')).toBe('active');
    await s.tick();
    expect(provider.titles).toHaveLength(0); // debounce: still active

    tick(14 * MIN); await sync(); await s.tick();
    expect(state('DIG-1')).toBe('active');
    expect(provider.titles).toHaveLength(0);

    tick(2 * MIN); await sync();
    expect(state('DIG-1')).toBe('handoff');
    const res = await s.tick();
    expect(provider.titles).toHaveLength(1);
    expect(res.ran).toEqual([{ key: 'DIG-1', reason: 'handoff', outcome: 'ok' }]);
    const wu = db.prepare('SELECT latest_range_unit_id AS r FROM work_unit WHERE key = ?').get('DIG-1') as any;
    const levels = db.prepare('SELECT level FROM explanation WHERE change_unit_id = ? AND status = ? ORDER BY level').all(wu.r, 'ok') as any[];
    expect(levels.map((l) => l.level)).toEqual([0, 1, 2, 3]);
    expect(db.prepare("SELECT count(*) AS n FROM unit_event WHERE kind = 'explained'").get()).toMatchObject({ n: 1 });

    await s.tick(); await s.tick(); // same tip: no more calls
    expect(provider.titles).toHaveLength(1);

    for (let round = 2; round <= 4; round++) {
      g('checkout', '-q', 'DIG-1-a'); commit(`more${round}.txt`, `more ${round}`); g('checkout', '-q', 'main');
      await sync();
      expect(state('DIG-1')).toBe('active'); // resumed: debounce again
      await s.tick();
      tick(16 * MIN); await sync(); await s.tick();
    }
    // explanations 1, 2 and 3 happened; the 4th tip move is not explained
    expect(provider.titles).toHaveLength(3);
    expect(state('DIG-1')).toBe('handoff');
    expect(calls().every((c) => c.reason === 'handoff' && c.outcome === 'ok')).toBe(true);
  });
});

describe('budget', () => {
  it('leaves units pending (budget) over the cap, logs one budget row, and resets at local midnight', async () => {
    clock = new Date(2026, 8, 25, 23, 0, 0);
    for (const n of [1, 2, 3]) { branch(`DIG-${n}-x`, `f${n}.txt`); tick(MIN); }
    tick(20 * MIN);
    await sync();
    const s = sched({ dailyBudget: 2 });
    const r1 = await s.tick();
    expect(provider.titles).toHaveLength(2);
    expect(r1.pendingBudget).toHaveLength(1);
    await s.tick(); await s.tick(); // no more calls, no more budget rows
    expect(provider.titles).toHaveLength(2);
    expect(calls().map((c) => c.outcome)).toEqual(['ok', 'ok', 'budget']);
    expect(s.callsToday()).toBe(2);
    const pending = pendingBudgetUnitIds(db, clock);
    expect(pending).toHaveLength(1);
    const pendingKey = (db.prepare('SELECT key FROM work_unit WHERE id = ?').get(pending[0]) as any).key;

    tick(2 * 60 * MIN); // 01:20 next local day
    expect(clock.getDate()).toBe(26);
    const r2 = await s.tick();
    expect(r2.ran).toMatchObject([{ key: pendingKey, outcome: 'ok' }]);
    expect(provider.titles).toHaveLength(3);
    expect(pendingBudgetUnitIds(db, clock)).toEqual([]);
  });

  it('counts manual runs toward the budget', async () => {
    branch('DIG-1-a', 'a.txt'); branch('DIG-2-b', 'b.txt');
    await sync();
    const s = sched({ dailyBudget: 1 });
    expect(await s.explainNow('DIG-1')).toEqual({ outcome: 'ok' }); // active unit, on demand
    expect(calls()).toMatchObject([{ reason: 'manual', outcome: 'ok' }]);
    expect(await s.explainNow('DIG-2')).toEqual({ outcome: 'budget' });
    expect(await s.explainNow('DIG-1')).toEqual({ outcome: 'cached' });
    expect(await s.explainNow('DIG-99')).toEqual({ outcome: 'unknown-unit' });
    expect(provider.titles).toHaveLength(1);
  });
});

describe('queue', () => {
  it('runs merged > handoff > rollup > backfill, one at a time, newest first within a priority', async () => {
    branch('DIG-1-old', 'old.txt'); tick(MIN);
    branch('DIG-2-newer', 'newer.txt'); tick(MIN);
    branch('DIG-3-merging', 'merging.txt');
    await sync(); // DIG-3 exists as an unmerged unit before it merges: a live merge, not history
    g('merge', '--no-ff', '-q', '-m', 'Merge DIG-3-merging: ship it', 'DIG-3-merging');
    tick(20 * MIN);
    await sync();
    expect(state('DIG-3')).toBe('merged');
    // Already-merged history that first appears now is a backfill.
    g('checkout', '-q', '-b', 'DIG-4-hist'); commit('hist.txt', 'hist'); g('checkout', '-q', 'main');
    g('merge', '--no-ff', '-q', '-m', 'Merge DIG-4-hist: old', 'DIG-4-hist');
    await sync();

    const order: string[] = [];
    const s = sched();
    s.enqueue({ reason: 'backfill', run: async () => { order.push('extra-backfill'); } });
    s.enqueue({ reason: 'rollup', run: async () => { order.push('extra-rollup'); } });
    const res = await s.tick();
    const seq = res.ran.map((r) => `${r.reason}:${r.key}`);
    expect(seq.slice(0, 3)).toEqual(['merged:DIG-3', 'handoff:DIG-2', 'handoff:DIG-1']);
    expect(seq.indexOf('rollup:rollup')).toBe(3);
    expect(new Set(seq.slice(4))).toEqual(new Set(['backfill:DIG-4', 'backfill:backfill']));
    expect(provider.titles.length).toBe(4);
    expect(order).toEqual(['extra-rollup', 'extra-backfill']);
    expect(provider.maxActive).toBe(1);
  });

  it('serialises concurrent ticks and manual runs (concurrency 1)', async () => {
    for (const n of [1, 2, 3]) branch(`DIG-${n}-x`, `f${n}.txt`);
    tick(20 * MIN); await sync();
    const s = sched();
    await Promise.all([s.tick(), s.tick(), s.explainNow('DIG-2'), s.tick()]);
    expect(provider.maxActive).toBe(1);
    expect(provider.titles).toHaveLength(3);
  });

  it('a rollup extra stays queued while the budget is spent', async () => {
    branch('DIG-1-a', 'a.txt'); tick(20 * MIN); await sync();
    const s = sched({ dailyBudget: 1 });
    let ran = false;
    s.enqueue({ reason: 'rollup', run: async () => { ran = true; } });
    await s.tick(); // the unit takes the only call
    expect(ran).toBe(false);
    tick(24 * 60 * MIN);
    await s.tick();
    expect(ran).toBe(true);
  });
});

describe('explain_call log and errors', () => {
  it('logs time, unit, reason and duration for every provider call', async () => {
    branch('DIG-1-a', 'a.txt'); tick(20 * MIN); await sync();
    provider.latencyMs = 50;
    const at = clock.toISOString();
    await sched().tick();
    const rangeId = (db.prepare('SELECT latest_range_unit_id AS r FROM work_unit').get() as any).r;
    expect(calls()).toEqual([{ id: 1, at, change_unit_id: rangeId, reason: 'handoff', duration_ms: 50, outcome: 'ok' }]);
  });

  it('logs errors, cools down before retrying, and gives up after repeated failures', async () => {
    branch('DIG-1-a', 'a.txt'); tick(20 * MIN); await sync();
    provider.fail = true;
    const s = sched({ retryErrorMs: 30 * MIN });
    await s.tick(); // first + retry call
    expect(calls().map((c) => c.outcome)).toEqual(['error', 'error']);
    expect(db.prepare("SELECT count(*) AS n FROM explanation WHERE prompt_version = 'r1'").get()).toMatchObject({ n: 0 });
    await s.tick();
    expect(calls()).toHaveLength(2); // cooling down
    tick(31 * MIN);
    await s.tick();
    expect(calls()).toHaveLength(4);
    tick(31 * MIN);
    await s.tick();
    expect(calls()).toHaveLength(4); // capped: left alone until the tip moves
    expect(s.callsToday()).toBe(4);
  });

  it('does not log or count an allowlist refusal (no call left the server)', async () => {
    branch('DIG-1-a', 'a.txt'); tick(20 * MIN); await sync();
    provider.explainRange = async () => { throw new RepoNotAllowedError('x'); };
    const errors: unknown[] = [];
    const s = sched({ onError: (e) => errors.push(e) });
    await s.tick();
    expect(errors).toHaveLength(1);
    expect(calls()).toEqual([]);
  });
});
