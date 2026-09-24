import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@digestit/core';
import { dirtyStat, listRefs, listWorktrees, type Worktree } from './git.js';
import { ingestRepo } from './ingest.js';

export interface WatchState { refHash: string | null }

export interface PollResult {
  ingested: boolean;
  newCommits: string[];
  dirtyWorktrees: number;
}

export const DEFAULT_INTERVAL_MS = 5000;

/** Worktrees of the watched repo that exist on disk. `git worktree list` only reports this repo's own worktrees. */
async function usableWorktrees(repo: string): Promise<Worktree[]> {
  return (await listWorktrees(repo)).filter((w) => !w.bare && w.path.startsWith('/') && existsSync(w.path));
}

/** One poll: hash refs + worktree HEADs, ingest on change, refresh dirty diffstats. Read-only against git. */
export async function pollOnce(db: DatabaseSync, repoPath: string, state: WatchState): Promise<PollResult> {
  const path = realpathSync(resolve(repoPath));
  const worktrees = await usableWorktrees(path);
  const heads = worktrees.map((w) => `${w.path} ${w.head ?? '-'}`).join('\n');
  const refHash = createHash('sha256').update(await listRefs(path)).update('\0').update(heads).digest('hex');

  let ingested = false;
  let newCommits: string[] = [];
  if (refHash !== state.refHash) {
    const r = await ingestRepo(db, path, { landedEvents: true });
    newCommits = r.newCommits;
    ingested = true;
    state.refHash = refHash; // only after success, so a failed ingest retries next poll
  }

  const repo = db.prepare('SELECT id FROM repo WHERE path = ?').get(path) as { id: number } | undefined;
  let dirty = 0;
  if (repo) {
    const stats = new Map<string, Awaited<ReturnType<typeof dirtyStat>>>();
    for (const w of worktrees) {
      const s = await dirtyStat(w.path);
      if (s.files > 0) stats.set(w.path, s);
    }
    dirty = stats.size;
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      const existing = db.prepare('SELECT path FROM worktree_state WHERE repo_id = ?').all(repo.id) as { path: string }[];
      for (const { path: p } of existing) {
        if (!stats.has(p)) db.prepare('DELETE FROM worktree_state WHERE repo_id = ? AND path = ?').run(repo.id, p);
      }
      const cur = db.prepare(
        'SELECT head_sha, branch, files, additions, deletions, untracked FROM worktree_state WHERE repo_id = ? AND path = ?',
      );
      const up = db.prepare(
        `INSERT INTO worktree_state (repo_id, path, branch, head_sha, files, additions, deletions, untracked, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, path) DO UPDATE SET branch = excluded.branch, head_sha = excluded.head_sha,
           files = excluded.files, additions = excluded.additions, deletions = excluded.deletions,
           untracked = excluded.untracked, updated_at = excluded.updated_at`,
      );
      for (const w of worktrees) {
        const s = stats.get(w.path);
        if (!s) continue;
        const old = cur.get(repo.id, w.path) as Record<string, unknown> | undefined;
        const same = old && old.head_sha === w.head && old.branch === w.branch && old.files === s.files &&
          old.additions === s.additions && old.deletions === s.deletions && old.untracked === s.untracked;
        if (!same) up.run(repo.id, w.path, w.branch, w.head, s.files, s.additions, s.deletions, s.untracked, now);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return { ingested, newCommits, dirtyWorktrees: dirty };
}

export interface WatchOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  onPoll?: (r: PollResult) => void;
  onError?: (e: unknown) => void;
}

/** Polls until `signal` aborts; resolves cleanly (no dangling timer) when it does. */
export async function watchRepo(db: DatabaseSync, repoPath: string, opts: WatchOptions = {}): Promise<void> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const { signal } = opts;
  const state: WatchState = { refHash: null };
  while (!signal?.aborted) {
    try {
      opts.onPoll?.(await pollOnce(db, repoPath, state));
    } catch (e) {
      opts.onError?.(e); // transient git/db errors must not kill the watcher
    }
    await new Promise<void>((done) => {
      if (signal?.aborted) return done();
      const t = setTimeout(finish, interval);
      function finish() { clearTimeout(t); signal?.removeEventListener('abort', finish); done(); }
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

const USAGE = 'usage: digest watch <path> [--interval <seconds>] [--db <file>]';

export async function runWatchCli(argv: string[]): Promise<number> {
  const [, path, ...rest] = argv;
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const secs = flag('--interval') === undefined ? DEFAULT_INTERVAL_MS / 1000 : Number(flag('--interval'));
  if (!path || !(secs >= 0.1)) { console.error(USAGE); return 2; }
  const db = openDb(flag('--db') ?? process.env.DIGESTIT_DB);
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`watching ${path} every ${secs}s (Ctrl-C to stop)`);
  try {
    await watchRepo(db, path, {
      intervalMs: secs * 1000,
      signal: ac.signal,
      onPoll: (r) => { if (r.ingested) console.log(`ingested: +${r.newCommits.length} commits, ${r.dirtyWorktrees} dirty worktrees`); },
      onError: (e) => console.error(`poll failed: ${e instanceof Error ? e.message : String(e)}`),
    });
    return 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    db.close();
  }
}
