// The async entry point (`digest memory update`, and later DIG-103's MemoryWorker triggers):
// builds a `TreeReader` over the project's latest checkpoint in the shadow store -- never the
// project folder -- and reconciles the deterministic extraction, the context `.md` notes and the
// threads against the store, all inside one batch. No LLM call anywhere in this module.
//
// This never advances the checkpoint itself: the latest checkpoint is the state the *next* Explain
// diffs from, so minting a new one here would silently fold the user's pending changes into
// whatever memory extracted, and they would never appear in a digest.
import type { DatabaseSync } from 'node:sqlite';
import type { AreaMemory, MemorySource, MemoryTrigger, TermMemory } from '@digestit/core';
import { projectDataDir } from './datahome.js';
import { createBatch, finishBatch, getMemoryItem, listMemoryItems, markStale, upsertMemoryItem } from './memory.js';
import { extractProjectMemory, langOf, type TreeReader } from './memory-extract.js';
import { updateContextNotes } from './memory-context.js';
import { updateThreads } from './memory-threads.js';
import { latestCheckpoint, type ProjectRow } from './project.js';
import { listTree, openShadow, readTreeFile, type Shadow } from './shadow.js';
import { parseWorkspacePrefixes } from './workspace.js';

const MAX_PROVENANCE_FILES = 20;
/** `readTreeFile` shells out to `git cat-file blob` once per call; a bounded pool keeps a project
 * with thousands of source files from opening that many processes/FDs at once. */
const PREFETCH_CONCURRENCY = 16;

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Every path `extractProjectMemory` can ever read: files in a language it parses, `README.md`/
 * `package.json` at any directory level, and the workspace manifest at the root. */
function wantedPaths(paths: readonly string[]): string[] {
  const wanted = paths.filter((p) => {
    if (langOf(p) !== null) return true;
    const base = p.slice(p.lastIndexOf('/') + 1);
    return base === 'README.md' || base === 'package.json';
  });
  if (paths.includes('pnpm-workspace.yaml')) wanted.push('pnpm-workspace.yaml');
  return wanted;
}

async function buildTreeReader(shadow: Shadow, treeSha: string, paths: readonly string[]): Promise<TreeReader> {
  const wanted = wantedPaths(paths);
  const contents = new Map<string, string | null>();
  await mapPool(wanted, PREFETCH_CONCURRENCY, async (p) => {
    contents.set(p, await readTreeFile(shadow, treeSha, p));
  });
  return { paths, read: (p) => contents.get(p) ?? null };
}

export interface MemoryUpdateCounts {
  batchId: number;
  areasChanged: number;
  areasStale: number;
  termsChanged: number;
  termsStale: number;
  notesChanged: number;
  threadsChanged: number;
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One deterministic memory update: re-extracts every area and term from the latest checkpoint --
 * never minting a new one -- skipping an area whose content did not change (so only areas with
 * changed files ever get a new revision), syncs the context `.md` into notes, and rebuilds threads
 * from stored digests. Requires at least one checkpoint (`digest init`); never makes a provider
 * call. The store writes are one transaction: a batch is the unit of rollback, so it must land or
 * fail as a whole.
 */
export async function updateProjectMemory(
  db: DatabaseSync, home: string, project: ProjectRow, trigger: MemoryTrigger = 'manual', now: () => Date = () => new Date(),
): Promise<MemoryUpdateCounts> {
  const checkpoint = latestCheckpoint(db, project.id);
  if (!checkpoint) throw new Error(`project ${project.id} has no checkpoints; run \`digest init\` first`);
  const shadow = await openShadow(projectDataDir(home, project.id), project.path);
  const paths = await listTree(shadow, checkpoint.treeSha);
  const reader = await buildTreeReader(shadow, checkpoint.treeSha, paths);
  const workspacePrefixes = parseWorkspacePrefixes(reader.read('pnpm-workspace.yaml') ?? '');
  const extracted = extractProjectMemory(reader, { workspacePrefixes });

  db.exec('BEGIN');
  let counts: MemoryUpdateCounts;
  try {
    const batchId = createBatch(db, project.id, trigger, checkpoint.id, now);

    let areasChanged = 0;
    for (const { path, content, files } of extracted.areas) {
      const existing = getMemoryItem(db, project.id, 'area', path, null);
      if (existing?.status === 'hidden' || existing?.source === 'user') continue; // never touched by the extractor
      // A background summary (DIG-103) is orthogonal to code extraction: carry it over instead of
      // silently wiping it (and downgrading `source` back to `code`) on the next code-only update.
      const wasSummarised = existing?.source === 'summary';
      const merged: AreaMemory = wasSummarised ? { ...content, summary: (existing!.content as AreaMemory).summary } : content;
      const source: MemorySource = wasSummarised ? 'summary' : 'code';
      if (existing?.status === 'active' && sameContent(existing.content, merged)) continue; // unchanged: no churn
      upsertMemoryItem(db, batchId, project.id, 'area', path, null, merged, source, {
        files: [...files].sort().slice(0, MAX_PROVENANCE_FILES), checkpointId: checkpoint.id, digestIds: [], jobId: null,
      }, now);
      areasChanged++;
    }
    const liveAreaKeys = new Set(extracted.areas.map((a) => a.path));
    let areasStale = 0;
    for (const existing of listMemoryItems(db, project.id, { kind: 'area' })) {
      if (existing.status === 'hidden' || existing.status === 'stale' || existing.source === 'user') continue;
      if (!liveAreaKeys.has(existing.key)) { markStale(db, batchId, existing.id, now); areasStale++; }
    }

    let termsChanged = 0;
    for (const term of extracted.terms) {
      const existing = getMemoryItem(db, project.id, 'term', term.term, null);
      if (existing?.status === 'hidden' || existing?.source === 'user') continue;
      const wasSummarised = existing?.source === 'summary';
      const merged: TermMemory = wasSummarised ? { ...term, meaning: (existing!.content as TermMemory).meaning } : term;
      const source: MemorySource = wasSummarised ? 'summary' : 'code';
      if (existing?.status === 'active' && sameContent(existing.content, merged)) continue;
      const files = merged.definedAt ? [merged.definedAt.file] : [];
      upsertMemoryItem(db, batchId, project.id, 'term', term.term, null, merged, source, {
        files, checkpointId: checkpoint.id, digestIds: [], jobId: null,
      }, now);
      termsChanged++;
    }
    const liveTermKeys = new Set(extracted.terms.map((t) => t.term));
    let termsStale = 0;
    for (const existing of listMemoryItems(db, project.id, { kind: 'term' })) {
      if (existing.status === 'hidden' || existing.status === 'stale' || existing.source === 'user') continue;
      if (!liveTermKeys.has(existing.key)) { markStale(db, batchId, existing.id, now); termsStale++; }
    }

    const notesChanged = updateContextNotes(db, batchId, project, now);

    const activeTermNames = new Set([
      ...liveTermKeys,
      ...listMemoryItems(db, project.id, { kind: 'term', status: 'active' }).map((t) => t.key),
    ]);
    const threadsChanged = updateThreads(db, batchId, project.id, activeTermNames, now);

    finishBatch(db, batchId, 0, now);
    counts = { batchId, areasChanged, areasStale, termsChanged, termsStale, notesChanged, threadsChanged };
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return counts;
}
