import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import type { DatabaseSync } from 'node:sqlite';
import { BudgetTracker, StubProvider, explainAll, explainUnit, createProvider, RepoNotAllowedError, PROMPT_VERSION, buildPrompt } from './index.js';
import { checkLevels } from './validate.js';
import type { AllLevels, ExplanationInput, ExplanationProvider, ProviderResult } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, '../test/fixtures/3dd6389.json'), 'utf8')) as {
  repoName: string; sha: string; title: string; message: string;
  files: { path: string; status: 'A'; additions: number; deletions: number; patch: string }[];
};
const reference = JSON.parse(readFileSync(join(here, '../test/reference-3dd6389.json'), 'utf8')) as AllLevels;
const goldenPath = join(here, '../test/golden/3dd6389.stub.json');

function seed(db: DatabaseSync, n = 1): number[] {
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'DigestIT', '/x')").run();
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const sha = `sha${i}`;
    // Inserted newest-first on purpose: ordering must come from committed_at, not id.
    db.prepare(`INSERT INTO commit_ (sha, repo_id, author_name, authored_at, committed_at, message) VALUES (?, 1, 'a', ?, ?, ?)`)
      .run(sha, `2026-01-0${n - i}T00:00:00Z`, `2026-01-0${n - i}T00:00:00Z`, `Change ${i}`);
    const r = db.prepare("INSERT INTO change_unit (repo_id, head_sha, title) VALUES (1, ?, ?)").run(sha, `Change ${i}`);
    ids.push(Number(r.lastInsertRowid));
    for (const f of fixture.files) {
      db.prepare('INSERT INTO file_change (change_unit_id, path, status, additions, deletions, patch) VALUES (?, ?, ?, ?, ?, ?)')
        .run(Number(r.lastInsertRowid), f.path, f.status, f.additions, f.deletions, f.patch);
    }
  }
  return ids;
}

class Scripted implements ExplanationProvider {
  readonly id = 'scripted';
  readonly model = 'm';
  inputs: ExplanationInput[] = [];
  constructor(private readonly replies: (unknown | Error)[]) {}
  async explain(input: ExplanationInput): Promise<ProviderResult> {
    this.inputs.push(input);
    const r = this.replies[Math.min(this.inputs.length - 1, this.replies.length - 1)];
    if (r instanceof Error) throw r;
    return { levels: r as AllLevels, provider: this.id, model: this.model };
  }
}
const rows = (db: DatabaseSync) =>
  db.prepare('SELECT change_unit_id, level, status, prompt_version, content FROM explanation ORDER BY change_unit_id, level').all() as unknown as
    { change_unit_id: number; level: number; status: string; prompt_version: string; content: string }[];
const budget = () => new BudgetTracker({ maxCalls: 100, maxTokens: 1e9 });

describe('explainUnit', () => {
  it('stores all four levels from one call and re-running makes no call', async () => {
    const db = openDb(':memory:');
    const [id] = seed(db);
    const p = new Scripted([reference]);
    const r1 = await explainUnit(db, p, id!, budget());
    expect(r1).toMatchObject({ outcome: 'ok', calls: 1 });
    expect(rows(db).map((r) => [r.level, r.status])).toEqual([[0, 'ok'], [1, 'ok'], [2, 'ok'], [3, 'ok']]);
    const r2 = await explainUnit(db, p, id!, budget());
    expect(r2).toMatchObject({ outcome: 'cached', calls: 0 });
    expect(p.inputs).toHaveLength(1);
  });

  it('regenerates when prompt_version is bumped, keeping the old rows', async () => {
    const db = openDb(':memory:');
    const [id] = seed(db);
    const p = new Scripted([reference]);
    await explainUnit(db, p, id!, budget());
    const r = await explainUnit(db, p, id!, budget(), { promptVersion: 'p-next' });
    expect(r.outcome).toBe('ok');
    expect(p.inputs).toHaveLength(2);
    expect(new Set(rows(db).map((x) => x.prompt_version))).toEqual(new Set([PROMPT_VERSION, 'p-next']));
  });

  it('retries once with feedback on invalid output, then stores ok', async () => {
    const db = openDb(':memory:');
    const [id] = seed(db);
    const bad = { ...reference, l0: { text: Array(30).fill('word').join(' ') } };
    const p = new Scripted([bad, reference]);
    const r = await explainUnit(db, p, id!, budget());
    expect(r).toMatchObject({ outcome: 'ok', calls: 2 });
    expect(p.inputs[0]!.retryFeedback).toBeUndefined();
    expect(p.inputs[1]!.retryFeedback?.[0]).toContain('l0: 30 words');
    expect(buildPrompt(p.inputs[1]!)).toContain('rejected for these reasons');
  });

  it('stores sanitised output as truncated after two invalid answers', async () => {
    const db = openDb(':memory:');
    const [id] = seed(db);
    const bad = { ...reference, l3: { annotations: [{ path: 'LICENSE', side: 'new', startLine: 500, endLine: 501, note: 'x' }, ...reference.l3.annotations] } };
    const p = new Scripted([bad]);
    const r = await explainUnit(db, p, id!, budget());
    expect(r).toMatchObject({ outcome: 'truncated', calls: 2 });
    const l3 = JSON.parse(rows(db)[3]!.content);
    expect(l3.annotations).toHaveLength(reference.l3.annotations.length);
    expect(rows(db).every((x) => x.status === 'truncated')).toBe(true);
  });

  it('stores status error when nothing usable comes back, and retries errors on the next run', async () => {
    const db = openDb(':memory:');
    const [id] = seed(db);
    const failing = new Scripted([new Error('boom'), { nope: true }]);
    const r = await explainUnit(db, failing, id!, budget());
    expect(r).toMatchObject({ outcome: 'error', calls: 2 });
    expect(rows(db).every((x) => x.status === 'error')).toBe(true);
    const ok = await explainUnit(db, new Scripted([reference]), id!, budget());
    expect(ok.outcome).toBe('ok');
    expect(rows(db).every((x) => x.status === 'ok')).toBe(true);
  });

  it('does not retry or store when the repo is not allowlisted', async () => {
    const db = openDb(':memory:');
    const [id] = seed(db);
    const p = createProvider({ provider: 'stub', repoAllowlist: ['Other'] });
    await expect(explainUnit(db, p, id!, budget())).rejects.toBeInstanceOf(RepoNotAllowedError);
    expect(rows(db)).toHaveLength(0);
  });
});

describe('explainAll', () => {
  it('backfills oldest-first, respects the concurrency limit, and is a no-op on re-run', async () => {
    const db = openDb(':memory:');
    const ids = seed(db, 5); // ids[4] is the oldest commit
    const order: number[] = [];
    let running = 0;
    let peak = 0;
    const p: ExplanationProvider = {
      id: 'slow', model: 'm',
      async explain(input) {
        order.push(Number(/Change (\d)/.exec(input.title)![1]));
        running++; peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { levels: reference, provider: 'slow', model: 'm' };
      },
    };
    const s1 = await explainAll(db, p, { concurrency: 2 });
    expect(s1).toMatchObject({ total: 5, ok: 5, calls: 5, skippedByBudget: 0 });
    expect(order).toEqual([4, 3, 2, 1, 0]);
    expect(peak).toBe(2);
    expect(ids).toHaveLength(5);
    const s2 = await explainAll(db, p, { concurrency: 2 });
    expect(s2).toMatchObject({ cached: 5, calls: 0 });
    expect(order).toHaveLength(5);
  });

  it('stops at the call budget and continues from there on the next run', async () => {
    const db = openDb(':memory:');
    seed(db, 5);
    const p = new Scripted([reference]);
    const s1 = await explainAll(db, p, { concurrency: 3, budget: { maxCalls: 2 } });
    expect(s1).toMatchObject({ ok: 2, calls: 2, skippedByBudget: 3 });
    const s2 = await explainAll(db, p, { concurrency: 3, budget: { maxCalls: 10 } });
    expect(s2).toMatchObject({ cached: 2, ok: 3, calls: 3 });
  });

  it('honours the token budget', async () => {
    const db = openDb(':memory:');
    seed(db, 4);
    const s = await explainAll(db, new Scripted([reference]), { concurrency: 1, budget: { maxTokens: 1 } });
    expect(s.calls).toBe(1); // first call is always allowed, then the cap holds
    expect(s.skippedByBudget).toBe(3);
  });
});

describe('golden sample for commit 3dd6389', () => {
  it('stub path output matches the checked-in golden file', async () => {
    const db = openDb(':memory:');
    const [id] = seed(db);
    db.prepare('UPDATE change_unit SET title = ? WHERE id = ?').run(fixture.title, id!);
    const r = await explainUnit(db, new StubProvider(), id!, budget());
    expect(r.outcome).toBe('ok');
    const stored = rows(db).map((x) => ({ level: x.level, status: x.status, content: JSON.parse(x.content) }));
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(dirname(goldenPath), { recursive: true });
      writeFileSync(goldenPath, JSON.stringify(stored, null, 1) + '\n');
    }
    expect(stored).toEqual(JSON.parse(readFileSync(goldenPath, 'utf8')));
  });

  it('the worked example from abstraction-levels.md passes validation against the real diff', async () => {
    const db = openDb(':memory:');
    const [id] = seed(db);
    const r = await explainUnit(db, new Scripted([reference]), id!, budget());
    expect(r.outcome).toBe('ok');
    expect(JSON.parse(rows(db)[3]!.content).annotations).toEqual(reference.l3.annotations);
  });

  it('the real-provider (claude-code) golden passes checkLevels against the fixture diff unchanged', () => {
    const golden = JSON.parse(readFileSync(join(here, '../test/golden/3dd6389.claude.json'), 'utf8')) as {
      changeUnit: string; provider: string; promptVersion: string;
      levels: Record<'L0' | 'L1' | 'L2' | 'L3', { status: string; content: unknown }>;
    };
    expect(golden).toMatchObject({ changeUnit: '3dd6389', provider: 'claude-code', promptVersion: PROMPT_VERSION });
    expect(Object.values(golden.levels).map((l) => l.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    const levels = { l0: golden.levels.L0.content, l1: golden.levels.L1.content, l2: golden.levels.L2.content, l3: golden.levels.L3.content };
    const files = fixture.files.map((f) => ({ ...f, filteredReason: null }));
    const r = checkLevels(levels, files)!;
    expect(r).not.toBeNull();
    expect(r.violations).toEqual([]);
    expect(r.levels).toEqual(levels);
  });
});
