import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import type { AreaMemory, ThreadMemory } from '@digestit/core';
import { getMemoryItem, listMemoryItems, createBatch, upsertMemoryItem } from './memory.js';
import { changedTerms, updateThreads } from './memory-threads.js';
// @ts-expect-error -- plain .mjs fixture shared with the A/B kit, no type declarations
import { SNAPBACK_INIT, SNAPBACK_STORY } from '../test/fixtures/memory-ab-story.mjs';

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

/** One `file_change` row per path, with `patch` as the stored unified diff. */
function insertPatches(db: DatabaseSync, id: number, patches: Record<string, string>): void {
  for (const [path, patch] of Object.entries(patches)) {
    db.prepare("INSERT INTO file_change (change_unit_id, path, status, patch) VALUES (?, ?, 'M', ?)").run(id, path, patch);
  }
}

/** A minimal unified diff for `path` whose hunk has the given context (' '), added ('+') and removed ('-') lines. */
const patch = (path: string, ...lines: string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1,3 +1,3 @@', ...lines].join('\n');

function insertL2(db: DatabaseSync, id: number, createdAt: string, how: string): void {
  const content = { items: [{ title: 'Area', effect: 'Effect.', how, why: 'Why.', paths: ['src/x.js'] }] };
  db.prepare(
    `INSERT INTO explanation (change_unit_id, level, content, status, provider, model, prompt_version, input_hash, created_at)
     VALUES (?, 2, ?, 'ok', 'stub', 'm', 'v1', 'h', ?)`,
  ).run(id, JSON.stringify(content), createdAt);
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

  it('takes terms from the lines the diff adds or removes, never from L0, L2 or context lines (DIG-121)', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'src' }], 'Failed requests now retry; see memoize.');
    insertL2(db, 1, '2026-09-01T00:00:00.000Z', 'Adds `withRetry` next to `request`, unlike `memoize`.');
    insertPatches(db, 1, { 'src/retry.js': patch('src/retry.js', " export { request } from './http.js';", '+export async function withRetry(fn) {}') });
    const batch = createBatch(db, repoId, 'manual', null, now('2026-09-03T00:00:00.000Z'));
    updateThreads(db, batch, repoId, new Set(['withRetry', 'memoize', 'request']), now('2026-09-03T00:00:00.000Z'));
    expect((listMemoryItems(db, repoId, { kind: 'thread' })[0]!.content as ThreadMemory).terms).toEqual(['withRetry']);
  });

  it('changedTerms reads removed lines too, and skips headers and lines outside a hunk', () => {
    const p = ['diff --git a/src/a.js b/src/a.js', '--- a/src/withRetry.js', '+++ b/src/withRetry.js', '@@ -1 +1 @@', '-withRetry()', '+retryRequest()'].join('\n');
    expect(changedTerms([p, null], new Set(['withRetry', 'retryRequest', 'HttpError']))).toEqual(['retryRequest', 'withRetry']);
  });

  it('same folder, both with terms, none shared: separate threads (DIG-114)', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'src' }], 'Failed requests now retry automatically.');
    insertPatches(db, 1, { 'src/retry.js': patch('src/retry.js', '+export function withRetry() {}') });
    insertDigest(db, repoId, 2, '2026-09-02T00:00:00.000Z', [{ label: 'src' }], 'Repeated GET requests are served from a cache.');
    insertPatches(db, 2, { 'src/cache.js': patch('src/cache.js', '+export function memoize() {}') });
    insertDigest(db, repoId, 3, '2026-09-03T00:00:00.000Z', [{ label: 'src' }], 'Retries now back off between attempts.');
    insertPatches(db, 3, { 'src/retry.js': patch('src/retry.js', '-export function withRetry() {}', '+export function withRetry(baseMs) {}') });
    const batch = createBatch(db, repoId, 'manual', null, now('2026-09-04T00:00:00.000Z'));
    updateThreads(db, batch, repoId, new Set(['withRetry', 'memoize']), now('2026-09-04T00:00:00.000Z'));

    const threads = listMemoryItems(db, repoId, { kind: 'thread' }).map((t) => t.content as ThreadMemory);
    expect(threads.map((t) => t.digests.map((d) => d.digestId)).sort()).toEqual([[1, 3], [2]]);
  });

  it('a digest without terms never joins a thread that has some, even in the same folder (DIG-121)', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'src' }], 'Failed requests now retry automatically.');
    insertPatches(db, 1, { 'src/retry.js': patch('src/retry.js', '+export function withRetry() {}') });
    insertDigest(db, repoId, 2, '2026-09-02T00:00:00.000Z', [{ label: 'src' }], 'Tidies up comments.');
    insertPatches(db, 2, { 'src/http.js': patch('src/http.js', '-// old', '+// new') });
    const batch = createBatch(db, repoId, 'manual', null, now('2026-09-03T00:00:00.000Z'));
    updateThreads(db, batch, repoId, new Set(['withRetry']), now('2026-09-03T00:00:00.000Z'));
    expect(listMemoryItems(db, repoId, { kind: 'thread' })).toHaveLength(2);
  });

  it('same folder, neither side with terms: area overlap still joins', () => {
    const { db, repoId } = setup();
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'docs' }], 'Explains setup.');
    insertDigest(db, repoId, 2, '2026-09-02T00:00:00.000Z', [{ label: 'docs' }], 'Explains configuration.');
    const batch = createBatch(db, repoId, 'manual', null, now('2026-09-03T00:00:00.000Z'));
    updateThreads(db, batch, repoId, new Set(['withRetry']), now('2026-09-03T00:00:00.000Z'));
    expect(listMemoryItems(db, repoId, { kind: 'thread' })).toHaveLength(1);
  });

  it('a shared term joins across directly linked areas (tests uses src), not unlinked ones (DIG-121)', () => {
    const { db, repoId } = setup();
    const b0 = createBatch(db, repoId, 'manual', null, now('2026-09-01T00:00:00.000Z'));
    const areaItem = (path: string, uses: string[], usedBy: string[]): void => {
      const content: AreaMemory = { kind: 'area', path, fileCount: 1, exports: [], uses, usedBy, doc: null, summary: null, fingerprint: path };
      upsertMemoryItem(db, b0, repoId, 'area', path, null, content, 'code', { files: [], checkpointId: null, digestIds: [], jobId: null }, now('2026-09-01T00:00:00.000Z'));
    };
    areaItem('src', [], ['tests']);
    areaItem('tests', ['src'], []);
    areaItem('docs', [], []);
    insertDigest(db, repoId, 1, '2026-09-01T00:00:00.000Z', [{ label: 'src' }], 'Failed requests now retry automatically.');
    insertPatches(db, 1, { 'src/retry.js': patch('src/retry.js', '+export function withRetry() {}') });
    insertDigest(db, repoId, 2, '2026-09-02T00:00:00.000Z', [{ label: 'tests' }], 'Retries are now tested.');
    insertPatches(db, 2, { 'tests/retry.test.js': patch('tests/retry.test.js', "+import { withRetry } from '../src/retry.js';") });
    insertDigest(db, repoId, 3, '2026-09-03T00:00:00.000Z', [{ label: 'docs' }], 'Documents retries.');
    insertPatches(db, 3, { 'docs/retry.md': patch('docs/retry.md', '+Call withRetry(fn).') });
    const batch = createBatch(db, repoId, 'manual', null, now('2026-09-04T00:00:00.000Z'));
    updateThreads(db, batch, repoId, new Set(['withRetry']), now('2026-09-04T00:00:00.000Z'));
    const threads = listMemoryItems(db, repoId, { kind: 'thread' }).map((t) => t.content as ThreadMemory);
    expect(threads.map((t) => t.digests.map((d) => d.digestId)).sort()).toEqual([[1, 2], [3]]);
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

// ---------------------------------------------------------------------------
// The snapback story (packages/ingest/test/fixtures/memory-ab-story.mjs), DIG-121
// ---------------------------------------------------------------------------

type StoryStep = { dayOffset: number; kind: 'files' | 'note'; message: string; write?: Record<string, string> };

/** `git diff --no-index` between two versions of one file: the same unified diff shape the shadow store records. */
function gitPatch(dir: string, path: string, before: string | undefined, after: string): string {
  const a = join(dir, 'a'), b = join(dir, 'b');
  writeFileSync(a, before ?? '');
  writeFileSync(b, after);
  try {
    execFileSync('git', ['diff', '--no-index', '--no-color', '-U3', a, b], { encoding: 'utf8' });
    return '';
  } catch (e) {
    return ((e as { stdout: string }).stdout).replaceAll(a, `a/${path}`).replaceAll(b, `b/${path}`);
  }
}

const areaLabel = (path: string): string => (path.includes('/') ? path.slice(0, path.indexOf('/')) : 'project root');

/**
 * Replays the story's file steps as digests with real patches and an L0 in `language` that differs
 * on purpose between languages (and names identifiers in one but not the other), then threads them.
 * Returns each thread's story step numbers (1-based, counting only file steps, as the kit's pairs do).
 */
function threadStory(language: 'en' | 'ko'): number[][] {
  const { db, repoId } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'digestit-threads-'));
  try {
    const tree: Record<string, string> = { ...SNAPBACK_INIT.write };
    const base = Date.parse('2026-10-08T10:00:00.000Z');
    const steps = (SNAPBACK_STORY as StoryStep[]).filter((s) => s.kind === 'files');
    steps.forEach((step, i) => {
      const id = i + 1;
      const at = new Date(base + step.dayOffset * 24 * 60 * 60 * 1000).toISOString();
      const paths = Object.keys(step.write!);
      const l0 = language === 'en'
        ? `${step.message}, continuing the retry work from three days earlier.`
        : `${step.message} 작업으로, 3일 전 재시도 작업을 이어갑니다.`;
      insertDigest(db, repoId, id, at, [...new Set(paths.map((p) => areaLabel(p)))].map((label) => ({ label })), l0);
      if (language === 'en') insertL2(db, id, at, 'Touches `request`, `withRetry`, `HttpError` and `cached`.');
      insertPatches(db, id, Object.fromEntries(paths.map((p) => [p, gitPatch(dir, p, tree[p], step.write![p]!)])));
      Object.assign(tree, step.write);
    });
    // The areas the extractor finds for the story's final tree: `tests` imports `src`.
    const b0 = createBatch(db, repoId, 'manual', null, now('2026-10-08T10:00:00.000Z'));
    for (const [path, uses, usedBy] of [['src', [], ['tests']], ['tests', ['src'], []], ['', [], []]] as const) {
      const content: AreaMemory = { kind: 'area', path, fileCount: 1, exports: [], uses: [...uses], usedBy: [...usedBy], doc: null, summary: null, fingerprint: path };
      upsertMemoryItem(db, b0, repoId, 'area', path, null, content, 'code', { files: [], checkpointId: null, digestIds: [], jobId: null }, now('2026-10-08T10:00:00.000Z'));
    }
    // Every name the story's code exports; `withRetry` is stale after the rename but still a term.
    const terms = new Set(['request', 'withRetry', 'retryRequest', 'HttpError', 'cached']);
    const batch = createBatch(db, repoId, 'manual', null, now('2026-10-08T11:00:00.000Z'));
    updateThreads(db, batch, repoId, terms, now('2026-10-08T11:00:00.000Z'));
    return listMemoryItems(db, repoId, { kind: 'thread' })
      .map((t) => (t.content as ThreadMemory).digests.map((d) => d.digestId))
      .sort((a, b) => a[0]! - b[0]!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('updateThreads on the snapback story (DIG-121)', () => {
  it('puts all the retry work in one thread and every unrelated change outside it', () => {
    const threads = threadStory('en');
    const retry = threads.find((t) => t.includes(1))!;
    expect(retry).toEqual([1, 3, 4, 6, 8, 10]);
    for (const other of [2, 5, 7, 9]) expect(retry).not.toContain(other);
  });

  it('groups the same commits the same way in en and ko, whatever the L0 and L2 say', () => {
    expect(threadStory('ko')).toEqual(threadStory('en'));
  });
});
