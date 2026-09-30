import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import type { AreaMemory, NoteMemory } from '@digestit/core';
import {
  clearMemory, createBatch, exportMemory, finishBatch, getBatch, getMemoryItem, getMemoryItemById,
  latestBatch, listBatches, listMemoryItems, markHidden, markStale, restoreItem, rollbackBatch, setPinned,
  upsertMemoryItem,
} from './memory.js';

function setup(): { db: DatabaseSync; repoId: number } {
  const db = openDb(':memory:');
  db.exec("INSERT INTO repo (name, path, mode) VALUES ('snapback', '/snapback', 'project')");
  const repoId = Number(db.prepare('SELECT id FROM repo').get()!.id);
  return { db, repoId };
}

const now = () => new Date('2026-09-30T00:00:00.000Z');
const provenance = { files: ['src/index.ts'], checkpointId: 1, digestIds: [], jobId: null };

function area(fileCount: number): AreaMemory {
  return { kind: 'area', path: 'src', fileCount, exports: [], uses: [], usedBy: [], doc: null, summary: null, fingerprint: `fp${fileCount}` };
}

describe('memory store', () => {
  it('upsertMemoryItem creates version 1, then bumps version and writes a revision on update', () => {
    const { db, repoId } = setup();
    const batch1 = createBatch(db, repoId, 'init', null, now);
    const created = upsertMemoryItem(db, batch1, repoId, 'area', 'src', null, area(3), 'code', provenance, now);
    expect(created.version).toBe(1);
    expect(created.status).toBe('active');

    const batch2 = createBatch(db, repoId, 'after-explain', null, now);
    const updated = upsertMemoryItem(db, batch2, repoId, 'area', 'src', null, area(4), 'code', provenance, now);
    expect(updated.id).toBe(created.id); // same identity (repo, kind, key, language)
    expect(updated.version).toBe(2);
    expect((updated.content as AreaMemory).fileCount).toBe(4);

    const revisions = db.prepare('SELECT version, batch_id AS batchId FROM memory_revision WHERE item_id = ? ORDER BY version').all(created.id);
    expect(revisions).toEqual([{ version: 1, batchId: batch1 }, { version: 2, batchId: batch2 }]);
  });

  it('language is part of an item\'s identity; two languages of the same key coexist', () => {
    const { db, repoId } = setup();
    const batch = createBatch(db, repoId, 'manual', null, now);
    const note: NoteMemory = { kind: 'note', text: 'hello', target: null, origin: 'context-md' };
    const en = upsertMemoryItem(db, batch, repoId, 'note', 'intro', 'en', note, 'user', provenance, now);
    const ko = upsertMemoryItem(db, batch, repoId, 'note', 'intro', 'ko', { ...note, text: '안녕' }, 'user', provenance, now);
    expect(en.id).not.toBe(ko.id);
    expect(getMemoryItem(db, repoId, 'note', 'intro', 'en')!.id).toBe(en.id);
    expect(getMemoryItem(db, repoId, 'note', 'intro', 'ko')!.id).toBe(ko.id);
  });

  it('a re-extraction reconfirms a stale item back to active, but never revives a hidden one', () => {
    const { db, repoId } = setup();
    const b1 = createBatch(db, repoId, 'init', null, now);
    const item = upsertMemoryItem(db, b1, repoId, 'area', 'src', null, area(3), 'code', provenance, now);

    const b2 = createBatch(db, repoId, 'daily', null, now);
    markStale(db, b2, item.id, now);
    expect(getMemoryItemById(db, item.id)!.status).toBe('stale');
    const b3 = createBatch(db, repoId, 'after-explain', null, now);
    const reExtracted = upsertMemoryItem(db, b3, repoId, 'area', 'src', null, area(5), 'code', provenance, now);
    expect(reExtracted.status).toBe('active');

    const b4 = createBatch(db, repoId, 'user', null, now);
    markHidden(db, b4, item.id, now);
    expect(getMemoryItemById(db, item.id)!.status).toBe('hidden');
    const b5 = createBatch(db, repoId, 'after-explain', null, now);
    const stillHidden = upsertMemoryItem(db, b5, repoId, 'area', 'src', null, area(6), 'code', provenance, now);
    expect(stillHidden.status).toBe('hidden');
    // The extractor's content is still recorded (so it isn't silently dropped once restored)...
    expect((stillHidden.content as AreaMemory).fileCount).toBe(6);

    const b6 = createBatch(db, repoId, 'user', null, now);
    const restored = restoreItem(db, b6, item.id, now);
    expect(restored!.status).toBe('active');
  });

  it('setPinned bumps version only when the value actually changes', () => {
    const { db, repoId } = setup();
    const b1 = createBatch(db, repoId, 'init', null, now);
    const item = upsertMemoryItem(db, b1, repoId, 'area', 'src', null, area(3), 'code', provenance, now);
    const b2 = createBatch(db, repoId, 'user', null, now);
    const pinned = setPinned(db, b2, item.id, true, now);
    expect(pinned!.version).toBe(2);
    const unchanged = setPinned(db, b2, item.id, true, now);
    expect(unchanged!.version).toBe(2);
  });

  it('listMemoryItems filters by kind and status', () => {
    const { db, repoId } = setup();
    const b1 = createBatch(db, repoId, 'init', null, now);
    const a = upsertMemoryItem(db, b1, repoId, 'area', 'src', null, area(3), 'code', provenance, now);
    upsertMemoryItem(db, b1, repoId, 'area', 'lib', null, area(1), 'code', provenance, now);
    markStale(db, b1, a.id, now);
    expect(listMemoryItems(db, repoId, { kind: 'area' })).toHaveLength(2);
    expect(listMemoryItems(db, repoId, { kind: 'area', status: 'stale' }).map((i) => i.key)).toEqual(['src']);
  });

  it('finishBatch derives `changed` from the revision rows the batch actually wrote', () => {
    const { db, repoId } = setup();
    const b1 = createBatch(db, repoId, 'init', null, now);
    upsertMemoryItem(db, b1, repoId, 'area', 'src', null, area(3), 'code', provenance, now);
    upsertMemoryItem(db, b1, repoId, 'area', 'lib', null, area(1), 'code', provenance, now);
    finishBatch(db, b1, 0, now);
    expect(getBatch(db, b1)!.changed).toBe(2);
    expect(getBatch(db, b1)!.finishedAt).not.toBeNull();
  });

  it('latestBatch and listBatches order by recency', () => {
    const { db, repoId } = setup();
    const later = () => new Date('2026-10-01T00:00:00.000Z');
    const b1 = createBatch(db, repoId, 'init', null, now);
    const b2 = createBatch(db, repoId, 'daily', null, later);
    expect(latestBatch(db, repoId)!.id).toBe(b2);
    expect(listBatches(db, repoId).map((b) => b.id)).toEqual([b2, b1]);
  });

  it('rollbackBatch restores exact previous versions for items the batch updated', () => {
    const { db, repoId } = setup();
    const b1 = createBatch(db, repoId, 'init', null, now);
    const created = upsertMemoryItem(db, b1, repoId, 'area', 'src', null, area(3), 'code', provenance, now);
    finishBatch(db, b1, 0, now);

    const b2 = createBatch(db, repoId, 'after-explain', null, now);
    upsertMemoryItem(db, b2, repoId, 'area', 'src', null, area(9), 'code', provenance, now);
    finishBatch(db, b2, 0, now);
    expect((getMemoryItemById(db, created.id)!.content as AreaMemory).fileCount).toBe(9);

    const result = rollbackBatch(db, b2, now);
    expect(result.restored).toBe(1);
    expect(result.staled).toBe(0);
    const restored = getMemoryItemById(db, created.id)!;
    expect((restored.content as AreaMemory).fileCount).toBe(3); // exact previous content
    expect(restored.version).toBe(3); // rollback is a forward move, not a rewind of the counter
    expect(getBatch(db, b2)!.rolledBack).toBe(true);
  });

  it('rollbackBatch stales (never hides) an item the rolled-back batch created, so it is reconfirmable later', () => {
    const { db, repoId } = setup();
    const b1 = createBatch(db, repoId, 'init', null, now);
    const created = upsertMemoryItem(db, b1, repoId, 'area', 'new-area', null, area(1), 'code', provenance, now);
    finishBatch(db, b1, 0, now);

    const result = rollbackBatch(db, b1, now);
    expect(result.staled).toBe(1);
    expect(result.restored).toBe(0);
    expect(getMemoryItemById(db, created.id)!.status).toBe('stale');

    const b2 = createBatch(db, repoId, 'after-explain', null, now);
    const reExtracted = upsertMemoryItem(db, b2, repoId, 'area', 'new-area', null, area(1), 'code', provenance, now);
    expect(reExtracted.status).toBe('active'); // a stale item is revived by the extractor, unlike hidden
  });

  it('rollbackBatch refuses a batch that was already rolled back', () => {
    const { db, repoId } = setup();
    const b1 = createBatch(db, repoId, 'init', null, now);
    upsertMemoryItem(db, b1, repoId, 'area', 'src', null, area(3), 'code', provenance, now);
    finishBatch(db, b1, 0, now);
    rollbackBatch(db, b1, now);
    expect(() => rollbackBatch(db, b1, now)).toThrow(/already rolled back/);
  });

  it('rollbackBatch on a batch that only marked an item stale flips it back, unchanged content', () => {
    const { db, repoId } = setup();
    const b1 = createBatch(db, repoId, 'init', null, now);
    const created = upsertMemoryItem(db, b1, repoId, 'area', 'src', null, area(3), 'code', provenance, now);
    finishBatch(db, b1, 0, now);
    const b2 = createBatch(db, repoId, 'daily', null, now);
    markStale(db, b2, created.id, now);
    finishBatch(db, b2, 0, now);

    rollbackBatch(db, b2, now);
    const restored = getMemoryItemById(db, created.id)!;
    expect(restored.status).toBe('active');
    expect((restored.content as AreaMemory).fileCount).toBe(3);
  });

  it('exportMemory returns every item; clearMemory hard-deletes items, revisions and batches for the repo only', () => {
    const { db, repoId } = setup();
    const otherRepoId = repoId + 1;
    db.exec(`INSERT INTO repo (name, path, mode) VALUES ('acme-webapp', '/acme-webapp', 'project')`);
    const b1 = createBatch(db, repoId, 'init', null, now);
    upsertMemoryItem(db, b1, repoId, 'area', 'src', null, area(3), 'code', provenance, now);
    const bOther = createBatch(db, otherRepoId, 'init', null, now);
    const otherItem = upsertMemoryItem(db, bOther, otherRepoId, 'area', 'src', null, area(1), 'code', provenance, now);

    const dump = exportMemory(db, repoId, now);
    expect(dump.items).toHaveLength(1);
    expect(dump.repoId).toBe(repoId);

    const result = clearMemory(db, repoId);
    expect(result.itemsDeleted).toBe(1);
    expect(result.batchesDeleted).toBe(1);
    expect(listMemoryItems(db, repoId)).toHaveLength(0);
    expect(listBatches(db, repoId)).toHaveLength(0);
    // The other project's memory is untouched.
    expect(getMemoryItemById(db, otherItem.id)).not.toBeNull();
  });
});
