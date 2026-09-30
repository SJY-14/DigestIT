// Project memory (Milestone 4, DIG-97): what DigestIT keeps about a project between digests.
// Design: docs/milestone-4-memory.md. These shapes are the contract between the store and
// extractor (ingest), retrieval and prompts (explain), the API (server) and the page (web).
// The Board decisions D1–D3 change defaults and caps, not these shapes.
import type { ExplainLanguage } from './v2.js';

/** `area`: one folder or workspace package. `term`: a project identifier or word. `thread`: a line
 * of work across digests. `note`: a fact from the user (context `.md` or a correction). */
export type MemoryKind = 'area' | 'term' | 'thread' | 'note';

/** Where an item came from. User facts outrank everything else; `summary` is the only source
 * that costs a background LLM call. `code`: deterministic extraction from a checkpoint.
 * `digest`: derived from stored digest explanations, with no new call. */
export type MemorySource = 'user' | 'code' | 'digest' | 'summary';

/** `stale`: its files changed or went away since it was confirmed; never sent to a prompt.
 * `hidden`: deleted by the user; the extractor does not bring it back until the user restores it. */
export type MemoryStatus = 'active' | 'stale' | 'hidden';

export interface MemoryProvenance {
  /** Project-relative paths the item was read from (≤ 20). */
  files: string[];
  checkpointId: number | null;
  /** `change_unit_id`s of the digests it was derived from. */
  digestIds: number[];
  /** The background job that wrote it, for `summary` items. */
  jobId: number | null;
}

export interface MemorySymbol {
  name: string;
  kind: 'function' | 'class' | 'type' | 'const' | 'other';
  file: string;
  line: number;
}

export interface AreaMemory {
  kind: 'area';
  /** Folder or package path, `''` for the project root. */
  path: string;
  fileCount: number;
  /** Exported symbols, most-imported first (≤ MEMORY_LIMITS.symbolsPerArea). */
  exports: MemorySymbol[];
  /** Area keys this area imports from, and those importing it. */
  uses: string[];
  usedBy: string[];
  /** The folder README's first paragraph or the main file's leading doc comment, redacted. */
  doc: string | null;
  /** Background LLM summary (source `summary`), in `language`; null until one is written. */
  summary: string | null;
  /** Hash of exports + uses + doc; a summary written for another fingerprint is stale. */
  fingerprint: string;
}

export interface TermMemory {
  kind: 'term';
  term: string;
  definedAt: { file: string; line: number } | null;
  /** From the doc comment (`code`), the user (`user`) or a summary (`summary`); null when unknown. */
  meaning: string | null;
  /** Areas where it appears; used for retrieval. */
  areas: string[];
}

export interface ThreadDigestRef {
  digestId: number;
  seq: number;
  at: string;
  /** The digest's stored L0 line. */
  l0: string;
}

export interface ThreadMemory {
  kind: 'thread';
  /** The first digest's L0 until a summary replaces it. */
  title: string;
  areas: string[];
  terms: string[];
  digests: ThreadDigestRef[];
  state: 'open' | 'closed';
  summary: string | null;
}

export interface NoteMemory {
  kind: 'note';
  text: string;
  /** The item this note corrects, if any; a note with a target replaces that item's text in prompts. */
  target: { kind: Exclude<MemoryKind, 'note'>; key: string } | null;
  origin: 'context-md' | 'correction';
}

export type MemoryContent = AreaMemory | TermMemory | ThreadMemory | NoteMemory;

export interface MemoryItem {
  id: number;
  repoId: number;
  kind: MemoryKind;
  /** Unique per (repo, kind, language): area path, term, thread id, or note id. */
  key: string;
  /** Language of the prose fields; null when the item has none (e.g. an area with no summary). */
  language: ExplainLanguage | null;
  content: MemoryContent;
  source: MemorySource;
  status: MemoryStatus;
  pinned: boolean;
  provenance: MemoryProvenance;
  /** When the item was last checked against its source (re-extracted, re-derived or edited). */
  confirmedAt: string;
  updatedAt: string;
  /** Increases on every change; `memory_revision` keeps each version for rollback. */
  version: number;
}

/** What triggered a memory update batch; one batch is the unit of rollback. */
export type MemoryTrigger = 'init' | 'after-explain' | 'idle' | 'daily' | 'manual' | 'user' | 'rollback';

export interface MemoryBatch {
  id: number;
  repoId: number;
  trigger: MemoryTrigger;
  checkpointId: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** Items created, updated, marked stale or hidden. */
  changed: number;
  /** Provider calls made (0 for deterministic batches). */
  calls: number;
  rolledBack: boolean;
}

/** One prompt's memory slice: what retrieval picked and what it left out for the token budget. */
export interface MemorySlice {
  items: { id: number; version: number }[];
  /** The `<memory>` text sent, already redacted. */
  text: string;
  tokens: number;
  droppedForBudget: number;
}

export const MEMORY_LIMITS = {
  areas: 80,
  symbolsPerArea: 30,
  terms: 300,
  openThreads: 20,
  /** A thread with no new digest for this many days closes. */
  threadIdleDays: 14,
  docChars: 400,
  noteChars: 2_000,
  /** Token budget of the `<memory>` block per prompt kind (docs/milestone-4-memory.md §3). */
  sliceTokens: { summary: 1_500, area: 1_200, walkthrough: 800 },
  /** Stale items are dropped after this many days; hidden and user items are never dropped. */
  staleDropDays: 30,
} as const;

// ---- API DTOs ----

export interface MemoryItemDto {
  id: number;
  kind: MemoryKind;
  key: string;
  language: ExplainLanguage | null;
  content: MemoryContent;
  source: MemorySource;
  status: MemoryStatus;
  pinned: boolean;
  provenance: MemoryProvenance;
  confirmedAt: string;
  updatedAt: string;
  version: number;
  /** Distinct digests whose prompts used any version of this item (docs/ux/decision-4-memory.md
   * change 1); unlike a prompt count, this is never inflated or reset by re-extraction. */
  usedInDigests: number;
  /** Set when a user note overrides this item. */
  overriddenBy: number | null;
}

/** `GET /api/digests/:id/memory-used` (docs/ux/decision-4-memory.md change 2): what one digest's
 * prompts actually drew from the memory store, for its "what DigestIT used" view. */
export interface MemoryUsedItemDto extends MemoryItemDto {
  /** The item's version as it stood when this digest's prompts used it; may be behind `version`. */
  usedVersion: number;
  /** Deduplicated: every walkthrough step of one area collapses to one `area` tag. */
  usedFor: { part: 'summary' | 'area' | 'walkthrough'; area: string | null }[];
}

export interface MemoryUsedDto {
  digestId: number;
  items: MemoryUsedItemDto[];
  /** Summed over every prompt this digest's Explain made, not just what is shown in `items`. */
  droppedForBudget: number;
}

export interface MemoryUsageDto {
  /** Background memory jobs started today, all projects. */
  jobsToday: number;
  /** The daily share for background memory jobs (D2). */
  share: number;
  /** Background jobs only start while at least this many of the daily units remain for user actions. */
  reserve: number;
}

export interface MemoryOverviewDto {
  projectId: number;
  /** Per-project opt-in for background LLM summaries (D1). Deterministic memory is always on. */
  summariesEnabled: boolean;
  counts: Record<MemoryKind, number>;
  lastBatch: MemoryBatch | null;
  usage: MemoryUsageDto;
}
