// Fast Explain (DIG-75, docs/explain-speed.md §5): the async job runner's contract with the
// explain package. `startJob`/`finishJob` are real: one `explain_job` row per user action, and the
// daily budget (docs/explain-speed.md "Budget decision") is checked once, here, when a job starts.
//
// `explainDigestSummary` and `explainDigestAreaText` are the DIG-74/DIG-75 seam described in the
// doc's "Signatures" table. DIG-74 owns splitting the digest into genuinely independent calls (its
// own prompt and validator per part, its own provider methods); until that lands, the schema has no
// per-area L2 storage to split into (`digest.areas` is only the deterministic skeleton), so
// `explainDigestSummary` makes the one call `explainDigest` already makes (L0+L1+L2 together, still
// logged with `explain_call.reason = 'digest'`) and `explainDigestAreaText` is a free, no-call read
// of that same result for one area. Both keep the signature DIG-74 will fill in with real per-area
// calls; nothing above them (the job runner, SSE, retry, restart recovery) needs to change then.
import type { DatabaseSync } from 'node:sqlite';
import type { AreaWalkthrough, DigestL2Content, ExplainLanguage } from '@digestit/core';
import { explainArea, type ExplainAreaOptions } from './area.js';
import { explainDigest, type ExplainDigestOptions } from './digest.js';
import type { ExplanationProvider } from './provider.js';

export type ExplainJobKind = 'explain' | 'retry' | 'area' | 'context';

export interface JobRef {
  jobId: number;
  /** Daily call cap; already spent deciding whether `startJob` could start this job. Parts never
   * re-check it themselves (docs/explain-speed.md "Budget decision": one job is one budget unit). */
  budget: number;
  now?: () => Date;
}

export type PartOutcome = { outcome: 'ok' | 'truncated' | 'error' | 'cached'; calls: number; detail?: string };

const startOfLocalDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Jobs that made at least one provider call today: distinct `job_id`s from `explain_call`, plus
 * pre-DIG-75 rows with no `job_id` (commit-history mode), each still counted as one (per the doc). */
function jobUnitsUsedToday(db: DatabaseSync, now: Date): number {
  const r = db.prepare(
    `SELECT
       (SELECT count(DISTINCT job_id) FROM explain_call WHERE job_id IS NOT NULL AND at >= ?) +
       (SELECT count(*) FROM explain_call WHERE job_id IS NULL AND at >= ? AND outcome IN ('ok','error')) AS n`,
  ).get(startOfLocalDay(now).toISOString(), startOfLocalDay(now).toISOString()) as { n: number };
  return r.n;
}

/**
 * Starts one `explain_job` row (one user action: an Explain, an area L3, a context refresh or a
 * digest retry) if today's budget allows one more. Returns `null` (no row written) when it does
 * not: the caller then makes no provider call at all for this action.
 */
export function startJob(
  db: DatabaseSync,
  kind: ExplainJobKind,
  refs: { repoId?: number; changeUnitId?: number; areaId?: string },
  budget: number,
  now: () => Date = () => new Date(),
): number | null {
  const at = now();
  if (jobUnitsUsedToday(db, at) >= budget) return null;
  return Number(
    db.prepare(
      `INSERT INTO explain_job (repo_id, change_unit_id, kind, area_id, started_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(refs.repoId ?? null, refs.changeUnitId ?? null, kind, refs.areaId ?? null, at.toISOString()).lastInsertRowid,
  );
}

export function finishJob(db: DatabaseSync, jobId: number, now: () => Date = () => new Date()): void {
  db.prepare('UPDATE explain_job SET finished_at = ? WHERE id = ?').run(now().toISOString(), jobId);
}

export function setPrepMs(db: DatabaseSync, jobId: number, prepMs: number): void {
  db.prepare('UPDATE explain_job SET prep_ms = ? WHERE id = ?').run(prepMs, jobId);
}

/**
 * Marks a set of parts as `budget` for a job that never got to run (the budget was already spent
 * when `startJob` decided it, or one part settled `budget` before this one started). One row per
 * part, so a restart can still read the right status back from the DB alone (no live job needed).
 */
export function markPartsBudget(db: DatabaseSync, changeUnitId: number, parts: readonly string[], now: () => Date = () => new Date()): void {
  const at = now().toISOString();
  const ins = db.prepare(`INSERT INTO explain_call (at, change_unit_id, reason, duration_ms, outcome, part) VALUES (?, ?, 'digest', 0, 'budget', ?)`);
  for (const part of parts) ins.run(at, changeUnitId, part);
}

export interface PartCallOptions {
  job: JobRef;
  context?: string;
  language?: ExplainLanguage;
}

/** See the file header: today this is the one combined L0+L1+L2 call; DIG-74 replaces the body
 * with a genuinely summary-only call, keeping this signature. */
export async function explainDigestSummary(
  db: DatabaseSync, changeUnitId: number, provider: ExplanationProvider, opts: PartCallOptions,
): Promise<PartOutcome> {
  const digestOpts: ExplainDigestOptions = {
    context: opts.context, language: opts.language, budget: Number.MAX_SAFE_INTEGER, now: opts.job.now,
  };
  const r = await explainDigest(db, changeUnitId, provider, digestOpts);
  return { outcome: r.outcome === 'budget' ? 'error' : r.outcome, calls: r.calls, detail: r.detail };
}

function loadDigestL2(db: DatabaseSync, changeUnitId: number): DigestL2Content | null {
  const row = db.prepare(
    `SELECT content, status FROM explanation WHERE change_unit_id = ? AND level = 2
     ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`,
  ).get(changeUnitId) as { content: string; status: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.content) as DigestL2Content;
  } catch {
    return null;
  }
}

/** See the file header: today this is a free read of the area's slice of `explainDigestSummary`'s
 * combined result (the schema has no per-area L2 storage yet to make a separate call against); the
 * caller only calls this once `summary` has settled. DIG-74 replaces the body with a genuinely
 * independent, separately callable area-text call, keeping this signature. */
export async function explainDigestAreaText(
  db: DatabaseSync, changeUnitId: number, areaId: string, _provider: ExplanationProvider, _opts: PartCallOptions,
): Promise<PartOutcome> {
  const l2 = loadDigestL2(db, changeUnitId);
  if (!l2 || !l2.items.some((it) => it.id === areaId)) {
    return { outcome: 'error', calls: 0, detail: 'area not produced by the summary call' };
  }
  return { outcome: 'cached', calls: 0 };
}

/**
 * L3 walkthrough of one area: already a genuinely independent, per-area provider call
 * (`explainArea`, DIG-37/48) with its own storage and retry, so this is a thin wrapper, not a
 * bridge. `onProgress` is called once, with the final result, since the provider does not stream
 * partial steps yet (DIG-74); once it does, `explainArea` itself can call it as steps arrive and
 * this wrapper needs no change.
 */
export async function explainAreaWalkthrough(
  db: DatabaseSync, changeUnitId: number, areaId: string, provider: ExplanationProvider,
  opts: PartCallOptions & { onProgress?: (e: { areaId: string; overview: string | null; steps: AreaWalkthrough['steps']; done: boolean }) => void },
): Promise<PartOutcome> {
  const areaOpts: ExplainAreaOptions = {
    context: opts.context, language: opts.language, budget: Number.MAX_SAFE_INTEGER, now: opts.job.now,
  };
  const r = await explainArea(db, changeUnitId, areaId, provider, areaOpts);
  const outcome: PartOutcome = { outcome: r.outcome === 'budget' ? 'error' : r.outcome, calls: r.calls, detail: r.detail };
  if (opts.onProgress) {
    const row = db.prepare(
      `SELECT content FROM area_explanation WHERE change_unit_id = ? AND area_id = ? ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`,
    ).get(changeUnitId, areaId) as { content: string } | undefined;
    const content = row ? (JSON.parse(row.content) as AreaWalkthrough) : { overview: '', steps: [], check: [] };
    opts.onProgress({ areaId, overview: content.overview || null, steps: content.steps, done: true });
  }
  return outcome;
}
