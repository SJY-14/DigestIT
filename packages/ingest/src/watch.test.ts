import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { parseWorktrees } from './git.js';
import { pollOnce, watchRepo, type WatchState } from './watch.js';

let root: string, dir: string;
const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
const commitIn = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), msg + '\n');
  g(cwd, 'add', '-A'); g(cwd, 'commit', '-q', '-m', msg);
  return g(cwd, 'rev-parse', 'HEAD');
};
const n = (db: ReturnType<typeof openDb>, sql: string) => (db.prepare(sql).get() as { c: number }).c;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'digest-watch-')));
  dir = join(root, 'repo');
  mkdirSync(dir);
  g(dir, 'init', '-q', '-b', 'main');
  commitIn(dir, 'a.txt', 'root');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pollOnce', () => {
  it('ingests on first poll, skips when nothing changed, ingests a new commit within one poll', async () => {
    const db = openDb(':memory:');
    const st: WatchState = { refHash: null };
    const p1 = await pollOnce(db, dir, st);
    expect(p1.ingested).toBe(true);
    expect(p1.newCommits).toHaveLength(1);
    expect(n(db, "SELECT COUNT(*) c FROM unit_event WHERE kind='landed'")).toBe(1);
    expect(JSON.parse((db.prepare('SELECT detail FROM unit_event').get() as any).detail).backfill).toBe(true);

    const p2 = await pollOnce(db, dir, st);
    expect(p2.ingested).toBe(false);
    expect(n(db, 'SELECT COUNT(*) c FROM commit_')).toBe(1);

    const sha = commitIn(dir, 'b.txt', 'second');
    const p3 = await pollOnce(db, dir, st);
    expect(p3.newCommits).toEqual([sha]);
    const ev = db.prepare("SELECT detail FROM unit_event WHERE kind='landed' ORDER BY id DESC").get() as any;
    expect(JSON.parse(ev.detail)).toEqual({ sha });
    expect((db.prepare('SELECT work_unit_id w FROM unit_event').get() as any).w).toBeNull();
  });

  it('picks up a commit on a branch checked out in another worktree', async () => {
    const db = openDb(':memory:');
    const st: WatchState = { refHash: null };
    await pollOnce(db, dir, st);
    const wt = join(root, 'wt');
    g(dir, 'worktree', 'add', '-q', '-b', 'DIG-1-x', wt);
    expect((await pollOnce(db, dir, st)).ingested).toBe(true); // new ref + worktree
    const sha = commitIn(wt, 'w.txt', 'in worktree');
    const p = await pollOnce(db, dir, st);
    expect(p.newCommits).toEqual([sha]);
    expect(JSON.parse((db.prepare('SELECT branch_refs b FROM commit_ WHERE sha = ?').get(sha) as any).b)).toEqual(['DIG-1-x']);
  });

  it('stores a diffstat (no ingest) for dirty worktrees and clears it when clean', async () => {
    const db = openDb(':memory:');
    const st: WatchState = { refHash: null };
    await pollOnce(db, dir, st);
    expect(n(db, 'SELECT COUNT(*) c FROM worktree_state')).toBe(0);
    writeFileSync(join(dir, 'a.txt'), 'root\nx\ny\n');
    writeFileSync(join(dir, 'new.txt'), 'u\n');
    const p = await pollOnce(db, dir, st);
    expect(p.ingested).toBe(false);
    expect(p.dirtyWorktrees).toBe(1);
    expect(db.prepare('SELECT files, additions, deletions, untracked FROM worktree_state').get()).toMatchObject({
      files: 2, additions: 2, deletions: 0, untracked: 1,
    });
    expect(n(db, 'SELECT COUNT(*) c FROM commit_')).toBe(1);
    g(dir, 'checkout', '-q', '--', 'a.txt'); rmSync(join(dir, 'new.txt'));
    await pollOnce(db, dir, st);
    expect(n(db, 'SELECT COUNT(*) c FROM worktree_state')).toBe(0);
  });

  it('does not modify refs, hooks or config', async () => {
    const snap = () => [g(dir, 'for-each-ref'), g(dir, 'config', '--local', '-l')].join('\n');
    const before = snap();
    await pollOnce(openDb(':memory:'), dir, { refHash: null });
    expect(snap()).toBe(before);
  });
});

describe('parseWorktrees', () => {
  it('parses branch, detached and bare records', () => {
    const t = 'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /w\nHEAD def\ndetached\n\nworktree /b\nbare\n';
    expect(parseWorktrees(t)).toEqual([
      { path: '/r', head: 'abc', branch: 'main', bare: false },
      { path: '/w', head: 'def', branch: null, bare: false },
      { path: '/b', head: null, branch: null, bare: true },
    ]);
  });
});

describe('watchRepo', () => {
  it('polls repeatedly and exits cleanly on abort', async () => {
    const db = openDb(':memory:');
    const ac = new AbortController();
    const polls: boolean[] = [];
    const done = watchRepo(db, dir, {
      intervalMs: 20, signal: ac.signal,
      onPoll: (r) => { polls.push(r.ingested); if (polls.length === 1) commitIn(dir, 'c.txt', 'later'); if (polls.length === 3) ac.abort(); },
    });
    await done;
    expect(polls.slice(0, 3)).toEqual([true, true, false]);
    expect(n(db, 'SELECT COUNT(*) c FROM commit_')).toBe(2);
  });

  it('exits cleanly on SIGINT via the CLI', async () => {
    const { spawn } = await import('node:child_process');
    const cli = new URL('../dist/cli.js', import.meta.url).pathname; // needs `pnpm build`
    const child = spawn(process.execPath, [cli, 'watch', dir, '--interval', '0.2', '--db', join(root, 'x.sqlite')],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await new Promise<void>((ok) => { const t = setInterval(() => { if (out.includes('ingested')) { clearInterval(t); ok(); } }, 50); });
    child.kill('SIGINT');
    const code = await new Promise((ok) => child.on('exit', ok));
    expect(code).toBe(0);
  }, 20000);
});
