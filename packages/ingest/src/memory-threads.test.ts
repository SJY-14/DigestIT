import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import type { ThreadMemory } from '@digestit/core';
import { getMemoryItem, listMemoryItems, createBatch } from './memory.js';
import { updateThreads } from './memory-threads.js';

function setup(): { db: DatabaseSync; repoId: number } {
  const db = openDb(':memory:');
  db.exec("INSERT INTO repo (name, path, mode) VALUES ('snapback', '/snapback', 'project')");
  const repoId = Number(db.prepare('SELECT id FROM repo').get()!.id);
  db.prepare(
    "INSERT INTO checkpoint (repo_id, seq, shadow_sha, tree_sha, taken_at, reason) VALUES (?, 1, 'sha', 'sha', '2026-01-01T00:00:00.000Z', 'init')",
  ).run(repoId);
  return { db, repoId };
}

function insertDigest(
  db: DatabaseSync, repoId: number, id: number, createdAt: string, areas: { label: string }[], l0: string,
): void {
  db.prepare("INSERT INTO change_unit (id, repo_id, kind, head_sha, title) VALUES (?, ?, 'digest', ?, 't')").run(id, repoId, `sha${id}`);
  db.prepare(
    "INSERT INTO checkpoint (id, repo_id, seq, shadow_sha, tree_sha, taken_at, reason) VALUES (?, ?, ?, ?, ?, ?, 'explain')",
  ).run(id + 1, repoId, id + 1, `sha${id + 1}`, `sha${id + 1}`, createdAt);
  db.prepare(
    `INSERT INTO digest (change_unit_id, repo_id, from_checkpoint_id, to_checkpoint_id, created_at, areas)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(id, repoId, id + 1, createdAt, JSON.stringify(areas));
  db.prepare(
    `INSERT INTO explanation (change_unit_id, level, content, status, provider, model, prompt_version, input_hash, created_at)
     VALUES (?, 0, ?, 'ok', 'stub', 'm', 'v1', 'h', ?)`,
  ).run(id, JSON.stringify({ text: l0 }), createdAt);
}

const now = (iso: string) => () => new Date(iso);

describe('updateThreads', () => {
  it('a digest that touches the same area and shares a term joins the open thread', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'src' }], 'Adds the retry queue for failed jobs.');
    insertDigest(db, repoId, 2, '2026-09-02T00:00:00.000Z', [{ label: 'src' }], 'Fixes a bug in the retry queue.');
    const batch = createBatch(db, repoId, 'manual', null, now('2026-09-03T00:00:00.000Z'));
    updateThreads(db, batch, repoId, new Set(['retry']), now('2026-09-03T00:00:00.000Z'));

    const threads = listMemoryItems(db, repoId, { kind: 'thread' });
    expect(threads).toHaveLength(1);
    const content = threads[0]!.content as ThreadMemory;
    expect(content.digests.map((d) => d.digestId)).toEqual([1, 2]);
    expect(content.title).toBe('Adds the retry queue for failed jobs.');
    expect(content.state).toBe('open');
  });

  it('a digest touching an unrelated area with no shared term starts its own thread', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'src' }], 'Adds the retry queue.');
    insertDigest(db, repoId, 2, '2026-09-02T00:00:00.000Z', [{ label: 'docs' }], 'Rewrites the README.');
    const batch = createBatch(db, repoId, 'manual', null, now('2026-09-03T00:00:00.000Z'));
    updateThreads(db, batch, repoId, new Set(['retry']), now('2026-09-03T00:00:00.000Z'));

    expect(listMemoryItems(db, repoId, { kind: 'thread' })).toHaveLength(2);
  });

  it('a thread closes after 14 days with no new digest', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'src' }], 'Adds the retry queue.');
    const batch = createBatch(db, repoId, 'manual', null, now('2026-09-20T00:00:00.000Z'));
    updateThreads(db, batch, repoId, new Set(), now('2026-09-20T00:00:00.000Z')); // 19 days later
    const content = listMemoryItems(db, repoId, { kind: 'thread' })[0]!.content as ThreadMemory;
    expect(content.state).toBe('closed');
  });

  it('the project root ("project root" label) normalises to the empty-string area key', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'project root' }], 'Bumps the version.');
    const batch = createBatch(db, repoId, 'manual', null, now('2026-09-01T00:00:00.000Z'));
    updateThreads(db, batch, repoId, new Set(), now('2026-09-01T00:00:00.000Z'));
    const content = listMemoryItems(db, repoId, { kind: 'thread' })[0]!.content as ThreadMemory;
    expect(content.areas).toEqual(['']);
  });

  it('re-running with no new digests does not bump the thread\'s version', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'src' }], 'Adds the retry queue.');
    const b1 = createBatch(db, repoId, 'manual', null, now('2026-09-01T00:00:00.000Z'));
    updateThreads(db, b1, repoId, new Set(), now('2026-09-01T00:00:00.000Z'));
    const v1 = getMemoryItem(db, repoId, 'thread', 'd1', 'en')!.version;

    const b2 = createBatch(db, repoId, 'daily', null, now('2026-09-02T00:00:00.000Z'));
    updateThreads(db, b2, repoId, new Set(), now('2026-09-02T00:00:00.000Z'));
    expect(getMemoryItem(db, repoId, 'thread', 'd1', 'en')!.version).toBe(v1);
  });
});
