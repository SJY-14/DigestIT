import type { DatabaseSync } from 'node:sqlite';
import type { ExplanationStatus, FilteredReason, Level } from '@digestit/core';
import { PROMPT_VERSION, buildPrompt } from './prompt.js';
import type { AllLevels, ExplanationProvider } from './provider.js';
import { RepoNotAllowedError } from './config.js';
import { estimateTokens, prepareInput, type PrepareOptions, type PreparedInput, type RawChange } from './prepare.js';
import { checkLevels, type CheckResult } from './validate.js';

export interface Budget {
  /** Max provider calls in one run (retries count). */
  maxCalls: number;
  /** Max estimated input tokens sent in one run (retries count). */
  maxTokens: number;
}

export const DEFAULT_BUDGET: Budget = { maxCalls: 200, maxTokens: 2_000_000 };

export interface ExplainOptions {
  promptVersion?: string;
  prepare?: Partial<PrepareOptions>;
  now?: () => Date;
}

export type UnitOutcome = 'cached' | 'ok' | 'truncated' | 'error' | 'budget';

export interface UnitResult {
  changeUnitId: number;
  outcome: UnitOutcome;
  calls: number;
  detail?: string;
}

/** Shared, mutable call/token allowance for one run; reservations are synchronous so concurrent workers cannot overshoot. */
export class BudgetTracker {
  calls = 0;
  tokens = 0;
  constructor(readonly limit: Budget) {}
  tryReserve(tokens: number): boolean {
    if (this.calls + 1 > this.limit.maxCalls) return false;
    if (this.calls > 0 && this.tokens + tokens > this.limit.maxTokens) return false;
    this.calls++;
    this.tokens += tokens;
    return true;
  }
}

interface UnitRow { id: number; head_sha: string; title: string; repo_name: string; message: string | null }
interface FileRow {
  path: string; status: 'A' | 'M' | 'D' | 'R' | 'B'; additions: number; deletions: number;
  patch: string | null; filtered_reason: FilteredReason | null;
}

const EMPTY: AllLevels = {
  l0: { text: '' },
  l1: { userVisible: false, bullets: [] },
  l2: { items: [], notAnalysed: [] },
  l3: { annotations: [] },
};

export function loadChange(db: DatabaseSync, changeUnitId: number): RawChange | null {
  const u = db.prepare(
    `SELECT cu.id, cu.head_sha, cu.title, r.name AS repo_name, c.message
       FROM change_unit cu JOIN repo r ON r.id = cu.repo_id
       LEFT JOIN commit_ c ON c.sha = cu.head_sha
      WHERE cu.id = ?`,
  ).get(changeUnitId) as UnitRow | undefined;
  if (!u) return null;
  const files = db.prepare(
    `SELECT path, status, additions, deletions, patch, filtered_reason
       FROM file_change WHERE change_unit_id = ? ORDER BY path`,
  ).all(changeUnitId) as unknown as FileRow[];
  return {
    repoName: u.repo_name,
    title: u.title,
    message: u.message ?? u.title,
    files: files.map((f) => ({
      path: f.path, status: f.status, additions: f.additions, deletions: f.deletions,
      patch: f.patch, filteredReason: f.filtered_reason,
    })),
  };
}

function isCached(db: DatabaseSync, id: number, promptVersion: string, inputHash: string): boolean {
  const rows = db.prepare(
    `SELECT level, status, input_hash FROM explanation WHERE change_unit_id = ? AND prompt_version = ?`,
  ).all(id, promptVersion) as unknown as { level: number; status: string; input_hash: string }[];
  return rows.length === 4 && rows.every((r) => (r.status === 'ok' || r.status === 'truncated') && r.input_hash === inputHash);
}

function store(
  db: DatabaseSync, id: number, levels: AllLevels, status: ExplanationStatus,
  provider: { provider: string; model: string }, promptVersion: string, inputHash: string, at: string,
): void {
  const contents: [Level, unknown][] = [[0, levels.l0], [1, levels.l1], [2, levels.l2], [3, levels.l3]];
  const stmt = db.prepare(
    `INSERT INTO explanation (change_unit_id, level, content, status, provider, model, prompt_version, input_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (change_unit_id, level, prompt_version) DO UPDATE SET
       content = excluded.content, status = excluded.status, provider = excluded.provider,
       model = excluded.model, input_hash = excluded.input_hash, created_at = excluded.created_at`,
  );
  db.exec('BEGIN');
  try {
    for (const [level, content] of contents) {
      stmt.run(id, level, JSON.stringify(content), status, provider.provider, provider.model, promptVersion, inputHash, at);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Explains one change unit with a single provider call (plus at most one retry).
 * Valid output is stored `ok`. If the retry is still invalid, the sanitised
 * output is stored as `truncated`; if nothing usable came back, `error`.
 * A unit already explained at this prompt version with the same input hash makes no call.
 */
export async function explainUnit(
  db: DatabaseSync,
  provider: ExplanationProvider,
  changeUnitId: number,
  budget: BudgetTracker,
  options: ExplainOptions = {},
): Promise<UnitResult> {
  const promptVersion = options.promptVersion ?? PROMPT_VERSION;
  const raw = loadChange(db, changeUnitId);
  if (!raw) return { changeUnitId, outcome: 'error', calls: 0, detail: 'unknown change unit' };
  const prepared: PreparedInput = prepareInput(raw, options.prepare);
  if (isCached(db, changeUnitId, promptVersion, prepared.inputHash)) return { changeUnitId, outcome: 'cached', calls: 0 };

  let calls = 0;
  let best: CheckResult | null = null;
  let feedback: string[] | undefined;
  let lastError = '';
  let usedBy = { provider: provider.id, model: provider.model };
  for (let attempt = 0; attempt < 2; attempt++) {
    const input = feedback ? { ...prepared.input, retryFeedback: feedback } : prepared.input;
    if (!budget.tryReserve(estimateTokens(buildPrompt(input)))) {
      // Nothing stored for a unit that never ran; a partial one is stored below.
      if (calls === 0) return { changeUnitId, outcome: 'budget', calls };
      lastError ||= 'budget exhausted before retry';
      break;
    }
    calls++;
    try {
      const res = await provider.explain(input);
      usedBy = { provider: res.provider, model: res.model };
      const checked = checkLevels(res.levels, prepared.input.files);
      if (checked === null) {
        lastError = 'provider output has an unusable shape';
        feedback = [lastError];
      } else if (checked.violations.length === 0) {
        store(db, changeUnitId, checked.levels, 'ok', usedBy, promptVersion, prepared.inputHash, (options.now?.() ?? new Date()).toISOString());
        return { changeUnitId, outcome: 'ok', calls };
      } else {
        best = checked;
        feedback = checked.violations;
        lastError = checked.violations.join('; ');
      }
    } catch (e) {
      if (e instanceof RepoNotAllowedError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
      feedback = undefined;
    }
  }

  const at = (options.now?.() ?? new Date()).toISOString();
  if (best) {
    store(db, changeUnitId, best.levels, 'truncated', usedBy, promptVersion, prepared.inputHash, at);
    return { changeUnitId, outcome: 'truncated', calls, detail: lastError };
  }
  store(db, changeUnitId, EMPTY, 'error', usedBy, promptVersion, prepared.inputHash, at);
  return { changeUnitId, outcome: 'error', calls, detail: lastError };
}

export interface BackfillOptions extends ExplainOptions {
  concurrency?: number;
  budget?: Partial<Budget>;
  /** Restrict to these change unit ids (default: every change unit). */
  only?: number[];
  onResult?: (r: UnitResult) => void;
}

export interface BackfillSummary {
  total: number;
  cached: number;
  ok: number;
  truncated: number;
  error: number;
  /** Units not started because the budget cap was reached. */
  skippedByBudget: number;
  calls: number;
  estimatedTokens: number;
}

/** Change unit ids, oldest commit first. */
export function listUnitsOldestFirst(db: DatabaseSync): number[] {
  const rows = db.prepare(
    `SELECT cu.id FROM change_unit cu
       LEFT JOIN commit_ c ON c.sha = cu.head_sha
      WHERE cu.kind = 'commit'
      ORDER BY c.committed_at ASC, cu.id ASC`,
  ).all() as unknown as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * Backfills explanations oldest-first with a bounded worker pool. Units are
 * handed out in order; once the budget cap is hit no further units start.
 * Re-running is free: cached units make no provider call.
 */
export async function explainAll(
  db: DatabaseSync,
  provider: ExplanationProvider,
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const tracker = new BudgetTracker({
    maxCalls: options.budget?.maxCalls ?? DEFAULT_BUDGET.maxCalls,
    maxTokens: options.budget?.maxTokens ?? DEFAULT_BUDGET.maxTokens,
  });
  const all = listUnitsOldestFirst(db);
  const only = options.only ? new Set(options.only) : null;
  const ids = only ? all.filter((id) => only.has(id)) : all;
  const summary: BackfillSummary = { total: ids.length, cached: 0, ok: 0, truncated: 0, error: 0, skippedByBudget: 0, calls: 0, estimatedTokens: 0 };
  let next = 0;
  let stop: unknown = null;

  const worker = async (): Promise<void> => {
    while (stop === null && next < ids.length) {
      const id = ids[next++]!;
      try {
        const r = await explainUnit(db, provider, id, tracker, options);
        if (r.outcome === 'budget') summary.skippedByBudget++;
        else summary[r.outcome]++;
        options.onResult?.(r);
      } catch (e) {
        stop = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length || 1) }, worker));
  if (stop !== null) throw stop;
  summary.skippedByBudget += ids.length - next;
  summary.calls = tracker.calls;
  summary.estimatedTokens = tracker.tokens;
  return summary;
}
