// Project memory store (Milestone 4, DIG-97/DIG-100): CRUD over `memory_item`, versioned through
// `memory_revision`, grouped by the `memory_batch` that wrote each change (docs/milestone-4-memory.md
// §1). Shapes are the fixed contract in `@digestit/core`'s `memory.ts`; this module only reads and
// writes them. No LLM call happens anywhere here -- extraction (`memory-extract.ts`), threads
// (`memory-threads.ts`) and the context-`.md` sync (`memory-context.ts`) are all deterministic
// callers of this store.
import type { DatabaseSync } from 'node:sqlite';
import type {
  ExplainLanguage, MemoryBatch, MemoryContent, MemoryItem, MemoryItemDto, MemoryKind, MemoryProvenance,
  MemorySource, MemoryStatus, MemoryTrigger,
} from '@digestit/core';

interface MemoryItemDbRow {
  id: number;
  repo_id: number;
  kind: MemoryKind;
  key: string;
  language: ExplainLanguage | null;
  content: string;
  source: MemorySource;
  status: MemoryStatus;
  pinned: number;
  provenance: string;
  confirmed_at: string;
  updated_at: string;
  version: number;
}

function toMemoryItem(r: MemoryItemDbRow): MemoryItem {
  return {
    id: r.id,
    repoId: r.repo_id,
    kind: r.kind,
    key: r.key,
    language: r.language,
    content: JSON.parse(r.content) as MemoryContent,
    source: r.source,
    status: r.status,
    pinned: r.pinned === 1,
    provenance: JSON.parse(r.provenance) as MemoryProvenance,
    confirmedAt: r.confirmed_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

const SELECT_ITEM =
  'SELECT id, repo_id, kind, key, language, content, source, status, pinned, provenance, confirmed_at, updated_at, version FROM memory_item';

/** Looks up by the store's real identity (repo, kind, key, language); `language` uses `COALESCE`
 * against `''` the same way the unique index does, so `null` matches `null`. */
export function getMemoryItem(
  db: DatabaseSync, repoId: number, kind: MemoryKind, key: string, language: ExplainLanguage | null,
): MemoryItem | null {
  const row = db.prepare(`${SELECT_ITEM} WHERE repo_id = ? AND kind = ? AND key = ? AND COALESCE(language, '') = COALESCE(?, '')`)
    .get(repoId, kind, key, language) as MemoryItemDbRow | undefined;
  return row ? toMemoryItem(row) : null;
}

export function getMemoryItemById(db: DatabaseSync, id: number): MemoryItem | null {
  const row = db.prepare(`${SELECT_ITEM} WHERE id = ?`).get(id) as MemoryItemDbRow | undefined;
  return row ? toMemoryItem(row) : null;
}

export interface ListMemoryItemsOptions {
  kind?: MemoryKind;
  status?: MemoryStatus;
}

export function listMemoryItems(db: DatabaseSync, repoId: number, opts: ListMemoryItemsOptions = {}): MemoryItem[] {
  const clauses = ['repo_id = ?'];
  const params: (string | number)[] = [repoId];
  if (opts.kind) { clauses.push('kind = ?'); params.push(opts.kind); }
  if (opts.status) { clauses.push('status = ?'); params.push(opts.status); }
  const rows = db.prepare(`${SELECT_ITEM} WHERE ${clauses.join(' AND ')} ORDER BY kind, key`)
    .all(...params) as unknown as MemoryItemDbRow[];
  return rows.map(toMemoryItem);
}

// ---- batches -------------------------------------------------------------------------------

interface MemoryBatchDbRow {
  id: number;
  repo_id: number;
  trigger: MemoryTrigger;
  checkpoint_id: number | null;
  started_at: string;
  finished_at: string | null;
  changed: number;
  calls: number;
  rolled_back: number;
}

function toBatch(r: MemoryBatchDbRow): MemoryBatch {
  return {
    id: r.id, repoId: r.repo_id, trigger: r.trigger, checkpointId: r.checkpoint_id, startedAt: r.started_at,
    finishedAt: r.finished_at, changed: r.changed, calls: r.calls, rolledBack: r.rolled_back === 1,
  };
}

const SELECT_BATCH = 'SELECT id, repo_id, trigger, checkpoint_id, started_at, finished_at, changed, calls, rolled_back FROM memory_batch';

/** Opens a batch: the unit rollback replays. Deterministic work (everything in this module) never
 * makes a provider call, so `calls` is always 0 here; a future background-summary batch (DIG-103)
 * would report its own count when it finishes. */
export function createBatch(
  db: DatabaseSync, repoId: number, trigger: MemoryTrigger, checkpointId: number | null = null,
  now: () => Date = () => new Date(),
): number {
  return Number(db.prepare(
    'INSERT INTO memory_batch (repo_id, trigger, checkpoint_id, started_at) VALUES (?, ?, ?, ?)',
  ).run(repoId, trigger, checkpointId, now().toISOString()).lastInsertRowid);
}

/** `changed` is derived from the revision rows the batch actually wrote, so callers never have to
 * track their own counter. */
export function finishBatch(db: DatabaseSync, batchId: number, calls = 0, now: () => Date = () => new Date()): void {
  const changed = (db.prepare('SELECT count(*) AS n FROM memory_revision WHERE batch_id = ?').get(batchId) as { n: number }).n;
  db.prepare('UPDATE memory_batch SET finished_at = ?, changed = ?, calls = ? WHERE id = ?')
    .run(now().toISOString(), changed, calls, batchId);
}

export function getBatch(db: DatabaseSync, batchId: number): MemoryBatch | null {
  const row = db.prepare(`${SELECT_BATCH} WHERE id = ?`).get(batchId) as MemoryBatchDbRow | undefined;
  return row ? toBatch(row) : null;
}

export function latestBatch(db: DatabaseSync, repoId: number): MemoryBatch | null {
  const row = db.prepare(`${SELECT_BATCH} WHERE repo_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`).get(repoId) as MemoryBatchDbRow | undefined;
  return row ? toBatch(row) : null;
}

export function listBatches(db: DatabaseSync, repoId: number, limit = 20): MemoryBatch[] {
  const rows = db.prepare(`${SELECT_BATCH} WHERE repo_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(repoId, limit) as unknown as MemoryBatchDbRow[];
  return rows.map(toBatch);
}

// ---- mutations (every one bumps `version` and writes a `memory_revision` row) --------------

interface RevisionSnapshot {
  content: MemoryContent;
  source: MemorySource;
  status: MemoryStatus;
  pinned: boolean;
  provenance: MemoryProvenance;
}

function writeRevision(db: DatabaseSync, itemId: number, version: number, batchId: number, s: RevisionSnapshot, at: string): void {
  db.prepare(
    `INSERT INTO memory_revision (item_id, version, batch_id, content, source, status, pinned, provenance, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(itemId, version, batchId, JSON.stringify(s.content), s.source, s.status, s.pinned ? 1 : 0, JSON.stringify(s.provenance), at);
}

/**
 * Creates or updates the one item identified by (repo, kind, key, language): a new item starts at
 * version 1; an existing one gets a new version and revision row. Re-extracting an item reconfirms
 * it -- a `stale` item returns to `active` -- but a `hidden` item stays `hidden` (the user deleted
 * it; the extractor does not revive it). Callers that must never touch a hidden item at all (so it
 * keeps its last confirmed content) check `status` themselves before calling this.
 */
export function upsertMemoryItem(
  db: DatabaseSync, batchId: number, repoId: number, kind: MemoryKind, key: string, language: ExplainLanguage | null,
  content: MemoryContent, source: MemorySource, provenance: MemoryProvenance, now: () => Date = () => new Date(),
): MemoryItem {
  const at = now().toISOString();
  const existing = getMemoryItem(db, repoId, kind, key, language);
  if (!existing) {
    const id = Number(db.prepare(
      `INSERT INTO memory_item (repo_id, kind, key, language, content, source, status, pinned, provenance, confirmed_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, 1)`,
    ).run(repoId, kind, key, language, JSON.stringify(content), source, JSON.stringify(provenance), at, at).lastInsertRowid);
    writeRevision(db, id, 1, batchId, { content, source, status: 'active', pinned: false, provenance }, at);
    return getMemoryItemById(db, id)!;
  }
  const version = existing.version + 1;
  const status: MemoryStatus = existing.status === 'hidden' ? 'hidden' : 'active';
  db.prepare(
    `UPDATE memory_item SET content = ?, source = ?, status = ?, provenance = ?, confirmed_at = ?, updated_at = ?, version = ?
     WHERE id = ?`,
  ).run(JSON.stringify(content), source, status, JSON.stringify(provenance), at, at, version, existing.id);
  writeRevision(db, existing.id, version, batchId, { content, source, status, pinned: existing.pinned, provenance }, at);
  return getMemoryItemById(db, existing.id)!;
}

function transition(
  db: DatabaseSync, batchId: number, itemId: number, next: MemoryStatus, now: () => Date,
): MemoryItem | null {
  const existing = getMemoryItemById(db, itemId);
  if (!existing || existing.status === next) return existing;
  const at = now().toISOString();
  const version = existing.version + 1;
  db.prepare('UPDATE memory_item SET status = ?, updated_at = ?, version = ? WHERE id = ?').run(next, at, version, itemId);
  writeRevision(db, itemId, version, batchId, {
    content: existing.content, source: existing.source, status: next, pinned: existing.pinned, provenance: existing.provenance,
  }, at);
  return getMemoryItemById(db, itemId);
}

/** Its files changed or went away since it was confirmed; never sent to a prompt until re-extracted. */
export function markStale(db: DatabaseSync, batchId: number, itemId: number, now: () => Date = () => new Date()): MemoryItem | null {
  return transition(db, batchId, itemId, 'stale', now);
}

/** The user deleted it; the extractor keeps it hidden until {@link restoreItem}. */
export function markHidden(db: DatabaseSync, batchId: number, itemId: number, now: () => Date = () => new Date()): MemoryItem | null {
  return transition(db, batchId, itemId, 'hidden', now);
}

export function restoreItem(db: DatabaseSync, batchId: number, itemId: number, now: () => Date = () => new Date()): MemoryItem | null {
  return transition(db, batchId, itemId, 'active', now);
}

export function setPinned(db: DatabaseSync, batchId: number, itemId: number, pinned: boolean, now: () => Date = () => new Date()): MemoryItem | null {
  const existing = getMemoryItemById(db, itemId);
  if (!existing || existing.pinned === pinned) return existing;
  const at = now().toISOString();
  const version = existing.version + 1;
  db.prepare('UPDATE memory_item SET pinned = ?, updated_at = ?, version = ? WHERE id = ?').run(pinned ? 1 : 0, at, version, itemId);
  writeRevision(db, itemId, version, batchId, {
    content: existing.content, source: existing.source, status: existing.status, pinned, provenance: existing.provenance,
  }, at);
  return getMemoryItemById(db, itemId);
}

// ---- rollback --------------------------------------------------------------------------------

export interface RollbackResult {
  /** The rollback's own batch id (rollback is itself a batch, docs/milestone-4-memory.md §1). */
  batchId: number;
  /** Items put back to the version they held just before the rolled-back batch. */
  restored: number;
  /** Items the rolled-back batch created: memory rows are never hard-deleted (`memory_revision`
   * keeps referring to them), so "undo the creation" makes it `stale` instead -- never sent, but
   * reconfirmable by a later extraction, unlike `hidden` (reserved for an explicit user delete). */
  staled: number;
}

/**
 * Replays a batch's revisions backwards: every item it touched goes back to the version it held
 * just before the batch (or, if the batch created the item, goes `stale`). Recorded as a new batch
 * (trigger `rollback`) rather than rewriting history, so `memory_revision` stays append-only and a
 * rollback can itself be inspected or rolled back later. The whole replay is one transaction, since
 * a batch is the unit of rollback and must land or fail as a whole.
 */
export function rollbackBatch(db: DatabaseSync, targetBatchId: number, now: () => Date = () => new Date()): RollbackResult {
  const target = getBatch(db, targetBatchId);
  if (!target) throw new Error(`no memory batch ${targetBatchId}`);
  if (target.rolledBack) throw new Error(`memory batch ${targetBatchId} was already rolled back`);
  const at = now().toISOString();

  db.exec('BEGIN');
  let result: RollbackResult;
  try {
    const rollbackBatchId = createBatch(db, target.repoId, 'rollback', target.checkpointId, now);
    const touched = db.prepare(
      'SELECT item_id AS itemId, MIN(version) AS firstVersion FROM memory_revision WHERE batch_id = ? GROUP BY item_id',
    ).all(targetBatchId) as unknown as { itemId: number; firstVersion: number }[];

    let restored = 0;
    let staled = 0;
    for (const { itemId, firstVersion } of touched) {
      const current = getMemoryItemById(db, itemId);
      if (!current) continue; // items are never hard-deleted; defensive only
      const version = current.version + 1;
      const prevVersion = firstVersion - 1;
      if (prevVersion < 1) {
        db.prepare('UPDATE memory_item SET status = ?, updated_at = ?, version = ? WHERE id = ?').run('stale', at, version, itemId);
        writeRevision(db, itemId, version, rollbackBatchId, {
          content: current.content, source: current.source, status: 'stale', pinned: current.pinned, provenance: current.provenance,
        }, at);
        staled++;
        continue;
      }
      const prev = db.prepare(
        'SELECT content, source, status, pinned, provenance FROM memory_revision WHERE item_id = ? AND version = ?',
      ).get(itemId, prevVersion) as { content: string; source: MemorySource; status: MemoryStatus; pinned: number; provenance: string } | undefined;
      if (!prev) continue; // no earlier revision recorded; defensive only
      db.prepare(
        `UPDATE memory_item SET content = ?, source = ?, status = ?, pinned = ?, provenance = ?, updated_at = ?, version = ?
         WHERE id = ?`,
      ).run(prev.content, prev.source, prev.status, prev.pinned, prev.provenance, at, version, itemId);
      writeRevision(db, itemId, version, rollbackBatchId, {
        content: JSON.parse(prev.content) as MemoryContent, source: prev.source, status: prev.status,
        pinned: prev.pinned === 1, provenance: JSON.parse(prev.provenance) as MemoryProvenance,
      }, at);
      restored++;
    }

    db.prepare('UPDATE memory_batch SET rolled_back = 1 WHERE id = ?').run(targetBatchId);
    finishBatch(db, rollbackBatchId, 0, now);
    result = { batchId: rollbackBatchId, restored, staled };
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}

/** `MemoryItemDto` for the API/page: the store row plus the two aggregates only a query can answer
 * (`usedInDigestsCounts`, `overriddenByMap`), both repo-scoped so a listing costs two extra queries
 * total, not one per item. */
export function toMemoryItemDto(item: MemoryItem, usedInDigests: Map<number, number>, overriddenBy: Map<string, number>): MemoryItemDto {
  return {
    id: item.id, kind: item.kind, key: item.key, language: item.language, content: item.content,
    source: item.source, status: item.status, pinned: item.pinned, provenance: item.provenance,
    confirmedAt: item.confirmedAt, updatedAt: item.updatedAt, version: item.version,
    usedInDigests: usedInDigests.get(item.id) ?? 0,
    overriddenBy: overriddenBy.get(`${item.kind}:${item.key}`) ?? null,
  };
}

// ---- memory_use (DIG-103): which item versions went into which prompt -----------------------

export interface MemoryUseInput {
  jobId: number;
  /** Same convention as `explain_call.part`: `summary`, `area:<id>` or `walkthrough:<id>`. */
  part: string;
  /** Null for a background `memory` job, which is not tied to one digest. */
  changeUnitId: number | null;
  items: readonly { id: number; version: number }[];
  droppedForBudget: number;
}

/** Logs one part's `MemorySlice` (docs/milestone-4-memory.md §3): one `memory_slice` row per (job,
 * part) so `droppedForBudget` survives even when the slice picked no items, plus one `memory_use`
 * row per item so "used in N digests" (docs/ux/decision-4-memory.md change 1) can be counted
 * without re-deriving it from prompt logs. Idempotent on (job, part) / (job, part, item), so a
 * retried part safely overwrites its own earlier log instead of double-counting. */
export function recordMemoryUse(db: DatabaseSync, input: MemoryUseInput): void {
  db.prepare(
    `INSERT INTO memory_slice (job_id, part, change_unit_id, dropped_for_budget) VALUES (?, ?, ?, ?)
     ON CONFLICT (job_id, part) DO UPDATE SET change_unit_id = excluded.change_unit_id, dropped_for_budget = excluded.dropped_for_budget`,
  ).run(input.jobId, input.part, input.changeUnitId, input.droppedForBudget);
  const ins = db.prepare(
    `INSERT INTO memory_use (job_id, part, item_id, version, change_unit_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (job_id, part, item_id) DO UPDATE SET version = excluded.version, change_unit_id = excluded.change_unit_id`,
  );
  for (const it of input.items) ins.run(input.jobId, input.part, it.id, it.version, input.changeUnitId);
}

/** Distinct digests whose prompts used any version of each item (repo-scoped, one query): the
 * `MemoryItemDto.usedInDigests` the page shows, immune to the per-version prompt-count inflation
 * that made the old `usedCount` wrong (docs/ux/decision-4-memory.md change 1). */
export function usedInDigestsCounts(db: DatabaseSync, repoId: number): Map<number, number> {
  const rows = db.prepare(
    `SELECT mu.item_id AS itemId, COUNT(DISTINCT mu.change_unit_id) AS n
     FROM memory_use mu JOIN memory_item mi ON mi.id = mu.item_id
     WHERE mi.repo_id = ? AND mu.change_unit_id IS NOT NULL
     GROUP BY mu.item_id`,
  ).all(repoId) as unknown as { itemId: number; n: number }[];
  return new Map(rows.map((r) => [r.itemId, r.n]));
}

/** Active user notes with a target, keyed `${kind}:${key}`: `MemoryItemDto.overriddenBy` for the
 * item each one names (docs/milestone-4-memory.md §1, "a note with a target overrides that item's
 * text in prompts"). */
export function overriddenByMap(db: DatabaseSync, repoId: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const n of listMemoryItems(db, repoId, { kind: 'note', status: 'active' })) {
    const target = (n.content as { target: { kind: string; key: string } | null }).target;
    if (target) map.set(`${target.kind}:${target.key}`, n.id);
  }
  return map;
}

export type MemoryUsedForPart = 'summary' | 'area' | 'walkthrough';

/** Splits `explain_call`/`memory_use`'s `part` convention (`summary`, `area:<id>`, `walkthrough:<id>`)
 * into the `{ part, area }` shape `GET /api/digests/:id/memory-used` returns. */
export function splitPart(raw: string): { part: MemoryUsedForPart; area: string | null } {
  const i = raw.indexOf(':');
  if (i === -1) return { part: raw as MemoryUsedForPart, area: null };
  return { part: raw.slice(0, i) as MemoryUsedForPart, area: raw.slice(i + 1) };
}

export interface DigestMemoryUseItem {
  itemId: number;
  /** The item's version as it stood when this digest's prompts used it; may be behind its current version. */
  usedVersion: number;
  /** Deduplicated: every walkthrough step of one area collapses to one `area` tag. */
  usedFor: { part: MemoryUsedForPart; area: string | null }[];
}

export interface DigestMemoryUse {
  items: DigestMemoryUseItem[];
  /** Summed over every prompt this digest's Explain made (docs/ux/decision-4-memory.md change 2). */
  droppedForBudget: number;
}

// ---- per-project settings (D1: background summaries default off) ----------------------------

/** Per-project opt-in for background LLM summaries (docs/milestone-4-memory.md §5, D1).
 * Deterministic memory (areas/terms/threads from code) is always on and does not check this. */
export function memorySummariesEnabled(db: DatabaseSync, repoId: number): boolean {
  const row = db.prepare('SELECT memory_summaries AS v FROM repo WHERE id = ?').get(repoId) as { v: number } | undefined;
  return row?.v === 1;
}

export function setMemorySummariesEnabled(db: DatabaseSync, repoId: number, enabled: boolean): void {
  db.prepare('UPDATE repo SET memory_summaries = ? WHERE id = ?').run(enabled ? 1 : 0, repoId);
}

/** `GET /api/digests/:id/memory-used`'s raw query: item ids only, so the API layer can join in
 * each item's current `MemoryItemDto` fields (`getMemoryItemById`, `usedInDigestsCounts`). */
export function memoryUsedForDigest(db: DatabaseSync, changeUnitId: number): DigestMemoryUse {
  const rows = db.prepare('SELECT item_id AS itemId, version, part FROM memory_use WHERE change_unit_id = ?')
    .all(changeUnitId) as unknown as { itemId: number; version: number; part: string }[];
  const byItem = new Map<number, { usedVersion: number; usedFor: Map<string, { part: MemoryUsedForPart; area: string | null }> }>();
  for (const r of rows) {
    let entry = byItem.get(r.itemId);
    if (!entry) { entry = { usedVersion: r.version, usedFor: new Map() }; byItem.set(r.itemId, entry); }
    entry.usedVersion = Math.max(entry.usedVersion, r.version);
    const pa = splitPart(r.part);
    entry.usedFor.set(`${pa.part}:${pa.area ?? ''}`, pa);
  }
  const items = [...byItem.entries()].map(([itemId, e]) => ({ itemId, usedVersion: e.usedVersion, usedFor: [...e.usedFor.values()] }));
  const droppedForBudget = (db.prepare('SELECT COALESCE(SUM(dropped_for_budget), 0) AS n FROM memory_slice WHERE change_unit_id = ?')
    .get(changeUnitId) as { n: number }).n;
  return { items, droppedForBudget };
}

// ---- export / clear --------------------------------------------------------------------------

export interface MemoryExport {
  repoId: number;
  exportedAt: string;
  items: MemoryItem[];
}

export function exportMemory(db: DatabaseSync, repoId: number, now: () => Date = () => new Date()): MemoryExport {
  return { repoId, exportedAt: now().toISOString(), items: listMemoryItems(db, repoId) };
}

export interface ClearMemoryResult {
  itemsDeleted: number;
  batchesDeleted: number;
}

/** `digest memory clear <project>`: a full reset, not a soft hide -- every item, revision, use and
 * batch for the project is gone. Unlike `removeProject` (DIG-87), this is meant to be destructive. */
export function clearMemory(db: DatabaseSync, repoId: number): ClearMemoryResult {
  const itemIds = (db.prepare('SELECT id FROM memory_item WHERE repo_id = ?').all(repoId) as unknown as { id: number }[]).map((r) => r.id);
  const batchIds = (db.prepare('SELECT id FROM memory_batch WHERE repo_id = ?').all(repoId) as unknown as { id: number }[]).map((r) => r.id);
  db.exec('BEGIN');
  try {
    if (itemIds.length > 0) {
      const placeholders = itemIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM memory_use WHERE item_id IN (${placeholders})`).run(...itemIds);
      db.prepare(`DELETE FROM memory_revision WHERE item_id IN (${placeholders})`).run(...itemIds);
      db.prepare(`DELETE FROM memory_item WHERE id IN (${placeholders})`).run(...itemIds);
    }
    // Leftover `memory_use`/`memory_slice` rows for this project's digests that named no item at
    // all (a part whose whole slice was empty) -- not covered by the item-keyed delete above.
    db.prepare(
      `DELETE FROM memory_use WHERE change_unit_id IN (SELECT id FROM change_unit WHERE repo_id = ?)`,
    ).run(repoId);
    db.prepare(
      `DELETE FROM memory_slice WHERE change_unit_id IN (SELECT id FROM change_unit WHERE repo_id = ?)`,
    ).run(repoId);
    db.prepare(
      `DELETE FROM memory_slice WHERE job_id IN (SELECT id FROM explain_job WHERE repo_id = ? AND kind = 'memory')`,
    ).run(repoId);
    if (batchIds.length > 0) {
      const placeholders = batchIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM memory_batch WHERE id IN (${placeholders})`).run(...batchIds);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { itemsDeleted: itemIds.length, batchesDeleted: batchIds.length };
}
