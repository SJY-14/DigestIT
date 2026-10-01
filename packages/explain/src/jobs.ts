import type { DatabaseSync } from 'node:sqlite';
import type { CallTiming, Effort } from './provider.js';

/** `explain_job.kind` (migration 10; `memory` added by migration 12, DIG-103). */
export type ExplainJobKind = 'explain' | 'retry' | 'area' | 'context' | 'memory';

/**
 * A started job, handed to every part function of that job (docs/explain-speed.md, "Signatures
 * between DIG-74 and DIG-75"). The budget was already checked once, at `startJob`; a part
 * function logs its own calls against `jobId` and never checks the budget itself.
 */
export interface JobRef {
  jobId: number;
  budget: number;
  now?: () => Date;
}

export interface JobRefs {
  repoId?: number;
  changeUnitId?: number;
  areaId?: string;
}

const startOfLocalDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Jobs counted today: `explain_job` rows with at least one `ok`/`error` call today, plus legacy
 * `explain_call` rows with no `job_id` (pre-DIG-73 commit-history mode), each counted once — the
 * budget decision in docs/explain-speed.md ("one user action = one budget unit").
 */
export function budgetStatus(db: DatabaseSync, now: Date): number {
  const dayStart = startOfLocalDay(now).toISOString();
  const jobs = db.prepare(
    `SELECT count(*) AS n FROM (
       SELECT DISTINCT job_id FROM explain_call
        WHERE job_id IS NOT NULL AND outcome IN ('ok','error') AND at >= ?
     )`,
  ).get(dayStart) as { n: number };
  const legacy = db.prepare(
    `SELECT count(*) AS n FROM explain_call WHERE job_id IS NULL AND outcome IN ('ok','error') AND at >= ?`,
  ).get(dayStart) as { n: number };
  return jobs.n + legacy.n;
}

/** Background `memory`-kind jobs with at least one `ok`/`error` call today (docs/milestone-4-memory.md
 * §4): counted separately from `budgetStatus` (which this is a subset of) so the daily share can be
 * enforced on top of, not instead of, the shared 40-job budget. */
export function memoryJobsToday(db: DatabaseSync, now: Date): number {
  const dayStart = startOfLocalDay(now).toISOString();
  return (db.prepare(
    `SELECT count(*) AS n FROM (
       SELECT DISTINCT j.id FROM explain_job j JOIN explain_call c ON c.job_id = j.id
        WHERE j.kind = 'memory' AND c.outcome IN ('ok','error') AND c.at >= ?
     )`,
  ).get(dayStart) as { n: number }).n;
}

/**
 * The budget-share gate for a background `memory` job (docs/milestone-4-memory.md §4): today's
 * memory jobs must be under the daily `share` (0 turns memory jobs off entirely), and starting one
 * must still leave at least `reserve` of the shared daily budget for user actions. Checked before
 * `startJob`, which then does its own (looser) check against the full budget.
 */
export function canStartMemoryJob(db: DatabaseSync, now: Date, budgetLimit: number, share: number, reserve: number): boolean {
  if (share <= 0) return false;
  if (memoryJobsToday(db, now) >= share) return false;
  return budgetLimit - budgetStatus(db, now) >= reserve;
}

/**
 * Starts a job if today's budget allows one more; the check happens exactly once, here. Returns
 * `null` (and inserts no row) when the budget is already used up; a job that did start is never
 * cut off halfway.
 */
export function startJob(
  db: DatabaseSync, kind: ExplainJobKind, refs: JobRefs, budget: number, now: () => Date = () => new Date(),
): number | null {
  const at = now();
  if (budgetStatus(db, at) >= budget) return null;
  const row = db.prepare(
    `INSERT INTO explain_job (repo_id, change_unit_id, kind, area_id, started_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(refs.repoId ?? null, refs.changeUnitId ?? null, kind, refs.areaId ?? null, at.toISOString());
  return Number(row.lastInsertRowid);
}

export function finishJob(db: DatabaseSync, jobId: number, now: () => Date = () => new Date()): void {
  db.prepare(`UPDATE explain_job SET finished_at = ? WHERE id = ?`).run(now().toISOString(), jobId);
}

export interface JobCallLog {
  jobId: number;
  /** `summary`, `area:<id>`, `walkthrough:<id>` or `context` (docs/explain-speed.md §1). */
  part: string;
  changeUnitId: number | null;
  model: string;
  effort?: Effort;
  timing?: CallTiming;
  durationMs: number;
  outcome: 'ok' | 'error';
  /**
   * What the validator found for this attempt (DIG-94): hard violations, style warnings and
   * in-band length notes, joined with "; ", or the unusable-shape message. Unset when the call's
   * own outcome is `error` (no output to validate) or the output was clean.
   */
  violations?: string;
}

/** Logs one provider call with the DIG-73 timing columns, `job_id`/`part`, and the DIG-94 validation reason. */
export function logJobCall(
  db: DatabaseSync, at: Date, reason: 'digest' | 'area' | 'context' | 'memory', log: JobCallLog,
): void {
  db.prepare(
    `INSERT INTO explain_call
       (at, change_unit_id, reason, duration_ms, outcome, job_id, part, model, effort, startup_ms, ttft_ms, gen_ms, input_tokens, output_tokens, prompt_tokens, violations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    at.toISOString(), log.changeUnitId, reason, log.durationMs, log.outcome, log.jobId, log.part, log.model,
    log.effort ?? null,
    log.timing?.startupMs ?? null, log.timing?.ttftMs ?? null, log.timing?.genMs ?? null,
    log.timing?.inputTokens ?? null, log.timing?.outputTokens ?? null, log.timing?.promptTokens ?? null,
    log.violations ?? null,
  );
}

/** Records how long the job's no-LLM prep took (snapshot, checkpoint, digest row, areas). */
export function setPrepMs(db: DatabaseSync, jobId: number, prepMs: number): void {
  db.prepare('UPDATE explain_job SET prep_ms = ? WHERE id = ?').run(prepMs, jobId);
}

/**
 * Marks parts of a digest as `budget` when `startJob` refused the job: one `explain_call` row per
 * part (outcome `budget`, never counted by `budgetStatus`), so the part status reads back from the
 * DB alone, with no live job and after a restart.
 */
export function markPartsBudget(
  db: DatabaseSync, changeUnitId: number, parts: readonly string[], now: () => Date = () => new Date(),
): void {
  const at = now().toISOString();
  const ins = db.prepare(
    `INSERT INTO explain_call (at, change_unit_id, reason, duration_ms, outcome, part) VALUES (?, ?, ?, 0, 'budget', ?)`,
  );
  for (const part of parts) ins.run(at, changeUnitId, part === 'context' ? 'context' : 'digest', part);
}
