import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import type { NoteMemory, TermMemory, ThreadMemory } from '@digestit/core';
import { logJobCall, startJob } from '@digestit/explain';
import { createBatch, recordMemoryUse, upsertMemoryItem } from '../src/memory.js';
import {
  READER_SHEET, loadDigestMemory, mergeViolationCounts, promptTokenTotal, renderMemorySection, renderPair, splitKindTag,
  violationCounts, violationRule,
} from './memory-ab-render.mjs';

const PROV = { files: [], checkpointId: null, digestIds: [], jobId: null };
const at = (iso: string) => () => new Date(iso);

function setup(): { db: DatabaseSync; repoId: number } {
  const db = openDb(':memory:');
  db.exec("INSERT INTO repo (name, path, mode) VALUES ('snapback', '/path/to/snapback', 'project')");
  const repoId = Number((db.prepare('SELECT id FROM repo').get() as { id: number }).id);
  db.prepare(
    "INSERT INTO checkpoint (repo_id, seq, shadow_sha, tree_sha, taken_at, reason) VALUES (?, 1, 'sha', 'sha', '2026-09-01T00:00:00.000Z', 'init')",
  ).run(repoId);
  return { db, repoId };
}

function insertDigest(db: DatabaseSync, repoId: number, id: number, createdAt: string): void {
  db.prepare("INSERT INTO change_unit (id, repo_id, kind, head_sha, title) VALUES (?, ?, 'digest', ?, 't')").run(id, repoId, `sha${id}`);
  db.prepare(
    "INSERT INTO checkpoint (id, repo_id, seq, shadow_sha, tree_sha, taken_at, reason) VALUES (?, ?, ?, ?, ?, ?, 'explain')",
  ).run(id + 1, repoId, id + 1, `sha${id + 1}`, `sha${id + 1}`, createdAt);
  db.prepare(
    `INSERT INTO digest (change_unit_id, repo_id, from_checkpoint_id, to_checkpoint_id, created_at, areas)
     VALUES (?, ?, 1, ?, ?, '[]')`,
  ).run(id, repoId, id + 1, createdAt);
}

const RETRY_1 = { digestId: 1, seq: 1, at: '2026-09-17T10:00:00.000Z', l0: 'Failed requests now retry automatically.' };
const RETRY_2 = { digestId: 2, seq: 2, at: '2026-09-20T10:00:00.000Z', l0: 'Retries now back off and report HTTP errors.' };
const THIS_ONE = { digestId: 4, seq: 3, at: '2026-09-23T10:00:00.000Z', l0: 'The retry helper gets a clearer name.' };

/** Digest 4 of a retry story: the on arm was sent a user note, a thread and a term (as `selectMemory` would). */
function seedRetryStory() {
  const { db, repoId } = setup();
  insertDigest(db, repoId, 4, THIS_ONE.at);
  const batch = createBatch(db, repoId, 'user', null, at('2026-09-22T09:00:00.000Z'));
  const note: NoteMemory = {
    kind: 'note', text: 'The backoff base is 200ms by team convention.', target: { kind: 'term', key: 'withRetry' }, origin: 'correction',
  };
  const noteItem = upsertMemoryItem(db, batch, repoId, 'note', 'n1', null, note, 'user', PROV, at('2026-09-22T09:00:00.000Z'));
  const term: TermMemory = { kind: 'term', term: 'withRetry', definedAt: null, meaning: null, areas: ['src'] };
  const termItem = upsertMemoryItem(db, batch, repoId, 'term', 'withRetry', null, term, 'code', PROV, at('2026-09-17T10:00:00.000Z'));
  const thread: ThreadMemory = {
    kind: 'thread', title: RETRY_1.l0, areas: ['src'], terms: ['withRetry'], digests: [RETRY_1, RETRY_2], state: 'open', summary: null,
  };
  const threadV1 = upsertMemoryItem(db, batch, repoId, 'thread', 'd1', 'en', thread, 'digest', PROV, at('2026-09-20T10:00:00.000Z'));
  // After this digest was explained, the after-explain update added it to the thread (version 2).
  upsertMemoryItem(db, batch, repoId, 'thread', 'd1', 'en', { ...thread, digests: [RETRY_1, RETRY_2, THIS_ONE] }, 'digest', PROV,
    at('2026-09-23T10:05:00.000Z'));

  const jobId = startJob(db, 'explain', { repoId, changeUnitId: 4 }, 100)!;
  const items = [noteItem, termItem, threadV1].map((it) => ({ id: it.id, version: it.version }));
  for (const part of ['summary', 'area:src', 'walkthrough:src']) {
    recordMemoryUse(db, { jobId, part, changeUnitId: 4, items, droppedForBudget: 0 });
  }
  return { db, repoId, jobId };
}

describe('pair file: project memory section (DIG-114)', () => {
  it('lists what the on arm was sent, with the provenance a reader needs', () => {
    const { db } = seedRetryStory();
    const memory = loadDigestMemory(db, 4);
    expect(memory.map((e: { kind: string }) => e.kind)).toEqual(['note', 'thread', 'term']);
    const md = renderMemorySection(memory, THIS_ONE.at);

    expect(md).toContain('## Project memory available for this digest');
    // the user note: its text and the date the user wrote it
    expect(md).toContain('**User note** of Tue 22 Sep (2026-09-22) about the term `withRetry`: "The backoff base is 200ms by team convention."');
    // the thread: title, first/last earlier change with dates and ages, never this digest itself
    expect(md).toContain('**Thread** "Failed requests now retry automatically." — first Thu 17 Sep (2026-09-17), last Sun 20 Sep (2026-09-20)');
    expect(md).toContain('  - Thu 17 Sep (2026-09-17), 6 days earlier: "Failed requests now retry automatically."');
    expect(md).toContain('  - Sun 20 Sep (2026-09-20), 3 days earlier: "Retries now back off and report HTTP errors."');
    expect(md).not.toContain(THIS_ONE.l0);
    // the term, and which parts used each item
    expect(md).toContain('**Term** `withRetry` — _used in: area:src, summary, walkthrough:src_');
  });

  it('says so when no memory was sent', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 7, '2026-09-25T10:00:00.000Z');
    const md = renderMemorySection(loadDigestMemory(db, 7), '2026-09-25T10:00:00.000Z');
    expect(md).toContain('_None was sent:');
  });

  it('comes after both versions in the pair file', () => {
    const { db } = seedRetryStory();
    const version = {
      l0: { text: 'Retry helper renamed.' }, l1: { bullets: ['Nothing changes for users.'] },
      l2: { items: [{ title: 'Rename', paths: ['src/retry.js'], effect: 'E.', how: 'H.', why: 'W.' }] },
      areaId: 'src', walkthrough: null,
    };
    const md = renderPair('snapback-en-04: rename', version, version, loadDigestMemory(db, 4), THIS_ONE.at);
    const a = md.indexOf('## Version A');
    const b = md.indexOf('## Version B');
    const mem = md.indexOf('## Project memory available for this digest');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(mem).toBeGreaterThan(b);
  });

  it('the reader sheet uses the §6 support rule: neither the diff nor the listed memory/history', () => {
    expect(READER_SHEET).toMatch(/unsupported only if \*\*neither\*\* the diff \*\*nor\*\* the listed project memory \/ project\s+history/);
  });
});

describe('metrics (DIG-114)', () => {
  it('totals the whole prompt, falling back to input_tokens on rows without prompt_tokens', () => {
    const { db, jobId } = seedRetryStory();
    const base = { jobId, changeUnitId: 4, model: 'm', durationMs: 1, outcome: 'ok' as const };
    logJobCall(db, new Date(), 'digest', {
      ...base, part: 'summary', timing: { startupMs: 0, ttftMs: 0, genMs: 0, inputTokens: 7, outputTokens: 50, promptTokens: 9_000 },
    });
    logJobCall(db, new Date(), 'digest', {
      ...base, part: 'area:src', timing: { startupMs: 0, ttftMs: 0, genMs: 0, inputTokens: 400, outputTokens: 50, promptTokens: null },
    });
    expect(promptTokenTotal(db)).toBe(9_400);
  });

  it('counts validator findings per rule and per part kind, tagged messages split by kind (DIG-118)', () => {
    const { db, jobId } = seedRetryStory();
    const base = { jobId, changeUnitId: 4, model: 'm', durationMs: 1, outcome: 'ok' as const };
    // One call with one of each kind (a hard violation, a style warning and a length note), one
    // call with a second hard violation under a different part, one clean call.
    logJobCall(db, new Date(), 'digest', {
      ...base, part: 'summary',
      violations: 'violation: l1: 72 words, limit 60; style: why: reads like marketing copy; note: l0: 24 words, target 20',
    });
    logJobCall(db, new Date(), 'area', { ...base, part: 'walkthrough:src', violations: 'violation: l1: 65 words, limit 60' });
    logJobCall(db, new Date(), 'digest', { ...base, part: 'area:src' });
    const v = violationCounts(db);
    expect(v).toEqual({
      callsWithViolations: 2,
      messages: 4,
      byPart: { summary: 3, walkthrough: 1 },
      byRule: {
        'l1: N words, limit N': 2,
        'why: reads like marketing copy': 1,
        'l0: N words, target N': 1,
      },
      byKind: {
        violation: { messages: 2, byRule: { 'l1: N words, limit N': 2 }, byPart: { summary: 1, walkthrough: 1 } },
        style: { messages: 1, byRule: { 'why: reads like marketing copy': 1 }, byPart: { summary: 1 } },
        note: { messages: 1, byRule: { 'l0: N words, target N': 1 }, byPart: { summary: 1 } },
        unknown: { messages: 0, byRule: {}, byPart: {} },
      },
    });
    const merged = mergeViolationCounts([v, v]);
    expect(merged.byRule['l1: N words, limit N']).toBe(4);
    expect(merged.byKind.violation.messages).toBe(4);
    expect(merged.byKind.style.messages).toBe(2);
    expect(merged.byKind.note.messages).toBe(2);
  });

  it('reads an untagged (pre-DIG-118) message as kind "unknown" instead of guessing', () => {
    const { db, jobId } = seedRetryStory();
    const base = { jobId, changeUnitId: 4, model: 'm', durationMs: 1, outcome: 'ok' as const };
    logJobCall(db, new Date(), 'digest', { ...base, part: 'summary', violations: 'l1: 72 words, limit 60' });
    const v = violationCounts(db);
    expect(v.byKind.unknown).toEqual({ messages: 1, byRule: { 'l1: N words, limit N': 1 }, byPart: { summary: 1 } });
    expect(v.byKind.violation.messages).toBe(0);
  });

  it('splits a tagged message into its kind and the original text, and passes an untagged one through as "unknown"', () => {
    expect(splitKindTag('violation: l1: 72 words, limit 60')).toEqual({ kind: 'violation', message: 'l1: 72 words, limit 60' });
    expect(splitKindTag('style: why: reads like marketing copy')).toEqual({ kind: 'style', message: 'why: reads like marketing copy' });
    expect(splitKindTag('note: l0: 24 words, target 20')).toEqual({ kind: 'note', message: 'l0: 24 words, target 20' });
    expect(splitKindTag('l1: 72 words, limit 60')).toEqual({ kind: 'unknown', message: 'l1: 72 words, limit 60' });
  });

  it('blanks quoted text, parenthesised details and numbers in a rule name', () => {
    expect(violationRule('names the memory mechanism ("convention in memory"), cite the source'))
      .toBe('names the memory mechanism (…), cite the source');
    expect(violationRule('step 2: range 1 (src/retry.js new 1-48) covers 48 changed lines: split it at the step boundaries'))
      .toBe('step N: range N (…) covers N changed lines: split it at the step boundaries');
  });
});
