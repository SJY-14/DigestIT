import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { StubProvider } from './stub.js';
import {
  explainAreaWalkthrough, explainDigestAreaText, explainDigestSummary, finishJob, markPartsBudget, setPrepMs, startJob,
} from './jobs.js';

function seedDigest(db: DatabaseSync, files: { path: string; status?: 'A' | 'M' | 'D'; additions?: number; deletions?: number; patch?: string | null }[]): number {
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'DigestIT', '/x')").run();
  const r = db.prepare("INSERT INTO change_unit (repo_id, kind, head_sha, title) VALUES (1, 'digest', 'shadow1', 'digest')").run();
  const id = Number(r.lastInsertRowid);
  for (const f of files) {
    db.prepare('INSERT INTO file_change (change_unit_id, path, status, additions, deletions, patch) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, f.path, f.status ?? 'M', f.additions ?? 5, f.deletions ?? 1, f.patch === undefined ? '@@ -1,1 +1,5 @@\n+added line\n' : f.patch);
  }
  return id;
}

const jobRow = (db: DatabaseSync, id: number) =>
  db.prepare('SELECT kind, area_id AS areaId, started_at AS startedAt, finished_at AS finishedAt, prep_ms AS prepMs FROM explain_job WHERE id = ?')
    .get(id) as { kind: string; areaId: string | null; startedAt: string; finishedAt: string | null; prepMs: number | null };

describe('startJob / finishJob', () => {
  it('writes one row per action and finishes it', () => {
    const db = openDb(':memory:');
    const changeUnitId = seedDigest(db, [{ path: 'a.ts' }]);
    const id = startJob(db, 'explain', { repoId: 1, changeUnitId }, 40, () => new Date('2026-01-01T00:00:00Z'));
    expect(id).not.toBeNull();
    expect(jobRow(db, id!)).toMatchObject({ kind: 'explain', finishedAt: null });
    setPrepMs(db, id!, 42);
    finishJob(db, id!, () => new Date('2026-01-01T00:00:01Z'));
    const row = jobRow(db, id!);
    expect(row.prepMs).toBe(42);
    expect(row.finishedAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('returns null once today\'s job budget is spent, without writing a row', () => {
    const db = openDb(':memory:');
    const now = () => new Date('2026-01-01T00:00:00Z');
    const changeUnitId = seedDigest(db, [{ path: 'a.ts' }]);
    // Two prior jobs, each with one settled call, count as 2 used units.
    for (let i = 0; i < 2; i++) {
      db.prepare("INSERT INTO explain_job (id, kind, started_at) VALUES (?, 'explain', ?)").run(i + 1, now().toISOString());
      db.prepare("INSERT INTO explain_call (at, change_unit_id, reason, duration_ms, outcome, job_id) VALUES (?, ?, 'digest', 5, 'ok', ?)")
        .run(now().toISOString(), changeUnitId, i + 1);
    }
    expect(startJob(db, 'explain', {}, 2, now)).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM explain_job').get() as { n: number }).toEqual({ n: 2 });
  });

  it('does not count a legacy explain_call with no job_id twice, and counts each such row as one unit', () => {
    const db = openDb(':memory:');
    const now = () => new Date('2026-01-01T00:00:00Z');
    const changeUnitId = seedDigest(db, [{ path: 'a.ts' }]);
    db.prepare("INSERT INTO explain_call (at, change_unit_id, reason, duration_ms, outcome) VALUES (?, ?, 'digest', 5, 'ok')")
      .run(now().toISOString(), changeUnitId);
    expect(startJob(db, 'explain', {}, 1, now)).toBeNull();
    expect(startJob(db, 'explain', {}, 2, now)).not.toBeNull();
  });
});

describe('markPartsBudget', () => {
  it('records a budget outcome per part, restart-recoverable', () => {
    const db = openDb(':memory:');
    const id = seedDigest(db, [{ path: 'a.ts' }]);
    markPartsBudget(db, id, ['summary', 'area:a'], () => new Date('2026-01-01T00:00:00Z'));
    const rows = db.prepare("SELECT part, outcome FROM explain_call WHERE change_unit_id = ?").all(id) as unknown as { part: string; outcome: string }[];
    expect(rows.map((r) => [r.part, r.outcome]).sort()).toEqual([['area:a', 'budget'], ['summary', 'budget']]);
  });
});

describe('explainDigestSummary (interim: one combined call)', () => {
  it('runs the existing digest call and reports it as the summary part', async () => {
    const db = openDb(':memory:');
    const id = seedDigest(db, [{ path: 'apps/web/src/App.tsx' }]);
    const provider = new StubProvider();
    const jobId = startJob(db, 'explain', { changeUnitId: id }, 40, () => new Date())!;
    const r = await explainDigestSummary(db, id, provider, { job: { jobId, budget: 40 } });
    expect(r.outcome).toBe('ok');
    expect(r.calls).toBe(1);
  });
});

describe('explainDigestAreaText (interim: free read of the summary result)', () => {
  it('is "cached" with 0 calls once the area is present in the summary\'s L2', async () => {
    const db = openDb(':memory:');
    const id = seedDigest(db, [{ path: 'apps/web/src/App.tsx' }]);
    const provider = new StubProvider();
    const jobId = startJob(db, 'explain', { changeUnitId: id }, 40, () => new Date())!;
    const summary = await explainDigestSummary(db, id, provider, { job: { jobId, budget: 40 } });
    expect(summary.outcome).toBe('ok');
    const l2 = db.prepare('SELECT content FROM explanation WHERE change_unit_id = ? AND level = 2').get(id) as { content: string };
    const areaId = (JSON.parse(l2.content) as { items: { id: string }[] }).items[0]!.id;
    const r = await explainDigestAreaText(db, id, areaId, provider, { job: { jobId, budget: 40 } });
    expect(r).toEqual({ outcome: 'cached', calls: 0 });
  });

  it('is "error" when the summary did not produce this area id', async () => {
    const db = openDb(':memory:');
    const id = seedDigest(db, [{ path: 'apps/web/src/App.tsx' }]);
    const provider = new StubProvider();
    const jobId = startJob(db, 'explain', { changeUnitId: id }, 40, () => new Date())!;
    await explainDigestSummary(db, id, provider, { job: { jobId, budget: 40 } });
    const r = await explainDigestAreaText(db, id, 'no-such-area', provider, { job: { jobId, budget: 40 } });
    expect(r.outcome).toBe('error');
  });

  it('is "error" with no call when the summary has not run yet', async () => {
    const db = openDb(':memory:');
    const id = seedDigest(db, [{ path: 'apps/web/src/App.tsx' }]);
    const provider = new StubProvider();
    const r = await explainDigestAreaText(db, id, 'settings-ui', provider, { job: { jobId: 1, budget: 40 } });
    expect(r).toEqual({ outcome: 'error', calls: 0, detail: 'area not produced by the summary call' });
  });
});

describe('explainAreaWalkthrough', () => {
  it('reports a real, independent per-area call and calls onProgress once with the final result', async () => {
    const db = openDb(':memory:');
    const id = seedDigest(db, [{ path: 'apps/web/src/App.tsx' }]);
    const provider = new StubProvider();
    // Seed the digest's own L0/L1/L2 explanation rows that explainArea reads for grounding.
    const jobId = startJob(db, 'explain', { changeUnitId: id }, 40, () => new Date())!;
    await explainDigestSummary(db, id, provider, { job: { jobId, budget: 40 } });
    const l2 = db.prepare('SELECT content FROM explanation WHERE change_unit_id = ? AND level = 2').get(id) as { content: string };
    const areaId = (JSON.parse(l2.content) as { items: { id: string }[] }).items[0]!.id;

    const events: { done: boolean }[] = [];
    const r = await explainAreaWalkthrough(db, id, areaId, provider, {
      job: { jobId, budget: 40 }, onProgress: (e) => events.push(e),
    });
    expect(r.outcome).toBe('ok');
    expect(events).toHaveLength(1);
    expect(events[0]!.done).toBe(true);
  });
});
