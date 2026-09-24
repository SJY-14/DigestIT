import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { explainRollup, type RollupUnit } from '@digestit/explain';
import type { ExplainScheduler } from './scheduler.js';

export const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
export const ROLLUP_MIN_UNITS = 2;

interface Row { [k: string]: unknown }

const json = (v: unknown): any => { try { return JSON.parse(v as string); } catch { return null; } };

/**
 * Enqueues an hourly, text-only roll-up of the work units that moved (landed / explained / handoff /
 * merged) in the last hour, when at least two did. The job runs through the scheduler, so it obeys the
 * daily budget and is logged in `explain_call` (reason `rollup`); over budget it stays queued.
 */
export class RollupPlanner {
  private readonly repoPath: string;
  private lastEnqueuedAt: number | null = null;
  private queued = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly scheduler: ExplainScheduler,
    repoPath: string,
    private readonly opts: { now?: () => Date; intervalMs?: number; minUnits?: number; onError?: (e: unknown) => void } = {},
  ) {
    this.repoPath = realpathSync(resolve(repoPath));
  }

  private repoId(): number | null {
    const r = this.db.prepare('SELECT id FROM repo WHERE path = ?').get(this.repoPath) as { id: number } | undefined;
    return r?.id ?? null;
  }

  /** Ids of work units with a movement event in [start, end]. */
  private moved(repoId: number, start: Date, end: Date): number[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT work_unit_id AS id FROM unit_event
        WHERE repo_id = ? AND work_unit_id IS NOT NULL AND kind IN ('landed','explained','handoff','merged')
          AND unixepoch(at) >= unixepoch(?) AND unixepoch(at) <= unixepoch(?) ORDER BY work_unit_id`,
    ).all(repoId, start.toISOString(), end.toISOString()) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /** Call on every poll; cheap. Returns true when a job was queued. */
  maybeEnqueue(): boolean {
    const now = (this.opts.now ?? (() => new Date()))();
    const interval = this.opts.intervalMs ?? ROLLUP_INTERVAL_MS;
    const repoId = this.repoId();
    if (repoId === null || this.queued) return false;
    if (this.lastEnqueuedAt === null) {
      const r = this.db.prepare('SELECT max(unixepoch(window_end)) AS t FROM rollup WHERE repo_id = ?').get(repoId) as { t: number | null };
      this.lastEnqueuedAt = r.t === null ? Number.NEGATIVE_INFINITY : r.t * 1000;
    }
    if (now.getTime() - this.lastEnqueuedAt < interval) return false;
    const start = new Date(now.getTime() - interval);
    const ids = this.moved(repoId, start, now);
    if (ids.length < (this.opts.minUnits ?? ROLLUP_MIN_UNITS)) return false;
    this.lastEnqueuedAt = now.getTime();
    this.queued = true;
    this.scheduler.enqueue({
      reason: 'rollup',
      run: async ({ provider, budget }) => {
        try {
          const units = this.loadUnits(ids);
          const repoName = (this.db.prepare('SELECT name FROM repo WHERE id = ?').get(repoId) as { name: string }).name;
          const r = await explainRollup(provider, { repoName, windowStart: start.toISOString(), windowEnd: now.toISOString(), units }, budget);
          if (r.outcome === 'ok' || r.outcome === 'truncated') {
            this.db.prepare(
              'INSERT INTO rollup (repo_id, window_start, window_end, work_unit_ids, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            ).run(repoId, start.toISOString(), now.toISOString(), JSON.stringify(ids), JSON.stringify(r.levels), (this.opts.now ?? (() => new Date()))().toISOString());
            this.queued = false;
          } else if (r.outcome === 'budget') {
            this.queued = false;
            this.lastEnqueuedAt = Number.NEGATIVE_INFINITY; // retry on the next poll
          } else {
            this.queued = false; // error/empty: next attempt in an hour
          }
        } catch (e) {
          this.queued = false;
          throw e;
        }
      },
    });
    return true;
  }

  /** Each unit's own L0/L1 text (latest snapshot's, else its title); never a diff. */
  private loadUnits(ids: number[]): RollupUnit[] {
    const latest = this.db.prepare(
      `SELECT content FROM explanation WHERE change_unit_id = ? AND level = ?
        ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`,
    );
    const out: RollupUnit[] = [];
    for (const id of ids) {
      const w = this.db.prepare('SELECT key, title, state, latest_range_unit_id AS r FROM work_unit WHERE id = ?').get(id) as Row | undefined;
      if (!w) continue;
      const l0 = w.r == null ? null : json((latest.get(w.r as number, 0) as Row | undefined)?.content);
      const l1 = w.r == null ? null : json((latest.get(w.r as number, 1) as Row | undefined)?.content);
      out.push({
        key: w.key as string, title: w.title as string, state: w.state as string,
        l0: typeof l0?.text === 'string' ? l0.text : (w.title as string),
        userVisible: l1?.userVisible === true,
        bullets: Array.isArray(l1?.bullets) ? l1.bullets.filter((b: unknown) => typeof b === 'string') : [],
      });
    }
    return out;
  }
}
