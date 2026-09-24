import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { ingestRepo } from './ingest.js';
import { createRangeUnit, issueKeyOfBranch, issueKeyOfMerge, syncWorkUnits } from './workunits.js';

let dir: string;
const g = (...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
const commit = (file: string, msg: string) => {
  writeFileSync(join(dir, file), msg + '\n');
  g('add', '-A'); g('commit', '-q', '-m', msg);
  return g('rev-parse', 'HEAD');
};
type Db = ReturnType<typeof openDb>;
const units = (db: Db) =>
  db.prepare('SELECT id, key, kind, state, tip_sha, base_sha FROM work_unit ORDER BY key').all() as any[];
const members = (db: Db, key: string) =>
  (db.prepare('SELECT uc.sha FROM unit_commit uc JOIN work_unit w ON w.id = uc.work_unit_id WHERE w.key = ?').all(key) as any[]).map((r) => r.sha).sort();
const events = (db: Db) =>
  db.prepare("SELECT w.key, e.kind, e.detail FROM unit_event e JOIN work_unit w ON w.id = e.work_unit_id WHERE e.kind != 'landed' ORDER BY e.id").all() as any[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'digest-wu-')));
  g('init', '-q', '-b', 'main');
  commit('root.txt', 'root');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('key parsing', () => {
  it('matches DIG-n branches and Merge DIG-n- subjects only', () => {
    expect(issueKeyOfBranch('DIG-14-work-units')).toBe('DIG-14');
    expect(issueKeyOfBranch('DIG-14')).toBe('DIG-14');
    expect(issueKeyOfBranch('DIG-14x')).toBeNull();
    expect(issueKeyOfBranch('feature/DIG-1-x')).toBeNull();
    expect(issueKeyOfMerge('Merge DIG-13-digest-watch: stuff')).toBe('DIG-13');
    expect(issueKeyOfMerge("Merge branch 'DIG-2-scaffold'")).toBe('DIG-2');
    expect(issueKeyOfMerge('Merge feature-x')).toBeNull();
  });
});

describe('syncWorkUnits', () => {
  it('links two DIG branches, a non-DIG branch, and a merge; drives states with an injected clock', async () => {
    g('checkout', '-q', '-b', 'DIG-1-a');
    const a1 = commit('a1.txt', 'a1'), a2 = commit('a2.txt', 'a2');
    g('checkout', '-q', 'main');
    g('checkout', '-q', '-b', 'DIG-2-b');
    const b1 = commit('b1.txt', 'b1');
    g('checkout', '-q', 'main');
    g('checkout', '-q', '-b', 'experiment');
    const x1 = commit('x1.txt', 'x1');
    g('checkout', '-q', 'main');

    const db = openDb(':memory:');
    await ingestRepo(db, dir, { landedEvents: true });
    const t0 = Date.now();
    let clock = t0;
    const opts = { now: () => new Date(clock), quietMs: 15 * 60_000 };

    const r1 = await syncWorkUnits(db, dir, opts);
    expect(r1.created).toBe(3);
    const u = Object.fromEntries(units(db).map((x) => [x.key, x]));
    expect(u['DIG-1']).toMatchObject({ kind: 'issue', state: 'active', tip_sha: a2 });
    expect(u['DIG-2']).toMatchObject({ kind: 'issue', state: 'active', tip_sha: b1 });
    expect(u['experiment']).toMatchObject({ kind: 'branch', state: 'active', tip_sha: x1 });
    expect(members(db, 'DIG-1')).toEqual([a1, a2].sort());
    expect(members(db, 'DIG-2')).toEqual([b1]);
    expect(members(db, 'experiment')).toEqual([x1]);
    expect(events(db)).toEqual([]);
    // landed events are attributed to their unit
    expect((db.prepare("SELECT COUNT(*) c FROM unit_event WHERE kind='landed' AND work_unit_id IS NOT NULL").get() as any).c).toBe(4);

    // Idempotent while nothing changes.
    expect((await syncWorkUnits(db, dir, opts)).transitions).toEqual([]);

    // Quiet for 16 minutes: everything hands off, one event each.
    clock = t0 + 16 * 60_000;
    const r2 = await syncWorkUnits(db, dir, opts);
    expect(r2.transitions.map((t) => t.to)).toEqual(['handoff', 'handoff', 'handoff']);
    expect(events(db).map((e) => e.kind)).toEqual(['handoff', 'handoff', 'handoff']);
    await syncWorkUnits(db, dir, opts);
    expect(events(db)).toHaveLength(3);

    // A new commit on DIG-2-b resumes it .
    g('checkout', '-q', 'DIG-2-b');
    const b2 = commit('b2.txt', 'b2');
    g('checkout', '-q', 'main');
    await ingestRepo(db, dir, { landedEvents: true });
    clock = Date.now(); // b2 was just committed, so DIG-2 is no longer quiet
    await syncWorkUnits(db, dir, opts);
    expect(units(db).find((x) => x.key === 'DIG-2')).toMatchObject({ state: 'active', tip_sha: b2 });
    // The rewound clock also makes the other quiet units active again; only DIG-2 has a new tip.
    expect(events(db).filter((e) => e.kind === 'resumed').map((e) => e.key)).toContain('DIG-2');

    // No-ff merge of DIG-1-a: unit merges, merge commit joins it, base is frozen at the fork point.
    g('merge', '-q', '--no-ff', '-m', 'Merge DIG-1-a: land a', 'DIG-1-a');
    const mc = g('rev-parse', 'HEAD');
    await ingestRepo(db, dir, { landedEvents: true });
    await syncWorkUnits(db, dir, opts);
    const d1 = units(db).find((x) => x.key === 'DIG-1');
    expect(d1).toMatchObject({ state: 'merged', tip_sha: a2 });
    expect(d1.base_sha).toBe(g('rev-parse', 'HEAD~1')); // fork point == root (main did not move)
    expect(members(db, 'DIG-1')).toEqual([a1, a2, mc].sort());
    expect(events(db).at(-1)).toMatchObject({ key: 'DIG-1', kind: 'merged' });
    expect(JSON.parse(events(db).at(-1).detail)).toMatchObject({ from: 'active', to: 'merged' });

    // Merged is terminal, even after the branch is deleted.
    g('branch', '-q', '-D', 'DIG-1-a');
    const before = events(db).length;
    await syncWorkUnits(db, dir, opts);
    expect(units(db).find((x) => x.key === 'DIG-1')!.state).toBe('merged');
    expect(events(db)).toHaveLength(before);
  });

  it('recovers a merged unit from its merge commit when the branch is already gone', async () => {
    g('checkout', '-q', '-b', 'DIG-7-gone');
    const c1 = commit('c1.txt', 'c1');
    g('checkout', '-q', 'main');
    commit('m.txt', 'main moves');
    g('merge', '-q', '--no-ff', '-m', 'Merge DIG-7-gone', 'DIG-7-gone');
    g('branch', '-q', '-D', 'DIG-7-gone');
    const db = openDb(':memory:');
    await ingestRepo(db, dir);
    await syncWorkUnits(db, dir);
    const u = units(db)[0];
    expect(u).toMatchObject({ key: 'DIG-7', state: 'merged', tip_sha: c1 });
    expect(u.base_sha).toBe(g('rev-parse', 'HEAD^2^'));
    const { changeUnitId } = await createRangeUnit(db, dir, u.id);
    expect((db.prepare('SELECT path FROM file_change WHERE change_unit_id = ?').all(changeUnitId) as any[]).map((r) => r.path)).toEqual(['c1.txt']);
  });

  it('a fast-forward merge keeps sticky membership and freezes the base', async () => {
    g('checkout', '-q', '-b', 'DIG-3-ff');
    const f1 = commit('f1.txt', 'f1');
    const db = openDb(':memory:');
    await ingestRepo(db, dir);
    await syncWorkUnits(db, dir);
    const base = units(db)[0].base_sha;
    expect(base).toBe(g('rev-parse', 'main'));
    g('checkout', '-q', 'main'); g('merge', '-q', '--ff-only', 'DIG-3-ff');
    await ingestRepo(db, dir);
    await syncWorkUnits(db, dir);
    expect(units(db)[0]).toMatchObject({ state: 'merged', base_sha: base, tip_sha: f1 });
    expect(members(db, 'DIG-3')).toEqual([f1]);
  });
});

describe('createRangeUnit', () => {
  it('snapshots merge-base..tip once per tip, immutable and cached', async () => {
    g('checkout', '-q', '-b', 'DIG-5-r');
    commit('a.txt', 'one');
    writeFileSync(join(dir, 'a.txt'), 'one\nmore\n'); g('add', '-A'); g('commit', '-q', '-m', 'two');
    g('checkout', '-q', 'main');
    commit('main-only.txt', 'main moves'); // merge-base must ignore this
    const db = openDb(':memory:');
    await ingestRepo(db, dir);
    await syncWorkUnits(db, dir);
    const wu = units(db)[0];

    const r1 = await createRangeUnit(db, dir, wu.id);
    expect(r1.created).toBe(true);
    const cu = db.prepare('SELECT * FROM change_unit WHERE id = ?').get(r1.changeUnitId) as any;
    expect(cu).toMatchObject({ kind: 'range', head_sha: wu.tip_sha, base_sha: wu.base_sha });
    const files = db.prepare('SELECT path, additions FROM file_change WHERE change_unit_id = ?').all(r1.changeUnitId) as any[];
    expect(files).toEqual([{ path: 'a.txt', additions: 2 }]); // net diff across both commits; no main-only.txt
    expect((db.prepare('SELECT latest_range_unit_id l FROM work_unit WHERE id = ?').get(wu.id) as any).l).toBe(r1.changeUnitId);

    const r2 = await createRangeUnit(db, dir, wu.id);
    expect(r2).toEqual({ changeUnitId: r1.changeUnitId, created: false });

    // New tip -> new snapshot; the old one stays.
    g('checkout', '-q', 'DIG-5-r');
    commit('b.txt', 'three');
    g('checkout', '-q', 'main');
    await ingestRepo(db, dir);
    await syncWorkUnits(db, dir);
    const r3 = await createRangeUnit(db, dir, wu.id);
    expect(r3.created).toBe(true);
    expect(r3.changeUnitId).not.toBe(r1.changeUnitId);
    expect((db.prepare("SELECT COUNT(*) c FROM change_unit WHERE kind='range'").get() as any).c).toBe(2);
  });
});

describe('migration', () => {
  it('keeps existing commit units and events across the change_unit/unit_event rebuild', async () => {
    const db = openDb(':memory:');
    await ingestRepo(db, dir, { landedEvents: true });
    expect((db.prepare('SELECT COUNT(*) c FROM change_unit').get() as any).c).toBe(1);
    expect(() => db.prepare("INSERT INTO change_unit (repo_id, kind, head_sha, title) VALUES (1, 'bogus', 'x', 't')").run()).toThrow();
  });
});
