import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@digestit/core';
import { StubProvider, type RollupInput } from '@digestit/explain';
import { ExplainScheduler } from './scheduler.js';
import { RollupPlanner } from './rollup.js';

const H = 3_600_000;
let dir: string;
let clock: Date;
let db: ReturnType<typeof openDb>;
let rollupInputs: RollupInput[];
const provider = () => {
  const p = new StubProvider();
  const inner = p.rollup.bind(p);
  p.rollup = async (i: RollupInput) => { rollupInputs.push(i); return inner(i); };
  return p;
};
const iso = (d = clock) => d.toISOString();
const sched = (dailyBudget?: number) => new ExplainScheduler(db, provider(), { repoPath: dir, now: () => clock, dailyBudget });
const planner = (s: ExplainScheduler) => new RollupPlanner(db, s, dir, { now: () => clock });
const move = (unit: number, kind = 'landed', at = clock) =>
  db.prepare('INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (1, ?, ?, ?)').run(unit, kind, iso(at));
const rollups = () => db.prepare('SELECT * FROM rollup').all() as any[];
const calls = () => db.prepare('SELECT reason, outcome FROM explain_call').all() as any[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'digest-rollup-')));
  clock = new Date(Date.UTC(2026, 8, 25, 12, 0, 0));
  rollupInputs = [];
  db = openDb(':memory:');
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'r', ?)").run(dir);
  for (const [id, key, title] of [[1, 'DIG-1', 'First'], [2, 'DIG-2', 'Second'], [3, 'DIG-3', 'Third']] as const) {
    db.prepare(
      `INSERT INTO work_unit (id, repo_id, key, kind, title, state, tip_sha, first_commit_at, last_commit_at)
       VALUES (?, 1, ?, 'issue', ?, 'active', 'x', ?, ?)`,
    ).run(id, key, title, iso(), iso());
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('roll-up job', () => {
  it('needs at least 2 moved units in the window', async () => {
    const s = sched(); const p = planner(s);
    move(1);
    expect(p.maybeEnqueue()).toBe(false);
    move(1, 'explained'); // same unit twice is still one unit
    expect(p.maybeEnqueue()).toBe(false);
    move(2, 'handoff');
    move(3, 'opened'); // viewer events do not count
    expect(p.maybeEnqueue()).toBe(true);
    await s.tick();
    const [r] = rollups();
    expect(rollups()).toHaveLength(1);
    expect(JSON.parse(r.work_unit_ids)).toEqual([1, 2]);
    expect(JSON.parse(r.content).l0.text).toContain('2 unit');
    expect(r.window_end).toBe(iso());
    expect(calls()).toEqual([{ reason: 'rollup', outcome: 'ok' }]);
    // text only: the input carries unit summaries and no file/diff fields
    expect(rollupInputs[0]!.units.map((u) => u.key)).toEqual(['DIG-1', 'DIG-2']);
    expect(JSON.stringify(rollupInputs[0])).not.toContain('patch');
  });

  it('ignores events older than the window', () => {
    const s = sched(); const p = planner(s);
    move(1, 'landed', new Date(clock.getTime() - 2 * H)); move(2, 'landed', new Date(clock.getTime() - 2 * H));
    expect(p.maybeEnqueue()).toBe(false);
  });

  it('runs at most once per hour', async () => {
    const s = sched(); const p = planner(s);
    move(1); move(2);
    expect(p.maybeEnqueue()).toBe(true);
    await s.tick();
    clock = new Date(clock.getTime() + 30 * 60_000);
    move(1, 'explained'); move(2, 'merged');
    expect(p.maybeEnqueue()).toBe(false);
    clock = new Date(clock.getTime() + 31 * 60_000);
    move(3, 'landed');
    expect(p.maybeEnqueue()).toBe(true);
    await s.tick();
    expect(rollups()).toHaveLength(2);
    // a fresh planner (restart) also honours the stored roll-up
    expect(planner(s).maybeEnqueue()).toBe(false);
  });

  it('stays queued over budget and runs once budget is available, without duplicates', async () => {
    const s = sched(1);
    db.prepare("INSERT INTO explain_call (at, reason, outcome) VALUES (?, 'manual', 'ok')").run(iso());
    const p = planner(s);
    move(1); move(2);
    expect(p.maybeEnqueue()).toBe(true);
    await s.tick(); await s.tick();
    expect(rollups()).toHaveLength(0);
    expect(rollupInputs).toHaveLength(0);
    expect(p.maybeEnqueue()).toBe(false); // still queued: no second job
    clock = new Date(clock.getTime() + 13 * H); // next local day at the latest
    clock = new Date(clock.getTime() + 24 * H);
    await s.tick();
    expect(rollups()).toHaveLength(1);
    expect(calls().filter((c) => c.reason === 'rollup')).toEqual([{ reason: 'rollup', outcome: 'ok' }]);
  });
});
