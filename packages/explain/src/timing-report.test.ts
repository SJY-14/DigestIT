import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { formatTimingReport, timingReport } from './timing-report.js';
import { logJobCall, startJob } from './jobs.js';

function seed(db: DatabaseSync): number {
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'DigestIT', '/x')").run();
  const r = db.prepare("INSERT INTO change_unit (repo_id, kind, head_sha, title) VALUES (1, 'digest', 'shadow1', 'digest')").run();
  return Number(r.lastInsertRowid);
}

describe('timingReport', () => {
  it('is empty over a DB with no timed calls', () => {
    const db = openDb(':memory:');
    expect(timingReport(db)).toEqual([]);
    expect(formatTimingReport([])).toMatch(/no timed/);
  });

  it('groups by part/model/effort and reports percentiles, excluding untimed and non-ok rows', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const jobId = startJob(db, 'explain', { changeUnitId: id }, 40)!;
    for (const ms of [100, 200, 300]) {
      logJobCall(db, new Date(), 'digest', {
        jobId, part: 'summary', changeUnitId: id, model: 'sonnet', effort: 'low',
        timing: { startupMs: ms, ttftMs: ms, genMs: ms, inputTokens: 1000, outputTokens: 100, promptTokens: 20_000 },
        durationMs: ms, outcome: 'ok',
      });
    }
    logJobCall(db, new Date(), 'digest', {
      jobId, part: 'summary', changeUnitId: id, model: 'sonnet', effort: 'low',
      durationMs: 5, outcome: 'error',
    });
    db.prepare("INSERT INTO explain_call (at, change_unit_id, reason, duration_ms, outcome) VALUES (?, ?, 'digest', 5, 'ok')")
      .run(new Date().toISOString(), id);

    const rows = timingReport(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.part).toBe('summary');
    expect(rows[0]!.model).toBe('sonnet');
    expect(rows[0]!.effort).toBe('low');
    expect(rows[0]!.count).toBe(3);
    expect(rows[0]!.startupMs.p50).toBe(200);
    expect(rows[0]!.inputTokens.p50).toBe(1000);
    expect(rows[0]!.promptTokens.p50).toBe(20_000);
    expect(formatTimingReport(rows)).toContain('summary sonnet/low');
  });

  it('separates rows by model/effort even for the same part', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const jobId = startJob(db, 'area', { changeUnitId: id }, 40)!;
    logJobCall(db, new Date(), 'area', {
      jobId, part: 'walkthrough:ui', changeUnitId: id, model: 'sonnet', effort: 'medium',
      timing: { startupMs: 50, ttftMs: 50, genMs: 50, inputTokens: null, outputTokens: null, promptTokens: null },
      durationMs: 50, outcome: 'ok',
    });
    logJobCall(db, new Date(), 'area', {
      jobId, part: 'walkthrough:ui', changeUnitId: id, model: 'haiku', effort: 'low',
      timing: { startupMs: 20, ttftMs: 20, genMs: 20, inputTokens: null, outputTokens: null, promptTokens: null },
      durationMs: 20, outcome: 'ok',
    });
    expect(timingReport(db)).toHaveLength(2);
  });

  it('groups area:<id> and walkthrough:<id> parts by kind', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const jobId = startJob(db, 'area', { changeUnitId: id }, 40)!;
    for (const part of ['walkthrough:ui', 'walkthrough:server']) {
      logJobCall(db, new Date(), 'area', {
        jobId, part, changeUnitId: id, model: 'sonnet', effort: 'medium',
        timing: { startupMs: 10, ttftMs: 10, genMs: 10, inputTokens: null, outputTokens: null, promptTokens: null },
        durationMs: 30, outcome: 'ok',
      });
    }
    const rows = timingReport(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.part).toBe('walkthrough');
    expect(rows[0]!.count).toBe(2);
  });

  it('excludes calls before `since`', () => {
    const db = openDb(':memory:');
    const id = seed(db);
    const jobId = startJob(db, 'area', { changeUnitId: id }, 40)!;
    const yesterday = new Date(Date.now() - 24 * 3_600_000);
    logJobCall(db, yesterday, 'area', {
      jobId, part: 'walkthrough:ui', changeUnitId: id, model: 'sonnet', effort: 'low',
      timing: { startupMs: 1, ttftMs: 1, genMs: 1, inputTokens: null, outputTokens: null, promptTokens: null },
      durationMs: 1, outcome: 'ok',
    });
    expect(timingReport(db, { since: new Date() })).toEqual([]);
  });
});
