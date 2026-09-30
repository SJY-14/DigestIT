import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { StubProvider, type ExplanationProvider, type MemorySummarizeAreasInput, type MemorySummarizeAreasResult } from '@digestit/explain';
import { MemoryWorker } from './memory-worker.js';
import { getMemoryItem, setMemorySummariesEnabled } from './memory.js';
import { updateProjectMemory } from './memory-update.js';
import { areasNeedingSummary } from './memory-summarize.js';
import { ExplainJobRunner } from './explain-job.js';
import { findProject, initProject, type ProjectRow } from './project.js';

let root: string;
let proj: string;
let home: string;
let db: DatabaseSync;

const write = (name: string, content: string) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'digest-memory-worker-'));
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DelayedProvider extends StubProvider {
  delayMs = 0;
  override async summarizeAreas(input: MemorySummarizeAreasInput): Promise<MemorySummarizeAreasResult> {
    if (this.delayMs > 0) await sleep(this.delayMs);
    return super.summarizeAreas(input);
  }
}

function worker(opts: Partial<ConstructorParameters<typeof MemoryWorker>[1]> = {}): MemoryWorker {
  return new MemoryWorker(db, {
    home, providerFactory: () => new StubProvider() as ExplanationProvider, isExplaining: () => false, idleMs: 0, ...opts,
  });
}

describe('MemoryWorker.tick', () => {
  it('drains the summary queue only for a project with summaries enabled', async () => {
    const a = await initWithAreas();
    const b = await (async () => {
      const otherRoot = mkdtempSync(join(tmpdir(), 'digest-memory-worker-b-'));
      const otherProj = join(otherRoot, 'project-b');
      mkdirSync(join(otherProj, 'lib'), { recursive: true });
      writeFileSync(join(otherProj, 'lib/x.ts'), 'export const x = 1;\n');
      const init = await initProject(db, home, otherProj);
      const project = findProject(db, String(init.repoId)) as ProjectRow;
      await updateProjectMemory(db, home, project, 'manual');
      return project;
    })();
    setMemorySummariesEnabled(db, a.id, true);
    // b stays opted out (default off, D1).

    const w = worker();
    // One project's daily sweep per tick (never swept before), then the idle summary drain.
    for (let i = 0; i < 4; i++) {
      w.tick();
      await w.flush();
    }

    expect(areasNeedingSummary(db, a.id)).toHaveLength(0);
    expect(areasNeedingSummary(db, b.id).length).toBeGreaterThan(0);
    const jobs = db.prepare("SELECT count(*) AS n FROM explain_job WHERE kind = 'memory'").get() as { n: number };
    expect(jobs.n).toBe(1);
  });

  it('never starts a summary job while isExplaining() is true', async () => {
    const a = await initWithAreas();
    setMemorySummariesEnabled(db, a.id, true);
    const w = worker({ isExplaining: () => true });
    w.tick();
    await w.flush();
    w.tick();
    await w.flush();
    expect(areasNeedingSummary(db, a.id).length).toBeGreaterThan(0);
    const jobs = db.prepare("SELECT count(*) AS n FROM explain_job WHERE kind = 'memory'").get() as { n: number };
    expect(jobs.n).toBe(0);
  });

  it('respects the daily job share (DIGESTIT_MEMORY_DAILY_JOBS)', async () => {
    const a = await initWithAreas();
    setMemorySummariesEnabled(db, a.id, true);
    const w = worker({ dailyJobShare: 0 });
    w.tick();
    await w.flush();
    w.tick();
    await w.flush();
    expect(areasNeedingSummary(db, a.id).length).toBeGreaterThan(0);
  });

  it('never exceeds the share while a slow summary job is still in flight', async () => {
    for (const dir of ['a', 'b', 'c', 'd', 'e', 'f']) write(`${dir}/m.ts`, `export const ${dir} = 1;\n`);
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    await updateProjectMemory(db, home, project, 'manual');
    setMemorySummariesEnabled(db, project.id, true);
    const slow = new DelayedProvider();
    slow.delayMs = 100;
    const w = worker({ providerFactory: () => slow, dailyJobShare: 1 });
    w.tick();
    await w.flush(); // daily sweep
    w.tick(); // first summary job starts; its call has not been logged yet
    for (let i = 0; i < 5; i++) {
      await sleep(10);
      w.tick();
    }
    await w.flush();
    for (let i = 0; i < 3; i++) {
      w.tick();
      await w.flush();
    }
    expect(areasNeedingSummary(db, project.id).length).toBeGreaterThan(0); // 6 areas, 4 per job
    const jobs = db.prepare("SELECT count(*) AS n FROM explain_job WHERE kind = 'memory'").get() as { n: number };
    expect(jobs.n).toBe(1);
  });

  it('respects the reserve: no memory job starts once too little budget remains for user actions', async () => {
    const a = await initWithAreas();
    setMemorySummariesEnabled(db, a.id, true);
    // Spend the budget down to exactly the reserve by logging fake explain_job/explain_call rows.
    for (let i = 0; i < 35; i++) {
      db.prepare("INSERT INTO explain_job (repo_id, kind, started_at) VALUES (?, 'explain', datetime('now'))").run(a.id);
      const jobId = Number(db.prepare('SELECT last_insert_rowid() AS id').get()!['id' as never]);
      db.prepare("INSERT INTO explain_call (at, reason, duration_ms, outcome, job_id, part) VALUES (datetime('now'), 'digest', 1, 'ok', ?, 'summary')").run(jobId);
    }
    const w = worker({ reserve: 10 }); // 40 - 35 = 5 remaining, under the reserve of 10
    w.tick();
    await w.flush();
    w.tick();
    await w.flush();
    expect(areasNeedingSummary(db, a.id).length).toBeGreaterThan(0);
  });

  it('afterExplain queues a deterministic update immediately, with no LLM call', async () => {
    write('server/api.ts', 'export const a = 1;\n');
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    const w = worker();
    w.afterExplain(project.id);
    await w.flush();
    expect(getMemoryItem(db, project.id, 'area', 'server', null)).not.toBeNull();
    const jobs = db.prepare("SELECT count(*) AS n FROM explain_job WHERE kind = 'memory'").get() as { n: number };
    expect(jobs.n).toBe(0);
  });

  it('manualUpdate resolves once the update actually landed', async () => {
    write('server/api.ts', 'export const a = 1;\n');
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    const w = worker();
    await w.manualUpdate(project.id);
    expect(getMemoryItem(db, project.id, 'area', 'server', null)).not.toBeNull();
  });

  it('an Explain is never slower with the worker busy on a slow summary batch', async () => {
    const a = await initWithAreas();
    setMemorySummariesEnabled(db, a.id, true);
    const slow = new DelayedProvider();
    slow.delayMs = 500;
    const w = worker({ providerFactory: () => slow });
    w.tick();
    await w.flush(); // daily sweep
    w.tick(); // starts the slow summary batch, not awaited here

    write('server/api.ts', 'export const a = 1;\nexport const b = 2;\n');
    const runner = new ExplainJobRunner(db, home);
    const t0 = Date.now();
    const r = await runner.start(a, new StubProvider());
    await r.settled;
    expect(Date.now() - t0).toBeLessThan(400); // well under the summary batch's 500ms delay
    await w.flush();
  });
});
