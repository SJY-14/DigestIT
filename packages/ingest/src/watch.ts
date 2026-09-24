import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '@digestit/core';
import { createProvider } from '@digestit/explain';
import { dirtyStat, listRefs, listWorktrees, type Worktree } from './git.js';
import { ingestRepo } from './ingest.js';
import { DEFAULT_DAILY_BUDGET, ExplainScheduler, stubCommits } from './scheduler.js';
import { syncWorkUnits, type WorkUnitOptions } from './workunits.js';

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
    stubCommits(db, r.repoId, r.newCommits); // subject-line L0 on land; never a provider call
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

/** Re-evaluate work-unit states at least this often, so a quiet period ends without a new commit. */
export const WORK_UNIT_SYNC_MS = 30_000;

export interface WatchOptions {
  intervalMs?: number;
  /** Runs after each poll, in the background (a slow explanation never delays polling). */
  scheduler?: ExplainScheduler;
  workUnits?: WorkUnitOptions;
  signal?: AbortSignal;
  onPoll?: (r: PollResult) => void;
  onError?: (e: unknown) => void;
}

/** Polls until `signal` aborts; resolves cleanly (no dangling timer) when it does. */
export async function watchRepo(db: DatabaseSync, repoPath: string, opts: WatchOptions = {}): Promise<void> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const { signal } = opts;
  const state: WatchState = { refHash: null };
  let lastSync = 0;
  while (!signal?.aborted) {
    try {
      const r = await pollOnce(db, repoPath, state);
      opts.onPoll?.(r);
      if ((opts.scheduler || opts.workUnits) && (r.ingested || Date.now() - lastSync >= WORK_UNIT_SYNC_MS)) {
        await syncWorkUnits(db, realpathSync(resolve(repoPath)), opts.workUnits);
        lastSync = Date.now();
      }
      if (opts.scheduler) void opts.scheduler.tick().catch((e) => opts.onError?.(e));
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
  await opts.scheduler?.idle();
}

export const WATCH_USAGE = `usage: digest watch <path> [--interval <seconds>] [--db <file>] [--no-explain]
  --provider <name>   stub | claude-code (default $DIGESTIT_PROVIDER or stub)
  --allow <repo,...>  repo allowlist (default $DIGESTIT_ALLOWLIST or DigestIT)
  --budget <n>        LLM calls per local day (default $DIGESTIT_DAILY_BUDGET or ${DEFAULT_DAILY_BUDGET})
  --no-explain        track and link only; make no explanation calls`;

/** Positive-integer flag/env value, or undefined when absent; NaN when malformed. */
export const intOpt = (v: string | undefined): number | undefined => (v === undefined ? undefined : /^[1-9]\d*$/.test(v) ? Number(v) : NaN);

/** Provider + allowlist from flags/env, shared by `watch` and manual `explain --unit <key>`. */
export function providerFromArgs(v: { provider?: string; allow?: string }) {
  const name = v.provider ?? process.env.DIGESTIT_PROVIDER ?? 'stub';
  if (name !== 'stub' && name !== 'claude-code') return null;
  return createProvider({
    provider: name,
    repoAllowlist: (v.allow ?? process.env.DIGESTIT_ALLOWLIST ?? 'DigestIT').split(',').map((s) => s.trim()).filter(Boolean),
    claudeBin: process.env.DIGESTIT_CLAUDE_BIN,
    claudeModel: process.env.DIGESTIT_CLAUDE_MODEL,
  });
}

export async function runWatchCli(argv: string[]): Promise<number> {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        interval: { type: 'string' }, db: { type: 'string' }, provider: { type: 'string' }, allow: { type: 'string' },
        budget: { type: 'string' }, 'no-explain': { type: 'boolean' },
      },
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${WATCH_USAGE}`);
    return 2;
  }
  const path = positionals[0];
  const secs = values.interval === undefined ? DEFAULT_INTERVAL_MS / 1000 : Number(values.interval);
  const budget = intOpt(values.budget ?? process.env.DIGESTIT_DAILY_BUDGET);
  if (!path || !(secs >= 0.1) || Number.isNaN(budget)) { console.error(WATCH_USAGE); return 2; }
  const provider = values['no-explain'] ? null : providerFromArgs(values);
  if (!values['no-explain'] && !provider) { console.error('unknown provider'); return 2; }
  const db = openDb(values.db ?? process.env.DIGESTIT_DB);
  const scheduler = provider
    ? new ExplainScheduler(db, provider, {
        repoPath: path, dailyBudget: budget,
        onError: (e) => console.error(`explain failed: ${e instanceof Error ? e.message : String(e)}`),
      })
    : undefined;
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`watching ${path} every ${secs}s (Ctrl-C to stop)` +
    (provider ? `; explaining with ${provider.id}, ${budget ?? DEFAULT_DAILY_BUDGET} calls/day` : '; explanations off'));
  try {
    await watchRepo(db, path, {
      intervalMs: secs * 1000,
      signal: ac.signal,
      scheduler,
      workUnits: scheduler ? undefined : {},
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

/** `digest explain --unit <work-unit key> [--repo <path>]`: one on-demand run, reason `manual`, counts toward the daily budget. */
export async function runManualExplainCli(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv.slice(1),
      options: { unit: { type: 'string' }, repo: { type: 'string' }, db: { type: 'string' }, provider: { type: 'string' }, allow: { type: 'string' }, budget: { type: 'string' } },
    }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const budget = intOpt(values.budget ?? process.env.DIGESTIT_DAILY_BUDGET);
  const provider = providerFromArgs(values);
  if (!values.unit || !provider || Number.isNaN(budget)) { console.error('usage: digest explain --unit <work-unit key, e.g. DIG-14> [--repo <path>] [--provider ...] [--budget <n>]'); return 2; }
  const db = openDb(values.db ?? process.env.DIGESTIT_DB);
  try {
    const rows = db.prepare('SELECT DISTINCT r.path FROM work_unit w JOIN repo r ON r.id = w.repo_id WHERE w.key = ?').all(values.unit) as { path: string }[];
    const repoPath = values.repo ?? (rows.length === 1 ? rows[0]!.path : undefined);
    if (!repoPath) { console.error(rows.length ? 'unit key is in several repos; pass --repo <path>' : `no work unit ${values.unit}`); return 1; }
    const scheduler = new ExplainScheduler(db, provider, { repoPath, dailyBudget: budget });
    const { outcome } = await scheduler.explainNow(values.unit);
    console.log(`${values.unit}: ${outcome === 'budget' ? 'pending (budget): daily call budget used up' : outcome}`);
    return outcome === 'ok' || outcome === 'truncated' || outcome === 'oversize' || outcome === 'cached' ? 0 : 1;
  } catch (e) {
    console.error(`explain failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }
}
