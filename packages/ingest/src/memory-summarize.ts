// Background LLM summaries for areas and threads (docs/milestone-4-memory.md §4, DIG-103): the
// `memory` provider task. One call plus at most one retry per batch -- the same loop shape as every
// other Fast Explain task -- logged against a `memory`-kind `explain_job` with `explain_call.part =
// 'memory'`, and its store writes against their own `memory_batch` (trigger `idle`/`daily`/`manual`,
// same as every other memory write -- `explain_job`/`memory_batch` are separate units for separate
// things: one LLM-budget job, one memory-store change). `memory-tasks.ts` (DIG-101) only builds and
// validates the prompt; deciding when to call it and running the retry loop is this module's job.
import type { DatabaseSync } from 'node:sqlite';
import type { AreaMemory, ExplainLanguage, MemoryItem, MemoryTrigger, TermMemory, ThreadMemory } from '@digestit/core';
import {
  callReasons, checkAreaSummaries, checkThreadSummary, logJobCall, MEMORY_TASK_LIMITS,
  type ExplanationProvider, type JobRef, type MemoryAreaSummaryRequest, type MemorySummarizeAreasInput,
  type MemorySummarizeThreadInput,
} from '@digestit/explain';
import { createBatch, finishBatch, getMemoryItemById, listMemoryItems, upsertMemoryItem } from './memory.js';
import type { ProjectRow } from './project.js';

/** The content as it stood at the last revision an actual summarization call wrote (`provenance.
 * jobId` set), or `null` when the item has never been summarised. Not simply "the last `source:
 * summary` revision": memory-update.ts's code-only re-extraction carries a summary forward and
 * keeps `source: 'summary'` on the item (so it is not wiped by a later code change), but writes its
 * own revision with `provenance.jobId: null` -- that revision is not itself a summarization, so it
 * must not look like the fingerprint was just confirmed. `AreaMemory`/`ThreadMemory` have no field
 * of their own for "the fingerprint last summarised" (docs/milestone-4-memory.md §1), so this reads
 * it back from `memory_revision` instead of adding one to the shared contract. */
function lastSummaryContent(db: DatabaseSync, itemId: number): AreaMemory | ThreadMemory | null {
  const row = db.prepare(
    `SELECT content FROM memory_revision WHERE item_id = ? AND source = 'summary' AND json_extract(provenance, '$.jobId') IS NOT NULL
     ORDER BY version DESC LIMIT 1`,
  ).get(itemId) as { content: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.content) as AreaMemory | ThreadMemory;
  } catch {
    return null;
  }
}

const threadFingerprint = (c: ThreadMemory): string => c.digests.map((d) => d.digestId).join(',');

/** Areas due for a summary (docs/milestone-4-memory.md §2): no summary yet, or the area's own
 * fingerprint moved since the last one was written. Most recently touched first. */
export function areasNeedingSummary(db: DatabaseSync, repoId: number): MemoryItem[] {
  const areas = listMemoryItems(db, repoId, { kind: 'area', status: 'active' });
  const due = areas.filter((it) => {
    const c = it.content as AreaMemory;
    if (c.summary === null) return true;
    const last = lastSummaryContent(db, it.id) as AreaMemory | null;
    return last === null || last.fingerprint !== c.fingerprint;
  });
  return due.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Threads due for a summary: no summary yet, or a digest joined/left since the last one. */
export function threadsNeedingSummary(db: DatabaseSync, repoId: number): MemoryItem[] {
  const threads = listMemoryItems(db, repoId, { kind: 'thread', status: 'active' });
  const due = threads.filter((it) => {
    const c = it.content as ThreadMemory;
    if (c.summary === null) return true;
    const last = lastSummaryContent(db, it.id) as ThreadMemory | null;
    return last === null || threadFingerprint(last) !== threadFingerprint(c);
  });
  return due.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type SummaryWork = { kind: 'areas'; items: MemoryItem[] } | { kind: 'thread'; item: MemoryItem };

/** One unit of background summary work (docs/milestone-4-memory.md §4): up to 4 due areas, else one
 * due thread, else nothing to do. Areas come first since a thread summary reads better once its
 * areas already have one, and there are usually many more areas than threads. */
export function pickSummaryWork(db: DatabaseSync, repoId: number): SummaryWork | null {
  const areas = areasNeedingSummary(db, repoId).slice(0, MEMORY_TASK_LIMITS.areasPerCall);
  if (areas.length > 0) return { kind: 'areas', items: areas };
  const [thread] = threadsNeedingSummary(db, repoId);
  return thread ? { kind: 'thread', item: thread } : null;
}

function areaTermsNeedingMeaning(db: DatabaseSync, repoId: number, areaPath: string): string[] {
  return listMemoryItems(db, repoId, { kind: 'term', status: 'active' })
    .filter((it) => {
      const c = it.content as TermMemory;
      return c.meaning === null && c.areas.includes(areaPath);
    })
    .slice(0, MEMORY_TASK_LIMITS.termsPerArea)
    .map((it) => (it.content as TermMemory).term);
}

export interface SummaryBatchResult {
  outcome: 'ok' | 'error';
  calls: number;
  itemsUpdated: number;
  detail?: string;
}

/** Runs the `summarizeAreas` call (one attempt plus at most one retry) and writes every usable
 * result back to the store as `source: 'summary'`; an area the reply dropped (malformed, or the
 * model declined) is left as it was and stays queued for the next batch. Areas (like the
 * deterministic extractor writes them, memory-update.ts) are stored under `language: null` --
 * summary text is in `project.language`, but the item's identity does not fork per language. */
export async function runAreaSummaryBatch(
  db: DatabaseSync, project: ProjectRow, provider: ExplanationProvider, items: readonly MemoryItem[], job: JobRef,
  trigger: MemoryTrigger, now: () => Date = () => new Date(),
): Promise<SummaryBatchResult> {
  if (!provider.summarizeAreas) return { outcome: 'error', calls: 0, itemsUpdated: 0, detail: `provider ${provider.id} does not support the memory task` };
  const language: ExplainLanguage = project.language;
  const byPath = new Map(items.map((it) => [it.key, it]));
  const areas: MemoryAreaSummaryRequest[] = items.map((it) => {
    const c = it.content as AreaMemory;
    return {
      path: it.key, fileCount: c.fileCount, exports: c.exports.map((e) => e.name), uses: c.uses, usedBy: c.usedBy,
      doc: c.doc, terms: areaTermsNeedingMeaning(db, project.id, it.key),
    };
  });

  const writeResults = (checked: { areas: { path: string; summary: string; terms: { term: string; meaning: string }[] }[] }): number => {
    let batchId: number | null = null;
    let itemsUpdated = 0;
    for (const out of checked.areas) {
      const sent = byPath.get(out.path);
      if (!sent) continue;
      // The call ran without the store lock: an area re-extracted, hidden, rolled back or cleared
      // meanwhile drops its result (docs/milestone-4-memory.md §2) instead of writing the pre-call
      // content back over it. It stays due and gets summarised again from its new state.
      const item = getMemoryItemById(db, sent.id);
      if (!item || item.status !== 'active' || (item.content as AreaMemory).fingerprint !== (sent.content as AreaMemory).fingerprint) continue;
      batchId ??= createBatch(db, project.id, trigger, null, now);
      const c = item.content as AreaMemory;
      const merged: AreaMemory = { ...c, summary: out.summary };
      upsertMemoryItem(db, batchId, project.id, 'area', out.path, null, merged, 'summary', { ...item.provenance, jobId: job.jobId }, now);
      itemsUpdated++;
      // Term meanings the reply grounded, as their own upsert: a meaning then survives its area
      // being re-extracted later (memory-update.ts carries a term's own content across a code-only
      // update, independent of its area's).
      for (const t of out.terms) {
        const termItem = listMemoryItems(db, project.id, { kind: 'term' }).find((it) => it.key === t.term);
        if (!termItem || termItem.status === 'hidden' || termItem.source === 'user') continue;
        const tc = termItem.content as TermMemory;
        if (tc.meaning !== null) continue;
        upsertMemoryItem(db, batchId, project.id, 'term', t.term, null, { ...tc, meaning: t.meaning }, 'summary', { ...termItem.provenance, jobId: job.jobId }, now);
      }
    }
    if (batchId !== null) finishBatch(db, batchId, 0, now);
    return itemsUpdated;
  };

  let feedback: string[] | undefined;
  let calls = 0;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const input: MemorySummarizeAreasInput = { repoName: project.name, areas, language, retryFeedback: feedback };
    calls++;
    const at = now();
    try {
      const res = await provider.summarizeAreas(input);
      const checked = checkAreaSummaries(res, input, language);
      logJobCall(db, at, 'memory', {
        jobId: job.jobId, part: 'memory', changeUnitId: null, model: res.model,
        durationMs: now().getTime() - at.getTime(), outcome: 'ok',
        violations: callReasons(checked && { ...checked, lengthNotes: [] }),
      });
      if (checked === null) {
        lastError = 'provider output has an unusable shape';
        feedback = [lastError];
        continue;
      }
      if (checked.violations.length === 0 || attempt === 1) {
        const itemsUpdated = writeResults(checked);
        return { outcome: itemsUpdated > 0 ? 'ok' : 'error', calls, itemsUpdated, detail: itemsUpdated > 0 ? undefined : checked.violations.join('; ') };
      }
      feedback = [...checked.violations, ...checked.styleWarnings];
      lastError = feedback.join('; ');
    } catch (e) {
      logJobCall(db, at, 'memory', {
        jobId: job.jobId, part: 'memory', changeUnitId: null, model: provider.model,
        durationMs: now().getTime() - at.getTime(), outcome: 'error',
      });
      lastError = e instanceof Error ? e.message : String(e);
      feedback = undefined;
    }
  }
  return { outcome: 'error', calls, itemsUpdated: 0, detail: lastError };
}

/** Runs the `summarizeThread` call (one attempt plus at most one retry) for one thread. Written
 * back under the thread item's own existing `language` (set when its first digest joined it,
 * memory-threads.ts), never `project.language` -- the two usually agree, but the item's identity
 * must match exactly or this forks a second copy of the same thread. */
export async function runThreadSummaryBatch(
  db: DatabaseSync, project: ProjectRow, provider: ExplanationProvider, item: MemoryItem, job: JobRef,
  trigger: MemoryTrigger, now: () => Date = () => new Date(),
): Promise<SummaryBatchResult> {
  if (!provider.summarizeThread) return { outcome: 'error', calls: 0, itemsUpdated: 0, detail: `provider ${provider.id} does not support the memory task` };
  const language: ExplainLanguage = item.language ?? project.language;
  const c = item.content as ThreadMemory;

  /** False when the thread changed during the call (a digest joined, it closed, was hidden or
   * cleared): the result is dropped, same rule as for areas above. */
  const write = (summary: string): boolean => {
    const current = getMemoryItemById(db, item.id);
    if (!current || current.status !== 'active' || threadFingerprint(current.content as ThreadMemory) !== threadFingerprint(c)) return false;
    const batchId = createBatch(db, project.id, trigger, null, now);
    const merged: ThreadMemory = { ...(current.content as ThreadMemory), summary };
    upsertMemoryItem(db, batchId, project.id, 'thread', current.key, current.language, merged, 'summary', { ...current.provenance, jobId: job.jobId }, now);
    finishBatch(db, batchId, 0, now);
    return true;
  };
  const dropped: SummaryBatchResult = { outcome: 'error', calls: 0, itemsUpdated: 0, detail: 'thread changed during the call' };

  let feedback: string[] | undefined;
  let calls = 0;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const input: MemorySummarizeThreadInput = {
      repoName: project.name, title: c.title, areas: c.areas, terms: c.terms,
      digests: c.digests.map((d) => ({ at: d.at, l0: d.l0 })), language, retryFeedback: feedback,
    };
    calls++;
    const at = now();
    try {
      const res = await provider.summarizeThread(input);
      const checked = checkThreadSummary(res, language);
      logJobCall(db, at, 'memory', {
        jobId: job.jobId, part: 'memory', changeUnitId: null, model: res.model,
        durationMs: now().getTime() - at.getTime(), outcome: 'ok',
        violations: callReasons(checked && { ...checked, lengthNotes: [] }),
      });
      if (checked === null) {
        lastError = 'provider output has an unusable shape';
        feedback = [lastError];
        continue;
      }
      if (checked.violations.length === 0 || (attempt === 1 && checked.summary !== '')) {
        return write(checked.summary) ? { outcome: 'ok', calls, itemsUpdated: 1 } : { ...dropped, calls };
      }
      if (attempt === 1) {
        return { outcome: 'error', calls, itemsUpdated: 0, detail: checked.violations.join('; ') };
      }
      feedback = [...checked.violations, ...checked.styleWarnings];
      lastError = feedback.join('; ');
    } catch (e) {
      logJobCall(db, at, 'memory', {
        jobId: job.jobId, part: 'memory', changeUnitId: null, model: provider.model,
        durationMs: now().getTime() - at.getTime(), outcome: 'error',
      });
      lastError = e instanceof Error ? e.message : String(e);
      feedback = undefined;
    }
  }
  return { outcome: 'error', calls, itemsUpdated: 0, detail: lastError };
}
