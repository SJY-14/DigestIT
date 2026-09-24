import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { ingestRepo } from './ingest.js';
import { splitPatch } from './git.js';

let dir: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
  }).trim();
const write = (name: string, content: string | Buffer) => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), content);
};
const commit = (msg: string) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'digest-ingest-'));
  git('init', '-q', '-b', 'main');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const count = (db: ReturnType<typeof openDb>, t: string) =>
  (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;

describe('ingestRepo', () => {
  it('stores root commit with stats and patch, and is idempotent/incremental', async () => {
    write('a.txt', 'one\ntwo\n');
    const root = commit('root\n\nbody line');
    const db = openDb(':memory:');
    const r1 = await ingestRepo(db, dir);
    expect(r1.commitsAdded).toBe(1);
    const c = db.prepare('SELECT * FROM commit_ WHERE sha = ?').get(root) as any;
    expect(JSON.parse(c.parents)).toEqual([]);
    expect(c.message).toBe('root\n\nbody line');
    expect(JSON.parse(c.branch_refs)).toEqual(['main']);
    expect(JSON.parse(c.stats)).toEqual({ files: 1, additions: 2, deletions: 0 });
    const f = db.prepare('SELECT * FROM file_change').get() as any;
    expect(f).toMatchObject({ path: 'a.txt', status: 'A', additions: 2, old_path: null });
    expect(f.patch).toContain('+one');
    expect((db.prepare('SELECT head_sha FROM repo').get() as any).head_sha).toBe(root);

    const r2 = await ingestRepo(db, dir);
    expect(r2).toMatchObject({ commitsAdded: 0, fileChangesAdded: 0, refsUpdated: 0 });

    write('a.txt', 'one\nTWO\n');
    commit('second');
    const r3 = await ingestRepo(db, dir);
    expect(r3.commitsAdded).toBe(1);
    expect(count(db, 'commit_')).toBe(2);
    expect(count(db, 'change_unit')).toBe(2);
  });

  it('handles renames, binary files, deletes and empty commits', async () => {
    write('old.txt', 'line1\nline2\nline3\nline4\nline5\n');
    write('gone.txt', 'x\n');
    commit('base');
    renameSync(join(dir, 'old.txt'), join(dir, 'new name.txt'));
    write('img.bin', Buffer.from([0, 1, 2, 0, 255, 0]));
    git('rm', '-q', 'gone.txt');
    commit('rename+binary+delete');
    git('commit', '-q', '--allow-empty', '-m', 'empty');

    const db = openDb(':memory:');
    await ingestRepo(db, dir);
    const rows = db.prepare(
      `SELECT c.message m, f.* FROM file_change f JOIN change_unit u ON u.id = f.change_unit_id
       JOIN commit_ c ON c.sha = u.head_sha ORDER BY f.path`,
    ).all() as any[];
    const of = (m: string, p: string) => rows.find((r) => r.m === m && r.path === p);
    expect(of('rename+binary+delete', 'new name.txt')).toMatchObject({ status: 'R', old_path: 'old.txt', additions: 0 });
    expect(of('rename+binary+delete', 'img.bin')).toMatchObject({ status: 'B', patch: null, filtered_reason: 'binary' });
    expect(of('rename+binary+delete', 'gone.txt')).toMatchObject({ status: 'D', deletions: 1 });
    const empty = db.prepare("SELECT stats FROM commit_ WHERE message = 'empty'").get() as any;
    expect(JSON.parse(empty.stats)).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(count(db, 'change_unit')).toBe(3);
  });

  it('diffs merge commits against the first parent and records refs on all branches', async () => {
    write('base.txt', 'b\n');
    commit('base');
    git('checkout', '-q', '-b', 'feature');
    write('feat.txt', 'f\n');
    const featSha = commit('feature work');
    git('checkout', '-q', 'main');
    write('main.txt', 'm\n');
    commit('main work');
    git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    const mergeSha = git('rev-parse', 'HEAD');

    const db = openDb(':memory:');
    const r = await ingestRepo(db, dir);
    expect(r.commitsAdded).toBe(4);
    const m = db.prepare('SELECT * FROM commit_ WHERE sha = ?').get(mergeSha) as any;
    expect(m.is_merge).toBe(1);
    expect(JSON.parse(m.parents)).toHaveLength(2);
    const files = db.prepare(
      'SELECT path FROM file_change f JOIN change_unit u ON u.id = f.change_unit_id WHERE u.head_sha = ?',
    ).all(mergeSha) as any[];
    expect(files.map((f) => f.path)).toEqual(['feat.txt']);
    const feat = db.prepare('SELECT branch_refs FROM commit_ WHERE sha = ?').get(featSha) as any;
    expect(JSON.parse(feat.branch_refs)).toEqual(['feature', 'main']);

    // A commit only on a non-checked-out branch is still ingested; refs refresh without new rows.
    git('checkout', '-q', 'feature');
    write('more.txt', 'x\n');
    const moreSha = commit('feature only');
    git('checkout', '-q', 'main');
    git('branch', 'other', featSha);
    const r2 = await ingestRepo(db, dir);
    expect(r2.commitsAdded).toBe(1);
    expect(r2.refsUpdated).toBe(2); // base + featSha gained 'other'
    const more = db.prepare('SELECT branch_refs FROM commit_ WHERE sha = ?').get(moreSha) as any;
    expect(JSON.parse(more.branch_refs)).toEqual(['feature']);
  });

  it('keeps one patch per file with special paths and no-hunk mode changes', async () => {
    write('sp ace/é.txt', 'a\n');
    write('run.sh', 'echo\n');
    commit('c1');
    chmodSync(join(dir, 'run.sh'), 0o755);
    write('sp ace/é.txt', 'a\nb\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c2');
    const db = openDb(':memory:');
    await ingestRepo(db, dir);
    const rows = db.prepare(
      "SELECT path, patch FROM file_change f JOIN change_unit u ON u.id=f.change_unit_id WHERE u.title='c2' ORDER BY path",
    ).all() as any[];
    expect(rows.map((r) => r.path)).toEqual(['run.sh', 'sp ace/é.txt']);
    expect(rows[0].patch).toContain('new mode 100755');
    expect(rows[1].patch).toContain('+b');
  });

  it('handles an empty repository', async () => {
    const db = openDb(':memory:');
    const r = await ingestRepo(db, dir);
    expect(r.commitsAdded).toBe(0);
    expect((db.prepare('SELECT head_sha FROM repo').get() as any).head_sha).toBeNull();
  });
});

describe('splitPatch', () => {
  it('splits on diff headers only', () => {
    const p = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+diff --git not a header\ndiff --git a/y b/y\nnew file mode 100644\n';
    const parts = splitPatch(p);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('+diff --git not a header');
  });
});
