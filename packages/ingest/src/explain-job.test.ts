import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type AreaProgressEvent, type DigestPartsDto } from '@digestit/core';
import {
  StubProvider, type AreaInput, type AreaResult, type AreaStreamChunk, type ContextInput, type ContextResult,
  type DigestAreaTextInput, type DigestAreaTextResult, type DigestSummaryInput, type DigestSummaryResult,
} from '@digestit/explain';
import { AreaExplainRunningError, ExplainJobRunner, explainProject, retryDigest } from './explain-job.js';
import { findProject, initProject, ProjectLockedError, type ProjectRow } from './project.js';

let root: string;
let proj: string;
let home: string;
let db: DatabaseSync;

const write = (name: string, content: string) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'digest-explain-job-'));
  proj = join(root, 'my-project');
  home = join(root, 'home');
  mkdirSync(proj, { recursive: true });
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Registers the project, then edits files in three places: areas `server`, `web` and the root. */
async function initAndEdit(): Promise<ProjectRow> {
  write('server/api.ts', 'export const a = 1;\n');
  write('web/view.ts', 'export const v = 1;\n');
  write('README.md', '# my-project\n');
  const init = await initProject(db, home, proj);
  write('server/api.ts', 'export const a = 2;\nexport const b = 3;\n');
  write('web/view.ts', 'export const v = 2;\n');
  write('README.md', '# my-project\n\nA demo.\n');
  return findProject(db, String(init.repoId)) as ProjectRow;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open: () => void = () => {};
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
};

interface Span { part: string; start: number; end: number }

/** The stub provider, with per-part delays, failures and a log of every call's span and input. */
class ScriptedProvider extends StubProvider {
  spans: Span[] = [];
  contexts: Record<string, string | undefined> = {};
  delay: Record<string, number> = {};
  wait: Record<string, Promise<void>> = {};
  /** Parts that throw on each attempt while their counter is > 0. */
  fail: Record<string, number> = {};
  inFlight = 0;
  maxInFlight = 0;

  private async around<T>(part: string, context: string | undefined, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      this.contexts[part] = context;
      if (this.wait[part]) await this.wait[part];
      if (this.delay[part]) await sleep(this.delay[part]!);
      if ((this.fail[part] ?? 0) > 0) {
        this.fail[part]!--;
        throw new Error(`${part} failed`);
      }
      return await fn();
    } finally {
      this.inFlight--;
      this.spans.push({ part, start, end: Date.now() });
    }
  }

  override explainDigestSummary(input: DigestSummaryInput): Promise<DigestSummaryResult> {
    return this.around('summary', input.context, () => super.explainDigestSummary(input));
  }
  override explainDigestAreaText(input: DigestAreaTextInput): Promise<DigestAreaTextResult> {
    return this.around(`area:${input.area.id}`, input.context, () => super.explainDigestAreaText(input));
  }
  override explainContext(input: ContextInput): Promise<ContextResult> {
    return this.around('context', undefined, () => super.explainContext(input));
  }
  override explainArea(input: AreaInput, onProgress?: (chunk: AreaStreamChunk) => void): Promise<AreaResult> {
    return this.around('walkthrough', input.context, () => super.explainArea(input, onProgress));
  }
  calls(part: string): number {
    return this.spans.filter((s) => s.part === part).length;
  }
}

const provider = () => new ScriptedProvider();

async function settle(runner: ExplainJobRunner, digestId: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!runner.isDone(digestId)) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the job to settle');
    await sleep(5);
  }
}

describe('ExplainJobRunner.start', () => {
  it('stores the deterministic areas and returns before a slow provider finishes', async () => {
    const project = await initAndEdit();
    const p = provider();
    p.delay.summary = 1500;
    p.delay['area:server'] = 1500;
    const runner = new ExplainJobRunner(db, home);
    const t0 = Date.now();
    const r = await runner.start(project, p);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.noChanges).toBe(false);
    expect(runner.isDone(r.digestId!)).toBe(false);
    const parts = runner.getParts(r.digestId!)!;
    expect(Object.keys(parts.areas).sort()).toEqual(['project-root', 'server', 'web']);
    expect(parts.summary === 'pending' || parts.summary === 'running').toBe(true);
    const job = db.prepare('SELECT prep_ms AS prepMs, finished_at AS finishedAt FROM explain_job WHERE change_unit_id = ?')
      .get(r.digestId!) as { prepMs: number; finishedAt: string | null };
    expect(job.prepMs).toBeGreaterThanOrEqual(0);
    expect(job.finishedAt).toBeNull();
    const report = await r.settled;
    expect(report.parts.map((x) => x.part).sort()).toEqual(['area:project-root', 'area:server', 'area:web', 'context', 'summary']);
    const done = runner.getParts(r.digestId!)!;
    expect(done.summary).toBe('ok');
    expect(Object.values(done.areas)).toEqual(['ok', 'ok', 'ok']);
    expect(done.finishedAt).not.toBeNull();
  });

  it('409s a second Explain while the first runs, and releases the lock once it settles', async () => {
    const project = await initAndEdit();
    const p = provider();
    const g = gate();
    p.wait.summary = g.promise;
    const runner = new ExplainJobRunner(db, home);
    const r = await runner.start(project, p);
    await expect(runner.start(project, p)).rejects.toThrow(ProjectLockedError);
    await expect(runner.retry(project, r.digestId!, p)).rejects.toThrow(ProjectLockedError);
    g.open();
    await r.settled;
    expect((await runner.start(project, p)).noChanges).toBe(true);
  });

  it('with the day\'s budget spent: no provider call, every part `budget`, the digest still has files and areas', async () => {
    const project = await initAndEdit();
    const p = provider();
    const runner = new ExplainJobRunner(db, home, { budget: 0 });
    const r = await runner.start(project, p);
    const report = await r.settled;
    expect(report.jobId).toBeNull();
    expect(p.spans).toEqual([]);
    const parts = runner.getParts(r.digestId!)!;
    expect(parts.summary).toBe('budget');
    expect(parts.context).toBe('budget');
    expect(Object.values(parts.areas)).toEqual(['budget', 'budget', 'budget']);
    expect(runner.isDone(r.digestId!)).toBe(true);
    const files = db.prepare('SELECT count(*) AS n FROM file_change WHERE change_unit_id = ?').get(r.digestId!) as { n: number };
    expect(files.n).toBe(3);
    expect(db.prepare('SELECT count(*) AS n FROM explain_job').get()).toEqual({ n: 0 });

    // Tomorrow's budget (a bigger limit here) runs exactly the parts marked `budget`.
    const later = new ExplainJobRunner(db, home, { budget: 40 });
    const retry = await later.retry(project, r.digestId!, p);
    await retry.settled;
    const after = later.getParts(r.digestId!)!;
    expect(after.summary).toBe('ok');
    expect(Object.values(after.areas)).toEqual(['ok', 'ok', 'ok']);
    expect(after.context).toBe('ok');
  });

  it('parts settle independently, in order of completion, and summary is queued first', async () => {
    const project = await initAndEdit();
    const p = provider();
    p.delay['area:web'] = 10;
    p.delay.summary = 60;
    p.delay['area:server'] = 120;
    p.delay['area:project-root'] = 180;
    const runner = new ExplainJobRunner(db, home, { maxInFlight: 4 });
    const r = await runner.start(project, p);
    const order: string[] = [];
    const seen = new Set<string>();
    runner.subscribeParts(r.digestId!, (dto: DigestPartsDto) => {
      const entries: [string, string][] = [['summary', dto.summary], ...Object.entries(dto.areas).map(([k, v]) => [`area:${k}`, v] as [string, string])];
      for (const [k, v] of entries) {
        if (!seen.has(k) && v !== 'pending' && v !== 'running') {
          seen.add(k);
          order.push(k);
        }
      }
    });
    await r.settled;
    expect(order).toEqual(['area:web', 'summary', 'area:server', 'area:project-root']);
    expect(p.spans.find((s) => s.part === 'summary')!.start).toBeLessThanOrEqual(p.spans.find((s) => s.part === 'area:web')!.start);
  });

  it('keeps at most `maxInFlight` provider calls running at once', async () => {
    const project = await initAndEdit();
    const p = provider();
    for (const k of ['summary', 'area:server', 'area:web', 'area:project-root', 'context']) p.delay[k] = 30;
    const r = await new ExplainJobRunner(db, home, { maxInFlight: 2 }).start(project, p);
    await r.settled;
    expect(p.maxInFlight).toBe(2);
  });

  it('on a first Explain, context builds in parallel and the parts are grounded on the compact project map', async () => {
    const project = await initAndEdit();
    const p = provider();
    p.delay.context = 150;
    p.delay.summary = 150;
    const runner = new ExplainJobRunner(db, home);
    const r = await runner.start(project, p);
    const t0 = Date.now(); // after the no-LLM prep
    const report = await r.settled;
    const elapsed = Date.now() - t0;
    const ctx = p.spans.find((s) => s.part === 'context')!;
    const sum = p.spans.find((s) => s.part === 'summary')!;
    expect(Math.min(ctx.end, sum.end) - Math.max(ctx.start, sum.start)).toBeGreaterThan(100); // overlapping
    expect(elapsed).toBeLessThan(290); // serial would be >= 300 ms
    expect(p.contexts.summary).toContain('server/api.ts'); // the rendered map, not an LLM description
    expect(report.parts.find((x) => x.part === 'context')!.status).toBe('ok');
    expect(runner.getParts(r.digestId!)!.context).toBe('ok');

    // The next Explain uses the LLM context and reports `context` as skipped (no refresh needed).
    write('web/view.ts', 'export const v = 3;\n');
    const p2 = provider();
    const r2 = await runner.start(project, p2);
    await r2.settled;
    expect(p2.calls('context')).toBe(0);
    expect(p2.contexts.summary).toBeDefined();
    expect(p2.contexts.summary).not.toContain('server/api.ts\n');
    expect(runner.getParts(r2.digestId!)!.context).toBe('skipped');
    expect(runner.getParts(r.digestId!)!.context).toBe('ok');
  });
});

describe('ExplainJobRunner.retry', () => {
  it('a failing area does not block the others, and a retry re-runs only that area', async () => {
    const project = await initAndEdit();
    const p = provider();
    p.fail['area:web'] = 2; // both attempts of the first job
    const runner = new ExplainJobRunner(db, home);
    const r = await runner.start(project, p);
    const report = await r.settled;
    expect(report.parts.find((x) => x.part === 'area:web')!.status).toBe('error');
    const parts = runner.getParts(r.digestId!)!;
    expect(parts.areas).toEqual({ 'project-root': 'ok', server: 'ok', web: 'error' });
    expect(parts.summary).toBe('ok');
    const l2 = JSON.parse((db.prepare('SELECT content FROM explanation WHERE change_unit_id = ? AND level = 2').get(r.digestId!) as { content: string }).content);
    expect(l2.items.map((it: { id: string }) => it.id).sort()).toEqual(['project-root', 'server']);

    const before = p.spans.length;
    const retry = await runner.retry(project, r.digestId!, p);
    const retried = await retry.settled!;
    expect(retried.parts.map((x) => x.part)).toEqual(['area:web']);
    expect(p.spans.slice(before).map((s) => s.part)).toEqual(['area:web']);
    expect(runner.getParts(r.digestId!)!.areas).toEqual({ 'project-root': 'ok', server: 'ok', web: 'ok' });
    const job = db.prepare("SELECT count(*) AS n FROM explain_job WHERE kind = 'retry'").get() as { n: number };
    expect(job.n).toBe(1);

    expect((await runner.retry(project, r.digestId!, p)).settled).toBeNull();
  });
});

describe('ExplainJobRunner restart recovery', () => {
  it('parts with nothing stored and no live job read as `error`; stored parts keep their status', async () => {
    const project = await initAndEdit();
    const p = provider();
    const g = gate();
    p.wait['area:server'] = g.promise;
    p.wait['area:project-root'] = g.promise;
    p.wait['area:web'] = g.promise;
    const runner = new ExplainJobRunner(db, home);
    const r = await runner.start(project, p);
    while (runner.getParts(r.digestId!)!.summary !== 'ok') await sleep(5);

    // A restarted server: same DB, a fresh runner with no in-memory job.
    const restarted = new ExplainJobRunner(db, home);
    const parts = restarted.getParts(r.digestId!)!;
    expect(parts.summary).toBe('ok');
    expect(parts.areas).toEqual({ 'project-root': 'error', server: 'error', web: 'error' });
    expect(parts.finishedAt).toBeNull();
    expect(restarted.isDone(r.digestId!)).toBe(true);
    g.open();
    await r.settled;
  });
});

describe('ExplainJobRunner.startArea', () => {
  it('returns at once, streams progress, ends with the stored walkthrough as `done`, and 409s a duplicate click', async () => {
    const project = await initAndEdit();
    const runner = new ExplainJobRunner(db, home);
    const r = await runner.start(project, provider());
    await r.settled;

    const p = provider();
    const g = gate();
    p.wait.walkthrough = g.promise;
    const events: AreaProgressEvent[] = [];
    const unsub = runner.subscribeAreaProgress(r.digestId!, (e) => events.push(e));
    const started = await runner.startArea(project, r.digestId!, 'server', p);
    expect(started.settled).not.toBeNull();
    expect(runner.isAreaRunning(r.digestId!, 'server')).toBe(true);
    expect(runner.isDone(r.digestId!)).toBe(false);
    await expect(runner.startArea(project, r.digestId!, 'server', p)).rejects.toThrow(AreaExplainRunningError);
    g.open();
    expect((await started.settled!).outcome).toBe('ok');
    unsub();
    expect(runner.isDone(r.digestId!)).toBe(true);
    const last = events[events.length - 1]!;
    expect(last.done).toBe(true);
    expect(last.steps.length).toBeGreaterThan(0);
    expect(events.slice(0, -1).every((e) => !e.done)).toBe(true);
    const job = db.prepare("SELECT area_id AS areaId, finished_at AS finishedAt FROM explain_job WHERE kind = 'area'").get() as { areaId: string; finishedAt: string | null };
    expect(job.areaId).toBe('server');
    expect(job.finishedAt).not.toBeNull();
  });
});

describe('explainProject / retryDigest (the CLI path)', () => {
  it('waits for every part and reports per-part timing', async () => {
    const project = await initAndEdit();
    const p = provider();
    p.fail.summary = 2;
    const r = await explainProject(db, home, project, p, { budget: 40 });
    expect(r.outcome).toBe('error');
    expect(r.detail).toMatch(/^summary: /);
    expect(r.report!.parts.every((x) => x.ms >= 0)).toBe(true);
    const again = await retryDigest(db, home, r.digestId!, p, { budget: 40 });
    expect(again.outcome).toBe('ok');
    expect(again.report!.parts.map((x) => x.part)).toEqual(['summary']);
  });
});
