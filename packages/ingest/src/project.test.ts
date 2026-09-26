import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { createProvider, type ExplanationProvider } from '@digestit/explain';
import {
  ProjectLockedError, budgetStatus, explainProject, findProject, initProject, latestCheckpoint,
  listProjects, projectStatus, retryDigest, type ProjectRow,
} from './project.js';
import type { DatabaseSync } from 'node:sqlite';

let root: string;
let proj: string;
let home: string;
let db: DatabaseSync;

const write = (name: string, content: string) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};

const provider = (name: string): ExplanationProvider => createProvider({ provider: 'stub', repoAllowlist: [name] });

/** Recursive, sorted relative file listing (dirs excluded), for "never writes inside the project" checks. */
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'digest-project-'));
  proj = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(proj, { recursive: true });
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('initProject', () => {
  it('registers a project, takes checkpoint #1, and reports what will be tracked', async () => {
    write('a.txt', 'hello\n');
    write('sub/b.txt', 'world\n');
    const r = await initProject(db, home, proj);
    expect(r.created).toBe(true);
    expect(r.tracked).toBe(2);
    expect(r.skipped).toEqual([]);
    expect(r.dataDir.startsWith(home)).toBe(true);
    expect(r.dataDir.startsWith(proj)).toBe(false);

    const cp = latestCheckpoint(db, r.repoId)!;
    expect(cp.seq).toBe(1);
    expect(cp.reason).toBe('init');
    expect(cp.shadowSha).toBe(cp.treeSha);
  });

  it('is a no-op that reports the existing project when re-run on the same path', async () => {
    write('a.txt', 'hello\n');
    const first = await initProject(db, home, proj);
    const again = await initProject(db, home, proj);
    expect(again.created).toBe(false);
    expect(again.repoId).toBe(first.repoId);
    expect(listProjects(db)).toHaveLength(1);
    expect(latestCheckpoint(db, first.repoId)!.seq).toBe(1); // no second checkpoint taken
  });

  it('never writes into the project directory', async () => {
    write('a.txt', 'hello\n');
    const before = listFiles(proj);
    await initProject(db, home, proj);
    expect(listFiles(proj)).toEqual(before);
  });

  it('rejects a missing --context file', async () => {
    write('a.txt', 'hello\n');
    await expect(initProject(db, home, proj, { contextPath: join(root, 'nope.md') })).rejects.toThrow(/context file not found/);
  });
});

describe('digest explain: init -> edit -> explain -> digest', () => {
  it('records a checkpoint, a digest change unit with the right files/stats, and an ok explanation', async () => {
    write('a.txt', 'one\n');
    const init = await initProject(db, home, proj);
    write('a.txt', 'one\ntwo\n');
    write('b.txt', 'new file\n');

    const project = findProject(db, String(init.repoId)) as ProjectRow;
    const r = await explainProject(db, home, project, provider(project.name), { budget: 40 });
    expect(r.noChanges).toBe(false);
    expect(r.outcome).toBe('ok');
    expect(r.calls).toBe(1);

    const digest = db.prepare('SELECT * FROM digest WHERE change_unit_id = ?').get(r.digestId) as { stats: string; from_checkpoint_id: number; to_checkpoint_id: number };
    const stats = JSON.parse(digest.stats);
    expect(stats).toEqual({ files: 2, additions: 2, deletions: 0 });
    const files = (db.prepare('SELECT path FROM file_change WHERE change_unit_id = ? ORDER BY path').all(r.digestId!) as { path: string }[]).map((f) => f.path);
    expect(files).toEqual(['a.txt', 'b.txt']);

    const cp = latestCheckpoint(db, project.id)!;
    expect(cp.seq).toBe(2);
    expect(cp.reason).toBe('explain');
    expect(digest.to_checkpoint_id).toBe(cp.id);

    const l0 = db.prepare("SELECT status FROM explanation WHERE change_unit_id = ? AND level = 0").get(r.digestId!) as { status: string };
    expect(l0.status).toBe('ok');
  });

  it('never writes into the project directory across init and explain', async () => {
    write('a.txt', 'one\n');
    const init = await initProject(db, home, proj);
    write('a.txt', 'one\ntwo\n');
    const before = listFiles(proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    await explainProject(db, home, project, provider(project.name), { budget: 40 });
    write('a.txt', 'one\ntwo\nthree\n'); // re-check after a second explain too
    await explainProject(db, home, project, provider(project.name), { budget: 40 });
    expect(listFiles(proj)).toEqual([...before].sort());
  });

  it('unchanged tree: no checkpoint, no change unit, no call', async () => {
    write('a.txt', 'one\n');
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    const r = await explainProject(db, home, project, provider(project.name), { budget: 40 });
    expect(r).toEqual({ noChanges: true, digestId: null, outcome: null, calls: 0 });
    expect(latestCheckpoint(db, project.id)!.seq).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM change_unit WHERE kind = 'digest'").get()).toEqual({ n: 0 });
  });

  it('budget 0: digest stays pending, no provider call, then retry works', async () => {
    write('a.txt', 'one\n');
    const init = await initProject(db, home, proj);
    write('a.txt', 'one\ntwo\n');
    const project = findProject(db, String(init.repoId)) as ProjectRow;

    const r = await explainProject(db, home, project, provider(project.name), { budget: 0 });
    expect(r.noChanges).toBe(false);
    expect(r.outcome).toBe('budget');
    expect(r.calls).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM explanation WHERE change_unit_id = ?').get(r.digestId!)).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM explain_call WHERE reason = 'digest' AND outcome = 'ok'").get()).toEqual({ n: 0 });

    const retry = await retryDigest(db, home, r.digestId!, provider(project.name), { budget: 40 });
    expect(retry.outcome).toBe('ok');
    expect(db.prepare('SELECT status FROM explanation WHERE change_unit_id = ? AND level = 0').get(r.digestId!)).toEqual({ status: 'ok' });
  });

  it('serializes two concurrent explains for the same project: one wins, the other is locked', async () => {
    write('a.txt', 'one\n');
    const init = await initProject(db, home, proj);
    write('a.txt', 'one\ntwo\n');
    const project = findProject(db, String(init.repoId)) as ProjectRow;

    const [a, b] = await Promise.allSettled([
      explainProject(db, home, project, provider(project.name), { budget: 40 }),
      explainProject(db, home, project, provider(project.name), { budget: 40 }),
    ]);
    const results = [a, b];
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(ProjectLockedError);
    // Only one checkpoint/digest was created for the one tree change, not two.
    expect(latestCheckpoint(db, project.id)!.seq).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM change_unit WHERE kind = 'digest'").get()).toEqual({ n: 1 });
  });
});

describe('projectStatus / budgetStatus', () => {
  it('reports pending changes and the remaining budget with no LLM call', async () => {
    write('a.txt', 'one\n');
    const init = await initProject(db, home, proj);
    write('a.txt', 'one\ntwo\n');
    write('b.txt', 'x\n');
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    const s = await projectStatus(db, home, project);
    expect(s.pending.files).toBe(2);
    expect(s.pending.additions).toBeGreaterThan(0);
    expect(s.explaining).toBe(false);
    expect(s.budget).toEqual(budgetStatus(db));
    expect(db.prepare("SELECT count(*) AS n FROM change_unit").get()).toEqual({ n: 0 }); // status never writes
  });

  it('findProject resolves by numeric id, by name, and falls back to the sole project', async () => {
    write('a.txt', 'one\n');
    const init = await initProject(db, home, proj, { name: 'myproj' });
    expect((findProject(db, 'myproj') as ProjectRow).id).toBe(init.repoId);
    expect((findProject(db, String(init.repoId)) as ProjectRow).id).toBe(init.repoId);
    expect((findProject(db) as ProjectRow).id).toBe(init.repoId);
    expect(findProject(db, 'nope')).toEqual({ error: 'no project "nope"' });
  });
});

describe('data dir permissions', () => {
  it('creates the project data dir 0700', async () => {
    write('a.txt', 'one\n');
    const r = await initProject(db, home, proj);
    expect(statSync(r.dataDir).mode & 0o777).toBe(0o700);
    chmodSync(r.dataDir, 0o700); // no-op; keeps the assertion meaningful even if umask ever changes
  });
});
