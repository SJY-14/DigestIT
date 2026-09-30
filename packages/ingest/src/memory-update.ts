// The async entry point (`digest memory update`, and later DIG-103's MemoryWorker triggers):
// builds a `TreeReader` over the project's latest checkpoint in the shadow store -- never the
// project folder -- and reconciles the deterministic extraction, the context `.md` notes and the
// threads against the store, all inside one batch. No LLM call anywhere in this module.
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryTrigger } from '@digestit/core';
import { projectDataDir } from './datahome.js';
import { createBatch, finishBatch, getMemoryItem, listMemoryItems, markStale, upsertMemoryItem } from './memory.js';
import { extractProjectMemory, langOf, type TreeReader } from './memory-extract.js';
import { updateContextNotes } from './memory-context.js';
import { updateThreads } from './memory-threads.js';
import type { ProjectRow } from './project.js';
import { ensureCheckpoint } from './project.js';
import { listTree, openShadow, readTreeFile, type Shadow } from './shadow.js';
import { loadWorkspacePrefixes } from './workspace.js';

const MAX_PROVENANCE_FILES = 20;

/** Prefetches only what `extractProjectMemory` can ever read: every file in a language it parses,
 * plus `README.md`/`package.json` at every directory level (cheap to over-fetch a few of these; far
 * cheaper than reading the whole tree, which would include binary and generated files). */
async function buildTreeReader(shadow: Shadow, treeSha: string, paths: readonly string[]): Promise<TreeReader> {
  const wanted = paths.filter((p) => {
    if (langOf(p) !== null) return true;
    const base = p.slice(p.lastIndexOf('/') + 1);
    return base === 'README.md' || base === 'package.json';
  });
  const contents = new Map<string, string | null>();
  await Promise.all(wanted.map(async (p) => {
    contents.set(p, await readTreeFile(shadow, treeSha, p));
  }));
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
 * One deterministic memory update: re-extracts every area and term from the latest checkpoint,
 * skipping an area whose content did not change (so only areas with changed files ever get a new
 * revision), syncs the context `.md` into notes, and rebuilds threads from stored digests. Requires
 * at least one checkpoint (`digest init`); never makes a provider call.
 */
export async function updateProjectMemory(
  db: DatabaseSync, home: string, project: ProjectRow, trigger: MemoryTrigger = 'manual', now: () => Date = () => new Date(),
): Promise<MemoryUpdateCounts> {
  const checkpoint = await ensureCheckpoint(db, home, project, 'manual', now);
  const shadow = await openShadow(projectDataDir(home, project.id), project.path);
  const paths = await listTree(shadow, checkpoint.treeSha);
  const workspacePrefixes = loadWorkspacePrefixes(project.path);
  const reader = await buildTreeReader(shadow, checkpoint.treeSha, paths);
  const extracted = extractProjectMemory(reader, { workspacePrefixes });

  const batchId = createBatch(db, project.id, trigger, checkpoint.id, now);

  let areasChanged = 0;
  for (const { path, content, files } of extracted.areas) {
    const existing = getMemoryItem(db, project.id, 'area', path, null);
    if (existing?.status === 'hidden') continue; // never revived by the extractor
    if (existing?.status === 'active' && sameContent(existing.content, content)) continue; // unchanged: no churn
    upsertMemoryItem(db, batchId, project.id, 'area', path, null, content, 'code', {
      files: [...files].sort().slice(0, MAX_PROVENANCE_FILES), checkpointId: checkpoint.id, digestIds: [], jobId: null,
    }, now);
    areasChanged++;
  }
  const liveAreaKeys = new Set(extracted.areas.map((a) => a.path));
  let areasStale = 0;
  for (const existing of listMemoryItems(db, project.id, { kind: 'area' })) {
    if (existing.status === 'hidden' || existing.status === 'stale') continue;
    if (!liveAreaKeys.has(existing.key)) { markStale(db, batchId, existing.id, now); areasStale++; }
  }

  let termsChanged = 0;
  for (const term of extracted.terms) {
    const existing = getMemoryItem(db, project.id, 'term', term.term, null);
    if (existing?.status === 'hidden') continue;
    if (existing?.status === 'active' && sameContent(existing.content, term)) continue;
    const files = term.definedAt ? [term.definedAt.file] : [];
    upsertMemoryItem(db, batchId, project.id, 'term', term.term, null, term, 'code', {
      files, checkpointId: checkpoint.id, digestIds: [], jobId: null,
    }, now);
    termsChanged++;
  }
  const liveTermKeys = new Set(extracted.terms.map((t) => t.term));
  let termsStale = 0;
  for (const existing of listMemoryItems(db, project.id, { kind: 'term' })) {
    if (existing.status === 'hidden' || existing.status === 'stale') continue;
    if (!liveTermKeys.has(existing.key)) { markStale(db, batchId, existing.id, now); termsStale++; }
  }

  const notesChanged = updateContextNotes(db, batchId, project, now);

  const activeTermNames = new Set([
    ...liveTermKeys,
    ...listMemoryItems(db, project.id, { kind: 'term', status: 'active' }).map((t) => t.key),
  ]);
  const threadsChanged = updateThreads(db, batchId, project.id, activeTermNames, now);

  finishBatch(db, batchId, 0, now);
  return { batchId, areasChanged, areasStale, termsChanged, termsStale, notesChanged, threadsChanged };
}
