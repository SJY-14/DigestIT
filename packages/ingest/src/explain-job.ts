// Fast Explain (DIG-75, docs/explain-speed.md §5): the async Explain job runner. `POST
// /api/projects/:id/explain` used to hold its HTTP response open for the whole LLM call (the ~50s/
// ~100s problem the doc measures); this runner does the fast, no-LLM prep synchronously (checkpoint,
// digest row, deterministic areas), then runs the LLM parts in the background while the caller
// returns right away. Part status is derived from stored rows plus this runner's in-memory running
// set (see `getParts`), so a server restart never leaves a part `running` forever: with no live
// entry and nothing stored, it reads `error`.
import type { DatabaseSync } from 'node:sqlite';
import type {
  AreaProgressEvent, DigestAreaSkeleton, DigestL2Content, DigestPartsDto, PartStatus,
} from '@digestit/core';
import {
  type ExplainJobKind, type ExplanationProvider, type JobRef, type PartOutcome, finishJob,
  markPartsBudget, renderMap, setPrepMs, startJob,
  explainAreaWalkthrough as realExplainAreaWalkthrough,
  explainDigestAreaText as realExplainDigestAreaText,
  explainDigestSummary as realExplainDigestSummary,
} from '@digestit/explain';
import { projectDataDir } from './datahome.js';
import { DEFAULT_DAILY_BUDGET } from './scheduler.js';
import { ensureContext, latestContextText, mapOfTree } from './project-context.js';
import {
  acquireProjectLock, latestCheckpoint, prepareExplainDigest, releaseProjectLock,
  type ProjectRow,
} from './project.js';
import { openShadow } from './shadow.js';

export class AreaExplainRunningError extends Error {
  constructor() {
    super('an L3 explain is already running for this area');
    this.name = 'AreaExplainRunningError';
  }
}

type PartKey = 'summary' | 'context' | `area:${string}`;

/** A tiny concurrency gate: at most `max` callbacks run at once, others wait their turn. */
class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

interface JobState {
  parts: Map<PartKey, 'pending' | 'running'>;
  listeners: Set<(dto: DigestPartsDto) => void>;
}

export interface ExplainPartFns {
  summary: typeof realExplainDigestSummary;
  areaText: typeof realExplainDigestAreaText;
  areaWalkthrough: typeof realExplainAreaWalkthrough;
}

export interface ExplainJobRunnerOptions {
  maxInFlight?: number;
  budget?: number;
  now?: () => Date;
  /** Overrides the real @digestit/explain part functions; for tests that need genuinely
   * independent per-area behaviour the interim production bridge can't demonstrate (see jobs.ts). */
  parts?: Partial<ExplainPartFns>;
}

export interface StartResult {
  noChanges: boolean;
  digestId: number | null;
}

const RETRYABLE: readonly PartStatus[] = ['error', 'truncated', 'budget'];

/** One `explain_job` row (kind `explain`/`retry`/`area`/`context`) plus, while it runs, an
 * in-memory record of which of its parts are still pending or running. Everything else about a
 * part's status is read back from the DB (see `getParts`), so this class holds no state that a
 * process restart needs to reconstruct. */
export class ExplainJobRunner {
  private jobs = new Map<number, JobState>(); // keyed by digest change_unit_id
  private areaInFlight = new Set<string>(); // `${digestId}:${areaId}`
  private areaListeners = new Map<number, Set<(e: AreaProgressEvent) => void>>(); // keyed by digestId

  constructor(private readonly db: DatabaseSync, private readonly home: string, private readonly opts: ExplainJobRunnerOptions = {}) {}

  private get maxInFlight(): number {
    return this.opts.maxInFlight ?? 4;
  }
  private get budget(): number {
    return this.opts.budget ?? DEFAULT_DAILY_BUDGET;
  }
  private get now(): () => Date {
    return this.opts.now ?? (() => new Date());
  }
  private get parts(): ExplainPartFns {
    return {
      summary: this.opts.parts?.summary ?? realExplainDigestSummary,
      areaText: this.opts.parts?.areaText ?? realExplainDigestAreaText,
      areaWalkthrough: this.opts.parts?.areaWalkthrough ?? realExplainAreaWalkthrough,
    };
  }

  private needsContext(repoId: number): boolean {
    return !this.db.prepare('SELECT 1 AS x FROM project_context WHERE repo_id = ? LIMIT 1').get(repoId);
  }

  private allPartKeys(areas: readonly DigestAreaSkeleton[], includeContext: boolean): PartKey[] {
    const keys: PartKey[] = ['summary', ...areas.map((a) => `area:${a.id}` as const)];
    if (includeContext) keys.push('context');
    return keys;
  }

  private loadAreas(changeUnitId: number): { repoId: number; areas: DigestAreaSkeleton[] } | null {
    const row = this.db.prepare('SELECT repo_id AS repoId, areas FROM digest WHERE change_unit_id = ?')
      .get(changeUnitId) as { repoId: number; areas: string | null } | undefined;
    if (!row || row.areas === null) return null;
    return { repoId: row.repoId, areas: JSON.parse(row.areas) as DigestAreaSkeleton[] };
  }

  /** The language a digest was first written in (never the project's current language, which may
   * have changed since -- one digest never mixes languages). */
  private digestLanguage(changeUnitId: number): ProjectRow['language'] {
    return (this.db.prepare('SELECT language FROM digest WHERE change_unit_id = ?').get(changeUnitId) as { language: ProjectRow['language'] }).language;
  }

  /** The compact, deterministic `ProjectMap` rendering (docs/explain-speed.md §4 "Context off the
   * critical path"): grounding for a first Explain's parts, built in parallel with (not blocking
   * on) the LLM project context. */
  private async compactMapText(project: ProjectRow): Promise<string | undefined> {
    try {
      const shadow = await openShadow(projectDataDir(this.home, project.id), project.path);
      const latest = latestCheckpoint(this.db, project.id);
      if (!latest) return undefined;
      return renderMap(await mapOfTree(shadow, latest.treeSha));
    } catch {
      return undefined; // best-effort grounding; the parts still run without it
    }
  }

  /**
   * `POST /api/projects/:id/explain`: takes the project lock, does the no-LLM prep (checkpoint,
   * digest row, areas), starts an `explain_job` and returns as soon as that prep is done -- the
   * LLM parts run after this resolves, not before. The lock stays held (via the backgrounded job)
   * until every part settles, so a second Explain still gets `ProjectLockedError`.
   */
  async start(project: ProjectRow, provider: ExplanationProvider, opts: { context?: string } = {}): Promise<StartResult> {
    const dataDir = projectDataDir(this.home, project.id);
    acquireProjectLock(dataDir, this.now().toISOString());
    const prepStart = performance.now();
    let prepared: Awaited<ReturnType<typeof prepareExplainDigest>>;
    try {
      prepared = await prepareExplainDigest(this.db, this.home, project, this.now);
    } catch (e) {
      releaseProjectLock(dataDir);
      throw e;
    }
    const prepMs = Math.round(performance.now() - prepStart);
    if (prepared.noChanges) {
      releaseProjectLock(dataDir);
      return { noChanges: true, digestId: null };
    }
    const changeUnitId = prepared.changeUnitId!;
    const includeContext = this.needsContext(project.id);
    const jobId = startJob(this.db, 'explain', { repoId: project.id, changeUnitId }, this.budget, this.now);
    if (jobId === null) {
      markPartsBudget(this.db, changeUnitId, this.allPartKeys(prepared.areas, includeContext), this.now);
      releaseProjectLock(dataDir);
      return { noChanges: false, digestId: changeUnitId };
    }
    setPrepMs(this.db, jobId, prepMs);
    // A brand-new digest is written in the project's language as of right now (matching
    // prepareExplainDigest, which already stored it that way on the digest row).
    void this.runJob(changeUnitId, jobId, project, provider, prepared.areas, {
      context: opts.context, includeContext, dataDir, onlyParts: null, language: project.language,
    });
    return { noChanges: false, digestId: changeUnitId };
  }

  /** `POST /api/digests/:id/explain`: re-runs only the parts currently `error`, `truncated` or
   * `budget` (not `context`, which has its own refresh endpoint). A no-op (no job, lock released
   * immediately) when nothing needs it. */
  async retry(project: ProjectRow, digestId: number, provider: ExplanationProvider): Promise<{ nothingToRetry: boolean }> {
    const dataDir = projectDataDir(this.home, project.id);
    acquireProjectLock(dataDir, this.now().toISOString());
    const loaded = this.loadAreas(digestId);
    if (!loaded) {
      releaseProjectLock(dataDir);
      throw new Error(`no digest ${digestId}`);
    }
    const current = this.getParts(digestId);
    const failed = new Set<PartKey>();
    if (current && RETRYABLE.includes(current.summary)) failed.add('summary');
    for (const [areaId, status] of Object.entries(current?.areas ?? {})) {
      if (RETRYABLE.includes(status)) failed.add(`area:${areaId}`);
    }
    if (failed.size === 0) {
      releaseProjectLock(dataDir);
      return { nothingToRetry: true };
    }
    const jobId = startJob(this.db, 'retry', { repoId: project.id, changeUnitId: digestId }, this.budget, this.now);
    if (jobId === null) {
      markPartsBudget(this.db, digestId, [...failed], this.now);
      releaseProjectLock(dataDir);
      return { nothingToRetry: false };
    }
    setPrepMs(this.db, jobId, 0);
    const context = latestContextText(this.db, project.id);
    // Keeps the language the digest was first written in, even if the project's changed since.
    void this.runJob(digestId, jobId, project, provider, loaded.areas, {
      context, includeContext: false, dataDir, onlyParts: failed, language: this.digestLanguage(digestId),
    });
    return { nothingToRetry: false };
  }

  private async runJob(
    changeUnitId: number, jobId: number, project: ProjectRow, provider: ExplanationProvider,
    areas: readonly DigestAreaSkeleton[],
    opts: { context?: string; includeContext: boolean; dataDir: string; onlyParts: Set<PartKey> | null; language: ProjectRow['language'] },
  ): Promise<void> {
    const allKeys = this.allPartKeys(areas, opts.includeContext);
    const runKeys = opts.onlyParts ? allKeys.filter((k) => opts.onlyParts!.has(k)) : allKeys;
    const state: JobState = { parts: new Map(runKeys.map((k) => [k, 'pending' as const])), listeners: new Set() };
    this.jobs.set(changeUnitId, state);
    this.emitParts(changeUnitId);

    let context = opts.context;
    if (opts.includeContext) context = (await this.compactMapText(project)) ?? context;

    const limiter = new Limiter(this.maxInFlight);
    const job: JobRef = { jobId, budget: this.budget, now: this.now };
    const { language } = opts;

    const settle = (key: PartKey, outcome: PartOutcome): void => {
      void outcome; // outcome is captured in the DB by the part function itself; only status matters here
      state.parts.delete(key);
      this.emitParts(changeUnitId);
    };
    const runPart = (key: PartKey, fn: () => Promise<PartOutcome>): Promise<void> => limiter.run(async () => {
      state.parts.set(key, 'running');
      this.emitParts(changeUnitId);
      let outcome: PartOutcome;
      try {
        outcome = await fn();
      } catch (e) {
        outcome = { outcome: 'error', calls: 0, detail: e instanceof Error ? e.message : String(e) };
      }
      settle(key, outcome);
    });

    const promises: Promise<void>[] = [];
    let summaryPromise: Promise<void> | undefined;
    if (runKeys.includes('summary')) {
      summaryPromise = runPart('summary', () => this.parts.summary(this.db, changeUnitId, provider, { job, context, language, areas }));
      promises.push(summaryPromise);
    }
    if (runKeys.includes('context')) {
      promises.push(runPart('context', async () => {
        try {
          await ensureContext(this.db, this.home, project, provider, { budget: this.budget, now: this.now });
          return { outcome: 'ok', calls: 1 };
        } catch (e) {
          return { outcome: 'error', calls: 0, detail: e instanceof Error ? e.message : String(e) };
        }
      }));
    }
    const areaKeys = runKeys.filter((k): k is `area:${string}` => k.startsWith('area:'));
    if (areaKeys.length > 0) {
      promises.push((async () => {
        // Interim bridge (jobs.ts): the area-text part is a free read of the summary call's
        // result, so it must wait for summary to settle when both are running in the same job.
        // Independently retried area parts (summaryPromise undefined) never wait.
        if (summaryPromise) await summaryPromise;
        await Promise.allSettled(
          areaKeys.map((key) => runPart(key, () => this.parts.areaText(this.db, changeUnitId, key.slice('area:'.length), provider, { job, context, language }))),
        );
      })());
    }

    await Promise.allSettled(promises);
    finishJob(this.db, jobId, this.now);
    releaseProjectLock(opts.dataDir);
    // Capture the listeners before dropping the live state, so the final notification -- the one
    // a subscriber (the SSE route) uses to decide `isDone` and send `done` -- is not silently
    // swallowed by `emitParts` finding no state to read listeners from.
    const { listeners } = state;
    this.jobs.delete(changeUnitId);
    const finalDto = this.getParts(changeUnitId);
    if (finalDto) listeners.forEach((cb) => cb(finalDto));
  }

  /** `POST /api/digests/:id/areas/:areaId/explain`: the L3 walkthrough is already a genuinely
   * independent per-area call (`explainArea`), so this just backgrounds it and streams progress;
   * no bridge involved. Throws `AreaExplainRunningError` (409) on a duplicate click. */
  async startArea(project: ProjectRow, digestId: number, areaId: string, provider: ExplanationProvider): Promise<{ started: boolean }> {
    const key = `${digestId}:${areaId}`;
    if (this.areaInFlight.has(key)) throw new AreaExplainRunningError();
    const jobId = startJob(this.db, 'area', { repoId: project.id, changeUnitId: digestId, areaId }, this.budget, this.now);
    if (jobId === null) return { started: false };
    this.areaInFlight.add(key);
    const context = latestContextText(this.db, project.id);
    const language = this.digestLanguage(digestId); // the digest's own language, not the project's current one
    void (async () => {
      const job: JobRef = { jobId, budget: this.budget, now: this.now };
      try {
        await this.parts.areaWalkthrough(this.db, digestId, areaId, provider, {
          job, context, language,
          onProgress: (e) => this.emitAreaProgress(digestId, e),
        });
      } finally {
        finishJob(this.db, jobId, this.now);
        this.areaInFlight.delete(key);
      }
    })();
    return { started: true };
  }

  isAreaRunning(digestId: number, areaId: string): boolean {
    return this.areaInFlight.has(`${digestId}:${areaId}`);
  }

  private isAnyAreaRunning(digestId: number): boolean {
    const prefix = `${digestId}:`;
    for (const k of this.areaInFlight) if (k.startsWith(prefix)) return true;
    return false;
  }

  /** True once every part of the digest's own job and every running area L3 under it has
   * settled: the point at which `GET /api/digests/:id/events` sends `done` and closes. */
  isDone(digestId: number): boolean {
    return !this.jobs.has(digestId) && !this.isAnyAreaRunning(digestId);
  }

  /** Derives `DigestPartsDto` from stored rows plus the in-memory running set; `null` when
   * `digestId` names no digest, or one created before DIG-75 (no stored `areas`). */
  getParts(changeUnitId: number): DigestPartsDto | null {
    const loaded = this.loadAreas(changeUnitId);
    if (!loaded) return null;
    const { repoId, areas } = loaded;
    const live = this.jobs.get(changeUnitId);
    const job = this.db.prepare(
      `SELECT id, started_at AS startedAt, finished_at AS finishedAt FROM explain_job
       WHERE change_unit_id = ? AND kind IN ('explain','retry') ORDER BY started_at DESC, id DESC LIMIT 1`,
    ).get(changeUnitId) as { id: number; startedAt: string; finishedAt: string | null } | undefined;
    const budgeted = new Set(
      (this.db.prepare("SELECT DISTINCT part FROM explain_call WHERE change_unit_id = ? AND outcome = 'budget' AND part IS NOT NULL")
        .all(changeUnitId) as unknown as { part: string }[]).map((r) => r.part),
    );
    const l0 = this.db.prepare(
      `SELECT status FROM explanation WHERE change_unit_id = ? AND level = 0 ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`,
    ).get(changeUnitId) as { status: PartStatus } | undefined;
    const l2 = this.db.prepare(
      `SELECT content, status FROM explanation WHERE change_unit_id = ? AND level = 2 ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`,
    ).get(changeUnitId) as { content: string; status: PartStatus } | undefined;
    const l2Ids = l2 ? new Set((JSON.parse(l2.content) as DigestL2Content).items.map((it) => it.id)) : null;

    const summary: PartStatus = live?.parts.get('summary') ?? (budgeted.has('summary') ? 'budget' : (l0?.status ?? 'error'));

    const areaStatuses: Record<string, PartStatus> = {};
    for (const a of areas) {
      const key: PartKey = `area:${a.id}`;
      const liveStatus = live?.parts.get(key);
      if (liveStatus) areaStatuses[a.id] = liveStatus;
      else if (budgeted.has(key)) areaStatuses[a.id] = 'budget';
      else if (!l2) areaStatuses[a.id] = 'error';
      else areaStatuses[a.id] = l2Ids!.has(a.id) ? l2.status : 'error';
    }

    const earliestExplainJob = this.db.prepare(
      `SELECT id FROM explain_job WHERE repo_id = ? AND kind = 'explain' ORDER BY started_at ASC, id ASC LIMIT 1`,
    ).get(repoId) as { id: number } | undefined;
    const includedContext = job !== undefined && earliestExplainJob?.id === job.id;
    let context: PartStatus = 'skipped';
    if (includedContext) {
      const liveStatus = live?.parts.get('context');
      if (liveStatus) context = liveStatus;
      else if (budgeted.has('context')) context = 'budget';
      else {
        const pc = this.db.prepare('SELECT status FROM project_context WHERE repo_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
          .get(repoId) as { status: PartStatus } | undefined;
        context = pc?.status ?? 'error';
      }
    }

    return { summary, areas: areaStatuses, context, startedAt: job?.startedAt ?? null, finishedAt: job?.finishedAt ?? null };
  }

  private emitParts(changeUnitId: number): void {
    const state = this.jobs.get(changeUnitId);
    const dto = this.getParts(changeUnitId);
    if (dto) state?.listeners.forEach((cb) => cb(dto));
  }

  /** Fires with the current `DigestPartsDto` on every status change of a live job; a no-op
   * subscription (never fires) when no job is currently running for this digest -- the caller
   * (the SSE route) reads `getParts` once for the initial snapshot regardless. */
  subscribeParts(changeUnitId: number, cb: (dto: DigestPartsDto) => void): () => void {
    const state = this.jobs.get(changeUnitId);
    if (!state) return () => {};
    state.listeners.add(cb);
    return () => state.listeners.delete(cb);
  }

  private emitAreaProgress(digestId: number, e: AreaProgressEvent): void {
    this.areaListeners.get(digestId)?.forEach((cb) => cb(e));
  }

  subscribeAreaProgress(digestId: number, cb: (e: AreaProgressEvent) => void): () => void {
    const set = this.areaListeners.get(digestId) ?? new Set();
    set.add(cb);
    this.areaListeners.set(digestId, set);
    return () => set.delete(cb);
  }
}

export type { ExplainJobKind };
