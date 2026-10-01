import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { budgetStatus, finishJob, logJobCall, markPartsBudget, setPrepMs, startJob } from './jobs.js';

function seed(db: DatabaseSync): number {
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'DigestIT', '/x')").run();
  const r = db.prepare("INSERT INTO change_unit (repo_id, kind, head_sha, title) VALUES (1, 'digest', 'shadow1', 'digest')").run();
  return Number(r.lastInsertRowid);
}

describe('startJob/finishJob/budgetStatus', () => {
  it('counts a job once no matter how many parts logged ok/error calls against it', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const jobId = startJob(db, 'explain', { repoId: 1, changeUnitId: id }, 5);
    expect(jobId).not.toBeNull();
    logJobCall(db, new Date(), 'digest', { jobId: jobId!, part: 'summary', changeUnitId: id, model: 'sonnet', durationMs: 10, outcome: 'ok' });
    logJobCall(db, new Date(), 'digest', { jobId: jobId!, part: 'area:a', changeUnitId: id, model: 'sonnet', durationMs: 10, outcome: 'ok' });
    expect(budgetStatus(db, new Date())).toBe(1);
    finishJob(db, jobId!);
    const row = db.prepare('SELECT finished_at FROM explain_job WHERE id = ?').get(jobId) as { finished_at: string | null };
    expect(row.finished_at).not.toBeNull();
  });

  it('does not count a job with no ok/error call yet (only a pending/budget row)', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const jobId = startJob(db, 'area', { changeUnitId: id }, 5);
    expect(budgetStatus(db, new Date())).toBe(0);
    expect(jobId).not.toBeNull();
  });

  it('counts a legacy explain_call row (no job_id) as one, alongside jobs', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    db.prepare("INSERT INTO explain_call (at, change_unit_id, reason, duration_ms, outcome) VALUES (?, ?, 'digest', 5, 'ok')")
      .run(new Date().toISOString(), id);
    expect(budgetStatus(db, new Date())).toBe(1);
    const jobId = startJob(db, 'explain', { changeUnitId: id }, 2);
    expect(jobId).not.toBeNull();
    logJobCall(db, new Date(), 'digest', { jobId: jobId!, part: 'summary', changeUnitId: id, model: 'sonnet', durationMs: 5, outcome: 'ok' });
    expect(budgetStatus(db, new Date())).toBe(2);
  });

  it('checks the budget once, at startJob: refuses a new job once the limit is hit, even mid-day', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const jobId = startJob(db, 'area', { changeUnitId: id }, 3, () => now);
      expect(jobId).not.toBeNull();
      logJobCall(db, now, 'area', { jobId: jobId!, part: `walkthrough:a${i}`, changeUnitId: id, model: 'sonnet', durationMs: 1, outcome: 'ok' });
    }
    expect(startJob(db, 'area', { changeUnitId: id }, 3, () => now)).toBeNull();
    expect(budgetStatus(db, now)).toBe(3);
  });

  it('only counts calls from today, not a job started yesterday', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const yesterday = new Date(Date.now() - 24 * 3_600_000);
    const jobId = startJob(db, 'explain', { changeUnitId: id }, 5, () => yesterday);
    logJobCall(db, yesterday, 'digest', { jobId: jobId!, part: 'summary', changeUnitId: id, model: 'sonnet', durationMs: 5, outcome: 'ok' });
    expect(budgetStatus(db, new Date())).toBe(0);
  });

  it('logs the DIG-73 timing columns', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const jobId = startJob(db, 'area', { changeUnitId: id }, 5)!;
    logJobCall(db, new Date(), 'area', {
      jobId, part: 'walkthrough:ui', changeUnitId: id, model: 'sonnet', effort: 'low',
      timing: { startupMs: 100, ttftMs: 200, genMs: 300, inputTokens: 1000, outputTokens: 50, promptTokens: 12_000 },
      durationMs: 600, outcome: 'ok',
    });
    const row = db.prepare('SELECT job_id, part, model, effort, startup_ms, ttft_ms, gen_ms, input_tokens, output_tokens, prompt_tokens FROM explain_call WHERE job_id = ?')
      .get(jobId) as Record<string, unknown>;
    expect(row).toEqual({
      job_id: jobId, part: 'walkthrough:ui', model: 'sonnet', effort: 'low',
      startup_ms: 100, ttft_ms: 200, gen_ms: 300, input_tokens: 1000, output_tokens: 50, prompt_tokens: 12_000,
    });
  });

  it('logs the DIG-94 validation reason when given, and null when omitted', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const jobId = startJob(db, 'area', { changeUnitId: id }, 5)!;
    logJobCall(db, new Date(), 'digest', {
      jobId, part: 'summary', changeUnitId: id, model: 'sonnet', durationMs: 5, outcome: 'ok',
      violations: 'l0: 24 words, limit 20',
    });
    logJobCall(db, new Date(), 'digest', { jobId, part: 'area:a', changeUnitId: id, model: 'sonnet', durationMs: 5, outcome: 'ok' });
    const rows = db.prepare('SELECT part, violations FROM explain_call WHERE job_id = ? ORDER BY part').all(jobId);
    expect(rows).toEqual([{ part: 'area:a', violations: null }, { part: 'summary', violations: 'l0: 24 words, limit 20' }]);
  });
});

describe('setPrepMs / markPartsBudget', () => {
  it('stores prep_ms on the job row', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const jobId = startJob(db, 'explain', { repoId: 1, changeUnitId: id }, 5)!;
    setPrepMs(db, jobId, 42);
    expect(db.prepare('SELECT prep_ms FROM explain_job WHERE id = ?').get(jobId)).toEqual({ prep_ms: 42 });
  });

  it('records a budget outcome per part that does not itself use up the budget', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    markPartsBudget(db, id, ['summary', 'area:a', 'context'], () => new Date());
    const rows = db.prepare('SELECT part, reason, outcome FROM explain_call WHERE change_unit_id = ? ORDER BY part')
      .all(id) as unknown as { part: string; reason: string; outcome: string }[];
    expect(rows.map((r) => [r.part, r.reason, r.outcome])).toEqual([
      ['area:a', 'digest', 'budget'], ['context', 'context', 'budget'], ['summary', 'digest', 'budget'],
    ]);
    expect(budgetStatus(db, new Date())).toBe(0);
  });
});
