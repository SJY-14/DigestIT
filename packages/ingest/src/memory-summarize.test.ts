import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import type { AreaMemory, ThreadMemory } from '@digestit/core';
import { StubProvider, startJob, type JobRef, type MemorySummarizeAreasInput, type MemorySummarizeAreasResult } from '@digestit/explain';
import { clearMemory, createBatch, getMemoryItem, upsertMemoryItem } from './memory.js';
import { updateProjectMemory } from './memory-update.js';
import { areasNeedingSummary, pickSummaryWork, runAreaSummaryBatch, runThreadSummaryBatch, threadsNeedingSummary } from './memory-summarize.js';
import { findProject, initProject, prepareExplainDigest, type ProjectRow } from './project.js';

/** No-LLM way to advance the project's checkpoint (packages/ingest/src/memory-update.test.ts), so a
 * test can simulate "the user's edit was digested" without a provider. */
const advanceCheckpoint = (project: ProjectRow, now: () => Date) => prepareExplainDigest(db, home, project, now);

let root: string;
let proj: string;
let home: string;
let db: DatabaseSync;

const write = (name: string, content: string) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'digest-memory-summarize-'));
  proj = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(proj, { recursive: true });
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function initWithAreas(): Promise<ProjectRow> {
  write('server/api.ts', 'export const a = 1;\n');
  write('web/view.ts', 'export const v = 1;\n');
  const init = await initProject(db, home, proj);
  const project = findProject(db, String(init.repoId)) as ProjectRow;
  await updateProjectMemory(db, home, project, 'manual');
  return project;
}

function newJob(db: DatabaseSync, repoId: number): JobRef {
  const jobId = startJob(db, 'memory', { repoId }, 40, () => new Date())!;
  return { jobId, budget: 40 };
}

describe('areasNeedingSummary / pickSummaryWork', () => {
  it('every area with no summary yet is due, capped at 4 per call', async () => {
    const project = await initWithAreas();
    const due = areasNeedingSummary(db, project.id);
    expect(due.map((it) => it.key).sort()).toEqual(['server', 'web']);
    const work = pickSummaryWork(db, project.id);
    expect(work).toEqual({ kind: 'areas', items: due.slice(0, 4) });
  });

  it('an area already summarised at its current fingerprint is not due again', async () => {
    const project = await initWithAreas();
    const job = newJob(db, project.id);
    const before = areasNeedingSummary(db, project.id);
    const r = await runAreaSummaryBatch(db, project, new StubProvider(), before, job, 'idle');
    expect(r.outcome).toBe('ok');
    expect(r.itemsUpdated).toBe(before.length);
    expect(areasNeedingSummary(db, project.id)).toHaveLength(0);
  });

  it('re-extracting after a code change makes only the changed area due again', async () => {
    const project = await initWithAreas();
    const job = newJob(db, project.id);
    await runAreaSummaryBatch(db, project, new StubProvider(), areasNeedingSummary(db, project.id), job, 'idle');
    expect(areasNeedingSummary(db, project.id)).toHaveLength(0);

    write('server/api.ts', 'export const a = 1;\nexport const c = 2;\n');
    await advanceCheckpoint(project, () => new Date());
    await updateProjectMemory(db, home, project, 'manual');
    const due = areasNeedingSummary(db, project.id);
    expect(due.map((it) => it.key)).toEqual(['server']);
  });

  it('writes the summary text and carries it through a later code-only re-extraction', async () => {
    const project = await initWithAreas();
    const job = newJob(db, project.id);
    await runAreaSummaryBatch(db, project, new StubProvider(), areasNeedingSummary(db, project.id), job, 'idle');
    const server = getMemoryItem(db, project.id, 'area', 'server', null)!;
    expect((server.content as AreaMemory).summary).not.toBeNull();
    expect(server.source).toBe('summary');
    expect(server.provenance.jobId).toBe(job.jobId);

    write('web/view.ts', 'export const v = 2;\n');
    await advanceCheckpoint(project, () => new Date());
    await updateProjectMemory(db, home, project, 'manual');
    const serverAfter = getMemoryItem(db, project.id, 'area', 'server', null)!;
    expect((serverAfter.content as AreaMemory).summary).toBe((server.content as AreaMemory).summary);
    expect(serverAfter.source).toBe('summary');
  });

  it('drops the result for an area that changed during the call, keeping its newer content', async () => {
    const project = await initWithAreas();
    const job = newJob(db, project.id);
    class ChangingProvider extends StubProvider {
      override async summarizeAreas(input: MemorySummarizeAreasInput): Promise<MemorySummarizeAreasResult> {
        const server = getMemoryItem(db, project.id, 'area', 'server', null)!;
        const batchId = createBatch(db, project.id, 'after-explain', null);
        upsertMemoryItem(db, batchId, project.id, 'area', 'server', null,
          { ...(server.content as AreaMemory), fingerprint: 'moved', fileCount: 9 }, 'code', server.provenance);
        return super.summarizeAreas(input);
      }
    }
    const r = await runAreaSummaryBatch(db, project, new ChangingProvider(), areasNeedingSummary(db, project.id), job, 'idle');
    expect(r.itemsUpdated).toBe(1); // web only
    const server = getMemoryItem(db, project.id, 'area', 'server', null)!;
    expect((server.content as AreaMemory).summary).toBeNull();
    expect((server.content as AreaMemory).fingerprint).toBe('moved');
    expect((server.content as AreaMemory).fileCount).toBe(9);
    expect((getMemoryItem(db, project.id, 'area', 'web', null)!.content as AreaMemory).summary).not.toBeNull();
  });

  it('does not recreate an area cleared during the call', async () => {
    const project = await initWithAreas();
    const job = newJob(db, project.id);
    class ClearingProvider extends StubProvider {
      override async summarizeAreas(input: MemorySummarizeAreasInput): Promise<MemorySummarizeAreasResult> {
        clearMemory(db, project.id);
        return super.summarizeAreas(input);
      }
    }
    const r = await runAreaSummaryBatch(db, project, new ClearingProvider(), areasNeedingSummary(db, project.id), job, 'idle');
    expect(r.itemsUpdated).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM memory_item WHERE repo_id = ?').get(project.id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM memory_batch WHERE repo_id = ?').get(project.id)).toEqual({ n: 0 });
  });

  it('logs an explain_call with part memory, reason memory, against the given job', async () => {
    const project = await initWithAreas();
    const job = newJob(db, project.id);
    await runAreaSummaryBatch(db, project, new StubProvider(), areasNeedingSummary(db, project.id), job, 'idle');
    const rows = db.prepare("SELECT part, reason, outcome, job_id AS jobId FROM explain_call WHERE reason = 'memory'").all() as
      { part: string; reason: string; outcome: string; jobId: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ part: 'memory', reason: 'memory', outcome: 'ok', jobId: job.jobId });
  });
});

describe('threadsNeedingSummary / runThreadSummaryBatch', () => {
  it('a thread with a digest and no summary is due; summarising clears it from the due list', async () => {
    write('server/api.ts', 'export const a = 1;\n');
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    db.prepare(
      `INSERT INTO change_unit (repo_id, kind, head_sha, title) VALUES (?, 'digest', 'deadbeef', 'first change')`,
    ).run(project.id);
    const changeUnitId = Number(db.prepare('SELECT last_insert_rowid() AS id').get()!['id' as never]);
    db.prepare(
      `INSERT INTO digest (change_unit_id, repo_id, from_checkpoint_id, to_checkpoint_id, language, created_at, areas)
       VALUES (?, ?, 1, 1, 'en', '2026-09-01T00:00:00Z', ?)`,
    ).run(changeUnitId, project.id, JSON.stringify([{ id: 'server', label: 'server' }]));
    db.prepare(`INSERT INTO explanation (change_unit_id, level, status, content, provider, model, prompt_version, input_hash, created_at)
      VALUES (?, 0, 'ok', ?, 'stub', 'stub', 'v1', 'h', '2026-09-01T00:00:00Z')`)
      .run(changeUnitId, JSON.stringify({ text: 'a first change to the server area' }));
    await updateProjectMemory(db, home, project, 'manual');

    const due = threadsNeedingSummary(db, project.id);
    expect(due.length).toBeGreaterThan(0);
    const job = newJob(db, project.id);
    const r = await runThreadSummaryBatch(db, project, new StubProvider(), due[0]!, job, 'idle');
    expect(r.outcome).toBe('ok');
    expect(threadsNeedingSummary(db, project.id)).toHaveLength(0);
  });
});
