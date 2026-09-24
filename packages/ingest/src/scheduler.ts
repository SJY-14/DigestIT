import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BudgetTracker, DEFAULT_MAX_RANGE_TOKENS, LIMITS, RANGE_PROMPT_VERSION, RepoNotAllowedError,
  explainRange, loadChange, redact, store, truncateWords,
  type ExplanationProvider, type RawRange,
} from '@digestit/explain';
import { createRangeUnit } from './workunits.js';

export type ExplainReason = 'merged' | 'handoff' | 'rollup' | 'backfill' | 'manual';

/** Queue order: lower runs first. Manual runs bypass the queue (see `explainNow`). */
export const PRIORITY: Record<Exclude<ExplainReason, 'manual'>, number> = { merged: 0, handoff: 1, rollup: 2, backfill: 3 };

export const DEFAULT_DAILY_BUDGET = 40;
export const DEFAULT_MAX_EXPLAINS = 3;
export const DEFAULT_RETRY_ERROR_MS = 30 * 60 * 1000;
/** Failed provider calls tolerated per range snapshot before it is left alone until the tip moves. */
const MAX_ERROR_CALLS = 4;

export interface SchedulerOptions {
  repoPath: string;
  /** LLM calls per local day (default 40, the Board-approved cap). */
  dailyBudget?: number;
  /** Automatic explanations per work unit (default 3). */
  maxExplains?: number;
  /** Wait this long after a failed run of a snapshot before trying it again. */
  retryErrorMs?: number;
  maxRangeTokens?: number;
  /** Injected clock for tests. */
  now?: () => Date;
  onError?: (e: unknown) => void;
}

/** A rollup/backfill job supplied by another component; it must make its provider calls through `ctx`. */
export interface ExtraJob {
  reason: 'rollup' | 'backfill';
  run(ctx: { provider: ExplanationProvider; budget: BudgetTracker }): Promise<void>;
}

export interface TickResult {
  ran: { key: string; reason: ExplainReason; outcome: string }[];
  /** Work units that need an explanation but were left `pending (budget)`. */
  pendingBudget: string[];
}

export const startOfLocalDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Shares the day's remaining calls; reservations read the `explain_call` log, so restarts and other processes count. */
class DayBudget extends BudgetTracker {
  constructor(private readonly used: () => number, private readonly cap: number) {
    super({ maxCalls: cap, maxTokens: Number.POSITIVE_INFINITY });
  }
  override tryReserve(): boolean {
    if (this.used() >= this.cap) return false;
    this.calls++;
    return true;
  }
}

interface UnitRow {
  id: number; repo_id: number; key: string; state: string; title: string; tip_sha: string; base_sha: string | null;
  last_commit_at: string; merged_at: string | null; latest_range_unit_id: number | null;
}

interface Pick {
  id: string;
  rank: number;
  order: string;
  unit?: UnitRow;
  reason: ExplainReason;
  extra?: ExtraJob;
}

/**
 * Explains work units as range units when they are handed off or merged, under a per-day call budget.
 * Concurrency is 1: `tick` and `explainNow` run one at a time. Nothing here is reachable from the API server.
 */
export class ExplainScheduler {
  private readonly cap: number;
  private readonly maxExplains: number;
  private readonly retryErrorMs: number;
  private readonly now: () => Date;
  private readonly repoPath: string;
  private extras: ExtraJob[] = [];
  /** Snapshots the allowlist refused; reported once, not on every poll. */
  private readonly refused = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private tickP: Promise<TickResult> | null = null;

  constructor(private readonly db: DatabaseSync, private readonly provider: ExplanationProvider, private readonly opts: SchedulerOptions) {
    this.cap = opts.dailyBudget ?? DEFAULT_DAILY_BUDGET;
    this.maxExplains = opts.maxExplains ?? DEFAULT_MAX_EXPLAINS;
    this.retryErrorMs = opts.retryErrorMs ?? DEFAULT_RETRY_ERROR_MS;
    this.now = opts.now ?? (() => new Date());
    this.repoPath = realpathSync(resolve(opts.repoPath));
  }

  /** Queues a roll-up or backfill job; it runs after all merged/handoff units and only while budget remains. */
  enqueue(job: ExtraJob): void {
    this.extras.push(job);
  }

  /** Provider calls made today (local time); budget rows are not calls. */
  callsToday(): number {
    const r = this.db.prepare("SELECT count(*) AS n FROM explain_call WHERE at >= ? AND outcome IN ('ok','error')")
      .get(startOfLocalDay(this.now()).toISOString()) as { n: number };
    return r.n;
  }

  /** Drains the queue once. Concurrent calls share one run. */
  tick(): Promise<TickResult> {
    if (this.tickP) return this.tickP;
    const p = this.serial(() => this.drain()).finally(() => { this.tickP = null; });
    this.tickP = p;
    return p;
  }

  /** Resolves when nothing is running. */
  async idle(): Promise<void> {
    await this.tail;
  }

  /**
   * On-demand run for one work unit key (any state). Reason `manual`: not subject to the re-explain cap,
   * but it counts toward the daily budget. An unchanged, already explained snapshot makes no call.
   */
  explainNow(key: string): Promise<{ outcome: string }> {
    return this.serial(async () => {
      const wu = this.db.prepare(
        'SELECT w.* FROM work_unit w JOIN repo r ON r.id = w.repo_id WHERE r.path = ? AND w.key = ?',
      ).get(this.repoPath, key) as unknown as UnitRow | undefined;
      if (!wu) return { outcome: 'unknown-unit' };
      const { changeUnitId } = await createRangeUnit(this.db, this.repoPath, wu.id);
      if (this.isExplained(changeUnitId)) return { outcome: 'cached' };
      return { outcome: await this.runUnit(wu, changeUnitId, 'manual') };
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private repoId(): number | null {
    const r = this.db.prepare('SELECT id FROM repo WHERE path = ?').get(this.repoPath) as { id: number } | undefined;
    return r?.id ?? null;
  }

  private isExplained(rangeId: number): boolean {
    const r = this.db.prepare(
      `SELECT count(DISTINCT level) AS n FROM explanation
        WHERE change_unit_id = ? AND prompt_version = ? AND status IN ('ok','truncated')`,
    ).get(rangeId, RANGE_PROMPT_VERSION) as { n: number };
    return r.n === 4;
  }

  /** Snapshot for the unit's current tip/base is already explained (cheap: no git). */
  private isCurrentExplained(wu: UnitRow): boolean {
    if (wu.latest_range_unit_id === null) return false;
    const cu = this.db.prepare('SELECT head_sha, base_sha FROM change_unit WHERE id = ?')
      .get(wu.latest_range_unit_id) as { head_sha: string; base_sha: string | null } | undefined;
    return !!cu && cu.head_sha === wu.tip_sha && (cu.base_sha ?? '') === (wu.base_sha ?? '') && this.isExplained(wu.latest_range_unit_id);
  }

  private autoExplainCount(wuId: number): number {
    const r = this.db.prepare(
      "SELECT count(*) AS n FROM unit_event WHERE work_unit_id = ? AND kind = 'explained' AND json_extract(detail, '$.reason') != 'manual'",
    ).get(wuId) as { n: number };
    return r.n;
  }

  private reasonOf(wu: UnitRow): ExplainReason {
    if (wu.state === 'handoff') return 'handoff';
    // Units first seen already merged (history) are backfill, so old history cannot starve fresh merges.
    const ev = this.db.prepare("SELECT json_extract(detail, '$.backfill') AS b FROM unit_event WHERE work_unit_id = ? AND kind = 'merged' ORDER BY id DESC LIMIT 1")
      .get(wu.id) as { b: number | null } | undefined;
    return ev?.b ? 'backfill' : 'merged';
  }

  /** Next job by priority, newest first within a priority; skips what this tick already handled. */
  private next(seen: Set<string>): Pick | null {
    const repoId = this.repoId();
    const picks: Pick[] = [];
    if (repoId !== null) {
      const rows = this.db.prepare("SELECT * FROM work_unit WHERE repo_id = ? AND state IN ('handoff','merged')")
        .all(repoId) as unknown as UnitRow[];
      for (const wu of rows) {
        const id = `unit:${wu.id}:${wu.tip_sha}`;
        if (seen.has(id) || this.refused.has(id) || this.isCurrentExplained(wu)) continue;
        if (this.autoExplainCount(wu.id) >= this.maxExplains) continue;
        const reason = this.reasonOf(wu);
        picks.push({ id, unit: wu, reason, rank: PRIORITY[reason as keyof typeof PRIORITY], order: wu.merged_at ?? wu.last_commit_at });
      }
    }
    this.extras.forEach((extra, i) => {
      const id = `extra:${i}:${extra.reason}`;
      if (!seen.has(id)) picks.push({ id, extra, reason: extra.reason, rank: PRIORITY[extra.reason], order: '' });
    });
    picks.sort((a, b) => a.rank - b.rank || (a.order < b.order ? 1 : a.order > b.order ? -1 : 0) || (a.id < b.id ? -1 : 1));
    return picks[0] ?? null;
  }

  private async drain(): Promise<TickResult> {
    const res: TickResult = { ran: [], pendingBudget: [] };
    const seen = new Set<string>();
    for (let pick = this.next(seen); pick; pick = this.next(seen)) {
      seen.add(pick.id);
      try {
        if (pick.extra) {
          if (this.callsToday() >= this.cap) continue; // stays queued for a day with budget
          this.extras = this.extras.filter((e) => e !== pick.extra);
          await pick.extra.run({ provider: this.logged(pick.reason, null), budget: this.budget() });
          res.ran.push({ key: pick.reason, reason: pick.reason, outcome: 'ok' });
          continue;
        }
        const wu = pick.unit!;
        const { changeUnitId } = await createRangeUnit(this.db, this.repoPath, wu.id);
        if (this.isExplained(changeUnitId)) continue;
        if (this.errorCooling(changeUnitId)) continue;
        const outcome = await this.runUnit(wu, changeUnitId, pick.reason);
        if (outcome === 'budget') res.pendingBudget.push(wu.key);
        else res.ran.push({ key: wu.key, reason: pick.reason, outcome });
      } catch (e) {
        if (e instanceof RepoNotAllowedError) this.refused.add(pick.id);
        this.opts.onError?.(e);
      }
    }
    return res;
  }

  private errorCooling(rangeId: number): boolean {
    const r = this.db.prepare("SELECT count(*) AS n, max(at) AS last FROM explain_call WHERE change_unit_id = ? AND outcome = 'error'")
      .get(rangeId) as { n: number; last: string | null };
    if (r.n === 0) return false;
    return r.n >= MAX_ERROR_CALLS || this.now().getTime() - Date.parse(r.last!) < this.retryErrorMs;
  }

  private budget(): DayBudget {
    return new DayBudget(() => this.callsToday(), this.cap);
  }

  private log(at: Date, rangeId: number | null, reason: ExplainReason, durationMs: number, outcome: 'ok' | 'error' | 'budget'): void {
    this.db.prepare('INSERT INTO explain_call (at, change_unit_id, reason, duration_ms, outcome) VALUES (?, ?, ?, ?, ?)')
      .run(at.toISOString(), rangeId, reason, durationMs, outcome);
  }

  /** The provider with every call logged to `explain_call`. An allowlist refusal made no call and is not logged. */
  private logged(reason: ExplainReason, rangeId: number | null): ExplanationProvider {
    const inner = this.provider;
    const wrap = <I, R>(fn: (i: I) => Promise<R>) => async (input: I): Promise<R> => {
      const t0 = this.now();
      try {
        const r = await fn(input);
        this.log(t0, rangeId, reason, this.now().getTime() - t0.getTime(), 'ok');
        return r;
      } catch (e) {
        if (!(e instanceof RepoNotAllowedError)) this.log(t0, rangeId, reason, this.now().getTime() - t0.getTime(), 'error');
        throw e;
      }
    };
    return {
      id: inner.id,
      model: inner.model,
      explain: wrap(inner.explain.bind(inner)),
      explainRange: inner.explainRange && wrap(inner.explainRange.bind(inner)),
      rollup: inner.rollup && wrap(inner.rollup.bind(inner)),
    };
  }

  private loadRange(wu: UnitRow, rangeId: number): RawRange {
    const change = loadChange(this.db, rangeId)!;
    const members = this.db.prepare(
      `SELECT c.sha, c.message FROM unit_commit uc JOIN commit_ c ON c.sha = uc.sha
        WHERE uc.work_unit_id = ? ORDER BY c.committed_at, c.rowid`,
    ).all(wu.id) as unknown as { sha: string; message: string }[];
    return {
      repoName: change.repoName,
      title: wu.title,
      members: members.map((m) => ({ sha: m.sha, subject: m.message.split('\n')[0] ?? '' })),
      files: change.files,
    };
  }

  private markBudget(at: Date, rangeId: number, reason: ExplainReason): string {
    const has = this.db.prepare("SELECT 1 AS x FROM explain_call WHERE change_unit_id = ? AND outcome = 'budget' AND at >= ?")
      .get(rangeId, startOfLocalDay(at).toISOString());
    if (!has) this.log(at, rangeId, reason, 0, 'budget'); // once per snapshot per day, not once per tick
    return 'budget';
  }

  /** Returns 'budget' when nothing ran because the day's calls are used up. */
  private async runUnit(wu: UnitRow, rangeId: number, reason: ExplainReason): Promise<string> {
    if (this.callsToday() >= this.cap) return this.markBudget(this.now(), rangeId, reason);
    const r = await explainRange(this.logged(reason, rangeId), this.loadRange(wu, rangeId), this.budget(), {
      maxRangeTokens: this.opts.maxRangeTokens ?? DEFAULT_MAX_RANGE_TOKENS,
    });
    const at = this.now();
    if (r.outcome === 'budget') return this.markBudget(at, rangeId, reason);
    if (r.outcome === 'ok' || r.outcome === 'truncated' || r.outcome === 'oversize') {
      const status = r.outcome === 'ok' ? 'ok' : 'truncated';
      store(this.db, rangeId, r.levels, status, r.provider ?? { provider: 'fallback', model: 'none' }, r.promptVersion, r.inputHash, at.toISOString());
      this.db.prepare("INSERT INTO unit_event (repo_id, work_unit_id, change_unit_id, kind, at, detail) VALUES (?, ?, ?, 'explained', ?, ?)")
        .run(wu.repo_id, wu.id, rangeId, at.toISOString(), JSON.stringify({ reason, outcome: r.outcome, tip: wu.tip_sha }));
    }
    return r.outcome;
  }
}

/** Work units that need an explanation but are waiting on the daily budget (`pending (budget)` in the UI). */
export function pendingBudgetUnitIds(db: DatabaseSync, now: Date = new Date()): number[] {
  const rows = db.prepare(
    `SELECT w.id FROM work_unit w
      WHERE w.latest_range_unit_id IN
              (SELECT change_unit_id FROM explain_call WHERE outcome = 'budget' AND at >= ?)
        AND NOT EXISTS (SELECT 1 FROM explanation e WHERE e.change_unit_id = w.latest_range_unit_id
                          AND e.prompt_version = ? AND e.level = 0 AND e.status IN ('ok','truncated'))`,
  ).all(startOfLocalDay(now).toISOString(), RANGE_PROMPT_VERSION) as unknown as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * Gives freshly landed commits a stub L0 (their subject line, redacted). No provider call, no
 * `explain_call` row. Stored as a `pending` level-0 row under prompt version `stub`, so a real
 * explanation (`ok`) always outranks it.
 */
export function stubCommits(db: DatabaseSync, repoId: number, shas: readonly string[], now: Date = new Date()): number {
  const sel = db.prepare("SELECT id, title FROM change_unit WHERE repo_id = ? AND kind = 'commit' AND head_sha = ?");
  const ins = db.prepare(
    `INSERT OR IGNORE INTO explanation (change_unit_id, level, content, status, provider, model, prompt_version, input_hash, created_at)
     SELECT ?, 0, ?, 'pending', 'subject', 'stub', 'stub', '', ?
      WHERE NOT EXISTS (SELECT 1 FROM explanation WHERE change_unit_id = ? AND level = 0)`,
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const sha of shas) {
      const u = sel.get(repoId, sha) as { id: number; title: string } | undefined;
      if (!u) continue;
      const text = truncateWords(redact(u.title), LIMITS.l0Words);
      n += Number(ins.run(u.id, JSON.stringify({ text }), now.toISOString(), u.id).changes);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}
