// Fast Explain (DIG-75, docs/explain-speed.md §4-5): the async Explain job runner. `POST
// /api/projects/:id/explain` used to hold its HTTP response open for the whole LLM call; this runner
// does the no-LLM prep synchronously (snapshot, checkpoint, digest row, deterministic areas), then
// runs the LLM parts (`summary`, one `area:<id>` per area, `context`) in the background while the
// caller returns. Part status is derived from stored rows plus this runner's in-memory running set
// (see `getParts`), so a server restart never leaves a part `running` forever: with no live entry
// and nothing stored, it reads `error`.
import type { DatabaseSync } from 'node:sqlite';
import type {
  AreaMemory, AreaProgressEvent, AreaWalkthrough, DigestAreaSkeleton, DigestL2Content, DigestPartsDto, ExplainLanguage,
  MemoryItem, MemorySlice, PartStatus, TermMemory,
} from '@digestit/core';
import { MEMORY_LIMITS } from '@digestit/core';
import {
  type ExplainJobKind, type ExplanationProvider, type JobRef, type MemoryPromptKind, type PartOutcome, type ProviderFile,
  explainArea, explainDigestAreaText, explainDigestSummary, finishJob, identifiersInDiff, loadChange, markPartsBudget,
  renderMap, selectMemory, setPrepMs, startJob,
} from '@digestit/explain';
import { projectDataDir } from './datahome.js';
import { listMemoryItems, recordMemoryUse } from './memory.js';
import { DEFAULT_DAILY_BUDGET } from './scheduler.js';
import { ensureContext, latestContextText, mapOfTree } from './project-context.js';
import {
  acquireProjectLock, latestCheckpoint, listProjects, prepareExplainDigest, releaseProjectLock, type ProjectRow,
} from './project.js';
import { openShadow } from './shadow.js';

export class AreaExplainRunningError extends Error {
  constructor() {
    super('an L3 explain is already running for this area');
    this.name = 'AreaExplainRunningError';
  }
}

export type PartKey = 'summary' | 'context' | `area:${string}`;

/** `RawChange['files']` (`RawFile[]`) has the same shape as `ProviderFile[]` except `filteredReason`
 * is optional there and required (nullable) here -- `identifiersInDiff` only reads `.patch`, so this
 * is just closing that gap, not a real conversion. */
function toProviderFiles(files: { filteredReason?: string | null }[] | undefined): ProviderFile[] {
  return (files ?? []).map((f) => ({ ...f, filteredReason: f.filteredReason ?? null }) as ProviderFile);
}

/** At most `max` callbacks run at once; the others wait in the order they were queued. */
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

/** One settled part of a job, for `digest explain`'s per-part timing lines. */
export interface PartReport {
  part: PartKey;
  status: PartStatus;
  calls: number;
  ms: number;
  detail?: string;
}

export interface JobReport {
  jobId: number | null;
  prepMs: number;
  parts: PartReport[];
}

interface JobState {
  parts: Map<PartKey, 'pending' | 'running'>;
  listeners: Set<(dto: DigestPartsDto) => void>;
}

export interface ExplainJobRunnerOptions {
  /** Parts in flight at once per job (docs/explain-speed.md §4); default 4. */
  maxInFlight?: number;
  budget?: number;
  now?: () => Date;
  /** True while something outside the runner (the context refresh endpoint) is building this
   * project's context; the job then skips its own `context` part instead of racing it. */
  contextBusy?: (repoId: number) => boolean;
  /** `registerLive`'s hub (DIG-84): called whenever a part settles and once the project lock is
   * released, so `/api/stream`'s `changed` event fires for work done in-process (it otherwise only
   * detects a `data_version` bump from another connection, and this runner shares its `db` handle
   * with the SSE route). Omitted in tests/CLI runs with no live stream to notify. */
  notify?: () => void;
  /** MemoryWorker's "after an Explain job finishes" trigger (docs/milestone-4-memory.md §2, DIG-103):
   * called once a job's LLM parts have all settled and its DB writes (areas, thread attach) are
   * durable -- the project lock is already released, so the worker's own memory batch never races
   * this job. Fires for every settled job (`explain`/`retry`/an area `startArea`), not per part. */
  onJobSettled?: (repoId: number) => void;
}

export interface StartResult {
  noChanges: boolean;
  digestId: number | null;
  /** Resolves once every part has settled (immediately for no changes or an exhausted budget). */
  settled: Promise<JobReport>;
}

const RETRYABLE: readonly PartStatus[] = ['error', 'truncated', 'budget'];
/** Final statuses of settled parts kept per digest (see `getParts`); oldest digests dropped first. */
const MAX_REMEMBERED_DIGESTS = 500;

const toStatus = (o: PartOutcome): PartStatus => (o.outcome === 'cached' ? 'ok' : o.outcome);

/**
 * One `explain_job` row per user action (Explain, retry, area L3) plus, while it runs, an
 * in-memory record of which parts are pending or running. Everything else about a part's status
 * is read back from the DB, so a restart loses nothing but the "running" flags.
 */
export class ExplainJobRunner {
  private jobs = new Map<number, JobState>(); // keyed by digest change_unit_id
  private areaInFlight = new Set<string>(); // `${digestId}:${areaId}`
  private areaListeners = new Map<number, Set<(e: AreaProgressEvent) => void>>(); // keyed by digestId
  private contextRunning = new Set<number>(); // repo ids
  /** Last settled status of each part run in this process. Only needed for areas: their text is
   * merged into one level-2 row whose single status is that of the last area stored, so it can't
   * tell one area's `truncated` from another's `ok`. After a restart that row's status is used. */
  private settledParts = new Map<number, Map<PartKey, PartStatus>>();

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

  isContextRunning(repoId: number): boolean {
    return this.contextRunning.has(repoId);
  }

  private hasContext(repoId: number): boolean {
    return !!this.db.prepare('SELECT 1 AS x FROM project_context WHERE repo_id = ? LIMIT 1').get(repoId);
  }

  private loadDigest(changeUnitId: number): { repoId: number; areas: DigestAreaSkeleton[]; language: ProjectRow['language'] } | null {
    const row = this.db.prepare('SELECT repo_id AS repoId, areas, language FROM digest WHERE change_unit_id = ?')
      .get(changeUnitId) as { repoId: number; areas: string | null; language: ProjectRow['language'] } | undefined;
    if (!row || row.areas === null) return null;
    return { repoId: row.repoId, areas: JSON.parse(row.areas) as DigestAreaSkeleton[], language: row.language };
  }

  /** One repo-wide read of active memory (docs/milestone-4-memory.md §3), shared by every part of
   * one job/area call so a job's several `selectMemory` calls see the same snapshot. `knownTerms`
   * is every term item's name plus every area item's export names -- what `identifiersInDiff` may
   * match in the diff. */
  private loadMemoryContext(repoId: number): { items: MemoryItem[]; knownTerms: string[] } {
    const items = listMemoryItems(this.db, repoId);
    const knownTerms = [
      ...items.filter((it) => it.kind === 'term').map((it) => (it.content as TermMemory).term),
      ...items.filter((it) => it.kind === 'area').flatMap((it) => (it.content as AreaMemory).exports.map((e) => e.name)),
    ];
    return { items, knownTerms };
  }

  /** `selectMemory` for one prompt part (docs/milestone-4-memory.md §3): `files` is the digest's
   * whole (unfiltered) diff even for a per-area prompt, since a second, area-scoped `loadChange`
   * read would cost a query for a marginal precision gain on which identifiers are "in the diff". */
  private memorySliceFor(
    ctx: { items: MemoryItem[]; knownTerms: string[] }, kind: MemoryPromptKind, touchedAreas: string[],
    files: readonly ProviderFile[], language: ExplainLanguage,
  ): MemorySlice {
    const identifiers = identifiersInDiff(files, ctx.knownTerms);
    return selectMemory(ctx.items, { touchedAreas, identifiers, kind, language }, MEMORY_LIMITS.sliceTokens[kind]);
  }

  /** Logs `slice.items`/`droppedForBudget` against the part that used them (docs/milestone-4-memory.md
   * §3, "the slice's item versions go to `memory_use`") -- only when the part actually made a call
   * (`calls > 0`); a cached or budget-refused part never sent the slice to a prompt. */
  private logMemoryUse(jobId: number, part: string, changeUnitId: number | null, slice: MemorySlice, calls: number): void {
    if (calls === 0) return;
    recordMemoryUse(this.db, { jobId, part, changeUnitId, items: slice.items, droppedForBudget: slice.droppedForBudget });
  }

  /** The compact, deterministic `ProjectMap` rendering (docs/explain-speed.md §4 "Context off the
   * critical path"): grounding for a first Explain's parts while the LLM context builds alongside. */
  private async compactMapText(project: ProjectRow): Promise<string | undefined> {
    try {
      const latest = latestCheckpoint(this.db, project.id);
      if (!latest) return undefined;
      const shadow = await openShadow(projectDataDir(this.home, project.id), project.path);
      return renderMap(await mapOfTree(shadow, latest.treeSha));
    } catch {
      return undefined; // best-effort grounding; the parts still run without it
    }
  }

  /**
   * `POST /api/projects/:id/explain` and `digest explain`: takes the project lock, does the no-LLM
   * prep, starts an `explain_job` and returns once that prep is done; the LLM parts run after this
   * resolves. The lock stays held until every part settles, so a second Explain still gets
   * `ProjectLockedError`. The budget is checked once, here: when it is spent, every part is marked
   * `budget` and no call is made, but the digest (files, areas) still exists.
   */
  async start(project: ProjectRow, provider: ExplanationProvider): Promise<StartResult> {
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
      return { noChanges: true, digestId: null, settled: Promise.resolve({ jobId: null, prepMs, parts: [] }) };
    }
    const changeUnitId = prepared.changeUnitId!;
    const firstExplain = !this.hasContext(project.id);
    const keys: PartKey[] = ['summary', ...prepared.areas.map((a) => `area:${a.id}` as const)];
    if (firstExplain) keys.push('context');
    const jobId = startJob(this.db, 'explain', { repoId: project.id, changeUnitId }, this.budget, this.now);
    if (jobId === null) {
      markPartsBudget(this.db, changeUnitId, keys, this.now);
      releaseProjectLock(dataDir);
      return { noChanges: false, digestId: changeUnitId, settled: Promise.resolve(this.budgetReport(keys, prepMs)) };
    }
    setPrepMs(this.db, jobId, prepMs);
    const settled = this.runJob(changeUnitId, jobId, prepMs, project, provider, keys, {
      dataDir, firstExplain, refreshContext: !firstExplain, language: project.language, force: false,
    });
    return { noChanges: false, digestId: changeUnitId, settled };
  }

  private budgetReport(keys: readonly PartKey[], prepMs: number): JobReport {
    return { jobId: null, prepMs, parts: keys.map((part) => ({ part, status: 'budget', calls: 0, ms: 0 })) };
  }

  /** `POST /api/digests/:id/explain`: re-runs only the parts currently `error`, `truncated` or
   * `budget`, in the language the digest was first written in. `settled` is `null` when there was
   * nothing to re-run (no job, lock released at once). */
  async retry(project: ProjectRow, digestId: number, provider: ExplanationProvider): Promise<{ settled: Promise<JobReport> | null }> {
    const dataDir = projectDataDir(this.home, project.id);
    acquireProjectLock(dataDir, this.now().toISOString());
    const loaded = this.loadDigest(digestId);
    if (!loaded) {
      releaseProjectLock(dataDir);
      throw new Error(`no digest ${digestId}`);
    }
    const current = this.getParts(digestId)!;
    const failed: PartKey[] = [];
    if (RETRYABLE.includes(current.summary)) failed.push('summary');
    for (const a of loaded.areas) if (RETRYABLE.includes(current.areas[a.id] ?? 'error')) failed.push(`area:${a.id}`);
    if (RETRYABLE.includes(current.context)) failed.push('context');
    if (failed.length === 0) {
      releaseProjectLock(dataDir);
      return { settled: null };
    }
    const jobId = startJob(this.db, 'retry', { repoId: project.id, changeUnitId: digestId }, this.budget, this.now);
    if (jobId === null) {
      markPartsBudget(this.db, digestId, failed, this.now);
      releaseProjectLock(dataDir);
      return { settled: Promise.resolve(this.budgetReport(failed, 0)) };
    }
    setPrepMs(this.db, jobId, 0);
    const settled = this.runJob(digestId, jobId, 0, project, provider, failed, {
      dataDir, firstExplain: !this.hasContext(project.id), refreshContext: false, language: loaded.language, force: true,
    });
    return { settled };
  }

  /**
   * Runs `keys` under one job: `summary` is queued first so it never waits behind area calls, area
   * parts do not wait for it, and `context` runs alongside (on a first Explain the parts are
   * grounded on the compact project map instead of waiting for it). Never rejects.
   */
  private async runJob(
    changeUnitId: number, jobId: number, prepMs: number, project: ProjectRow, provider: ExplanationProvider,
    keys: readonly PartKey[],
    opts: { dataDir: string; firstExplain: boolean; refreshContext: boolean; language: ProjectRow['language']; force: boolean },
  ): Promise<JobReport> {
    const state: JobState = { parts: new Map(keys.map((k) => [k, 'pending' as const])), listeners: new Set() };
    this.jobs.set(changeUnitId, state);
    const reports: PartReport[] = [];
    try {
      const context = opts.firstExplain ? await this.compactMapText(project) : latestContextText(this.db, project.id);
      const limiter = new Limiter(this.maxInFlight);
      const job: JobRef = { jobId, budget: this.budget, now: this.now };
      const { language } = opts;
      const memoryCtx = this.loadMemoryContext(project.id);
      const diffFiles = toProviderFiles(loadChange(this.db, changeUnitId)?.files);
      const areaIds = keys.filter((k) => k.startsWith('area:')).map((k) => k.slice('area:'.length));

      const runPart = (key: PartKey, fn: () => Promise<PartOutcome | null>): Promise<void> => limiter.run(async () => {
        state.parts.set(key, 'running');
        this.emitParts(changeUnitId);
        const t0 = performance.now();
        let status: PartStatus;
        let calls = 0;
        let detail: string | undefined;
        try {
          const outcome = await fn();
          status = outcome ? toStatus(outcome) : 'skipped';
          calls = outcome?.calls ?? 0;
          detail = outcome?.detail;
        } catch (e) {
          status = 'error';
          detail = e instanceof Error ? e.message : String(e);
        }
        reports.push({ part: key, status, calls, ms: Math.round(performance.now() - t0), detail });
        this.rememberSettled(changeUnitId, key, status);
        state.parts.delete(key);
        this.emitParts(changeUnitId);
        this.opts.notify?.();
      });

      const runs: Promise<void>[] = [];
      for (const key of keys) {
        if (key === 'summary') {
          const slice = this.memorySliceFor(memoryCtx, 'summary', areaIds, diffFiles, language);
          runs.push(runPart(key, async () => {
            const outcome = await explainDigestSummary(this.db, changeUnitId, provider, { job, context, language, force: opts.force, memory: slice });
            this.logMemoryUse(jobId, 'summary', changeUnitId, slice, outcome.calls);
            return outcome;
          }));
        } else if (key === 'context') {
          runs.push(runPart(key, () => this.runContext(project, provider, job)));
        } else {
          const areaId = key.slice('area:'.length);
          const slice = this.memorySliceFor(memoryCtx, 'area', [areaId], diffFiles, language);
          runs.push(runPart(key, async () => {
            const outcome = await explainDigestAreaText(this.db, changeUnitId, areaId, provider, { job, context, language, memory: slice });
            this.logMemoryUse(jobId, `area:${areaId}`, changeUnitId, slice, outcome.calls);
            return outcome;
          }));
        }
      }
      // A later Explain refreshes the context in the background when `ensureContext`'s rules say so;
      // it is not a live part (it rarely builds), but a build it does make shows up as `context`.
      if (opts.refreshContext) runs.push(limiter.run(() => this.runContext(project, provider, job)).then(() => {}, () => {}));
      this.emitParts(changeUnitId);
      await Promise.allSettled(runs);
    } catch {
      // Only the grounding lookup can throw here (parts catch their own errors); the parts that did
      // not run read `error` and can be retried.
    } finally {
      // Nothing awaits this promise on the server, so cleanup must not throw (e.g. a DB closed at shutdown).
      try {
        finishJob(this.db, jobId, this.now);
      } catch { /* left unfinished: its parts read as stored, or `error` */ }
      releaseProjectLock(opts.dataDir);
      this.opts.notify?.();
      this.opts.onJobSettled?.(project.id);
      // Take the listeners before dropping the live state, so the final notification (the one the
      // SSE route turns into `done`) still reaches them.
      const { listeners } = state;
      this.jobs.delete(changeUnitId);
      try {
        const finalDto = this.getParts(changeUnitId);
        if (finalDto) listeners.forEach((cb) => cb(finalDto));
      } catch { /* same as above */ }
    }
    return { jobId, prepMs, parts: reports };
  }

  /** The `context` part: builds the project context when missing, or refreshes it when
   * `ensureContext`'s rules say so; `null` (the part reads `skipped`) when nothing was built. */
  private async runContext(project: ProjectRow, provider: ExplanationProvider, job: JobRef): Promise<PartOutcome | null> {
    if (this.contextRunning.has(project.id) || this.opts.contextBusy?.(project.id)) return null;
    this.contextRunning.add(project.id);
    try {
      const r = await ensureContext(this.db, this.home, project, provider, { job, now: this.now });
      if (!r) return null;
      return { outcome: r.outcome === 'budget' ? 'error' : r.outcome, calls: r.calls, detail: r.detail };
    } finally {
      this.contextRunning.delete(project.id);
    }
  }

  private rememberSettled(changeUnitId: number, key: PartKey, status: PartStatus): void {
    let m = this.settledParts.get(changeUnitId);
    if (!m) {
      if (this.settledParts.size >= MAX_REMEMBERED_DIGESTS) this.settledParts.delete(this.settledParts.keys().next().value!);
      m = new Map();
      this.settledParts.set(changeUnitId, m);
    }
    m.set(key, status);
  }

  /** `POST /api/digests/:id/areas/:areaId/explain`: backgrounds the area's L3 walkthrough as its
   * own job and streams it as `area-progress` events; the last event (`done: true`) carries the
   * final, validated walkthrough. Throws `AreaExplainRunningError` on a duplicate click.
   * `settled` is `null` when the budget refused the job. */
  async startArea(project: ProjectRow, digestId: number, areaId: string, provider: ExplanationProvider): Promise<{ settled: Promise<PartOutcome> | null }> {
    const key = `${digestId}:${areaId}`;
    if (this.areaInFlight.has(key)) throw new AreaExplainRunningError();
    const jobId = startJob(this.db, 'area', { repoId: project.id, changeUnitId: digestId, areaId }, this.budget, this.now);
    if (jobId === null) return { settled: null };
    this.areaInFlight.add(key);
    const context = latestContextText(this.db, project.id);
    const language = this.loadDigest(digestId)?.language ?? project.language; // the digest's own language
    const job: JobRef = { jobId, budget: this.budget, now: this.now };
    const memoryCtx = this.loadMemoryContext(project.id);
    const diffFiles = toProviderFiles(loadChange(this.db, digestId)?.files);
    const slice = this.memorySliceFor(memoryCtx, 'walkthrough', [areaId], diffFiles, language);
    const settled = (async (): Promise<PartOutcome> => {
      let outcome: PartOutcome;
      try {
        const r = await explainArea(this.db, digestId, areaId, provider, {
          job, context, language, memory: slice,
          // The provider's own `done` comes before validation; only the stored result below is final.
          onProgress: (e) => this.emitAreaProgress(digestId, { ...e, done: false }),
        });
        outcome = { outcome: r.outcome === 'budget' ? 'error' : r.outcome, calls: r.calls, detail: r.detail };
        this.logMemoryUse(jobId, `walkthrough:${areaId}`, digestId, slice, outcome.calls);
      } catch (e) {
        outcome = { outcome: 'error', calls: 0, detail: e instanceof Error ? e.message : String(e) };
      }
      try {
        finishJob(this.db, jobId, this.now);
      } catch { /* see runJob: cleanup never throws */ }
      this.areaInFlight.delete(key);
      let final: AreaWalkthrough | null = null;
      try {
        final = this.storedWalkthrough(digestId, areaId);
      } catch { /* see runJob */ }
      this.emitAreaProgress(digestId, { areaId, overview: final?.overview || null, steps: final?.steps ?? [], done: true });
      this.opts.notify?.();
      return outcome;
    })();
    return { settled };
  }

  private storedWalkthrough(digestId: number, areaId: string): AreaWalkthrough | null {
    const row = this.db.prepare(
      `SELECT content FROM area_explanation WHERE change_unit_id = ? AND area_id = ?
       ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`,
    ).get(digestId, areaId) as { content: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.content) as AreaWalkthrough;
    } catch {
      return null;
    }
  }

  isAreaRunning(digestId: number, areaId: string): boolean {
    return this.areaInFlight.has(`${digestId}:${areaId}`);
  }

  private isAnyAreaRunning(digestId: number): boolean {
    const prefix = `${digestId}:`;
    for (const k of this.areaInFlight) if (k.startsWith(prefix)) return true;
    return false;
  }

  /** True once every part of the digest's job and every area L3 under it has settled: the point at
   * which `GET /api/digests/:id/events` sends `done` and closes. */
  isDone(digestId: number): boolean {
    return !this.jobs.has(digestId) && !this.isAnyAreaRunning(digestId);
  }

  /** True while any Explain job (digest, retry or area L3) is running anywhere in this process:
   * `MemoryWorker`'s idle trigger (docs/milestone-4-memory.md §2) waits for this to clear. */
  hasRunningJobs(): boolean {
    return this.jobs.size > 0 || this.areaInFlight.size > 0;
  }

  /** Derives `DigestPartsDto` from stored rows plus the in-memory running set; `null` when
   * `digestId` names no digest, or one created before DIG-75 (no stored `areas`). */
  getParts(changeUnitId: number): DigestPartsDto | null {
    const loaded = this.loadDigest(changeUnitId);
    if (!loaded) return null;
    const { repoId, areas } = loaded;
    const live = this.jobs.get(changeUnitId)?.parts;
    const settled = this.settledParts.get(changeUnitId);
    const latestJob = this.db.prepare(
      `SELECT id, started_at AS startedAt, finished_at AS finishedAt FROM explain_job
       WHERE change_unit_id = ? AND kind IN ('explain','retry') ORDER BY started_at DESC, id DESC LIMIT 1`,
    ).get(changeUnitId) as { id: number; startedAt: string; finishedAt: string | null } | undefined;
    const budgeted = new Set(
      (this.db.prepare("SELECT DISTINCT part FROM explain_call WHERE change_unit_id = ? AND outcome = 'budget' AND part IS NOT NULL")
        .all(changeUnitId) as unknown as { part: string }[]).map((r) => r.part),
    );
    const latestLevel = (level: number) => this.db.prepare(
      `SELECT content, status FROM explanation WHERE change_unit_id = ? AND level = ?
       ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`,
    ).get(changeUnitId, level) as { content: string; status: PartStatus } | undefined;
    // Stored text wins over an older `budget` marker (a later retry that went through); a part with
    // neither and no live entry never finished: `error`, so the UI offers a retry.
    const fallback = (key: PartKey): PartStatus => (budgeted.has(key) ? 'budget' : 'error');

    const l0 = latestLevel(0);
    const summary: PartStatus = live?.get('summary') ?? l0?.status ?? fallback('summary');

    const l2 = latestLevel(2);
    let l2Ids = new Set<string>();
    try {
      if (l2) l2Ids = new Set((JSON.parse(l2.content) as DigestL2Content).items.map((it) => it.id));
    } catch { /* unreadable row: treated as not stored */ }
    const areaStatuses: Record<string, PartStatus> = {};
    for (const a of areas) {
      const key: PartKey = `area:${a.id}`;
      const stored = l2Ids.has(a.id) ? (settled?.get(key) ?? l2!.status) : undefined;
      areaStatuses[a.id] = live?.get(key) ?? stored ?? fallback(key);
    }

    return {
      summary, areas: areaStatuses, context: this.contextStatus(changeUnitId, repoId, live, settled, budgeted),
      startedAt: latestJob?.startedAt ?? null, finishedAt: latestJob?.finishedAt ?? null,
    };
  }

  /** `context` is part of a digest when its job built the project context (a first Explain always
   * does; a later one only when `ensureContext` decided to refresh) or when it was refused by the
   * budget; otherwise `skipped`. */
  private contextStatus(
    changeUnitId: number, repoId: number, live: Map<PartKey, 'pending' | 'running'> | undefined,
    settled: Map<PartKey, PartStatus> | undefined, budgeted: Set<string>,
  ): PartStatus {
    const liveStatus = live?.get('context');
    if (liveStatus) return liveStatus;
    const explainJob = this.db.prepare(
      `SELECT id, started_at AS startedAt FROM explain_job WHERE change_unit_id = ? AND kind = 'explain' ORDER BY started_at, id LIMIT 1`,
    ).get(changeUnitId) as { id: number; startedAt: string } | undefined;
    const called = this.db.prepare(
      `SELECT 1 AS x FROM explain_call c JOIN explain_job j ON j.id = c.job_id
       WHERE j.change_unit_id = ? AND c.part = 'context' AND c.outcome IN ('ok','error') LIMIT 1`,
    ).get(changeUnitId) !== undefined;
    const firstJob = this.db.prepare(
      `SELECT id FROM explain_job WHERE repo_id = ? AND kind = 'explain' ORDER BY started_at, id LIMIT 1`,
    ).get(repoId) as { id: number } | undefined;
    const first = explainJob !== undefined && firstJob?.id === explainJob.id;
    if (called || first) {
      const pc = this.db.prepare(
        'SELECT status FROM project_context WHERE repo_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1',
      ).get(repoId, explainJob?.startedAt ?? '') as { status: PartStatus } | undefined;
      if (pc) return pc.status;
    }
    const remembered = settled?.get('context');
    if (remembered) return remembered;
    if (budgeted.has('context')) return 'budget';
    return first ? 'error' : 'skipped';
  }

  private emitParts(changeUnitId: number): void {
    const state = this.jobs.get(changeUnitId);
    if (!state || state.listeners.size === 0) return;
    const dto = this.getParts(changeUnitId);
    if (dto) state.listeners.forEach((cb) => cb(dto));
  }

  /** Fires with the current `DigestPartsDto` on every part status change of a live job; never
   * fires when no job is running for this digest (the SSE route sends its own initial snapshot). */
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
    return () => {
      set.delete(cb);
      if (set.size === 0 && this.areaListeners.get(digestId) === set) this.areaListeners.delete(digestId);
    };
  }
}

export type { ExplainJobKind };

export interface ExplainProjectResult {
  noChanges: boolean;
  digestId: number | null;
  /** `budget` when the job was refused; else the worst part status (`error` > `truncated` > `ok`). */
  outcome: 'ok' | 'truncated' | 'error' | 'budget' | null;
  calls: number;
  detail?: string;
  report: JobReport | null;
}

export interface ExplainNowOptions {
  budget?: number;
  now?: () => Date;
  maxInFlight?: number;
}

function summarize(digestId: number, report: JobReport): ExplainProjectResult {
  const statuses = report.parts.map((p) => p.status);
  const outcome = report.jobId === null ? 'budget'
    : statuses.includes('error') ? 'error'
      : statuses.includes('truncated') ? 'truncated' : 'ok';
  const failed = report.parts.find((p) => p.status === 'error' && p.detail);
  return {
    noChanges: false, digestId, outcome, calls: report.parts.reduce((n, p) => n + p.calls, 0),
    detail: failed ? `${failed.part}: ${failed.detail}` : undefined, report,
  };
}

/** `digest explain`: the same job the server runs, awaited to the end (the CLI prints per-part timing). */
export async function explainProject(
  db: DatabaseSync, home: string, project: ProjectRow, provider: ExplanationProvider, opts: ExplainNowOptions = {},
): Promise<ExplainProjectResult> {
  const r = await new ExplainJobRunner(db, home, opts).start(project, provider);
  const report = await r.settled;
  if (r.noChanges) return { noChanges: true, digestId: null, outcome: null, calls: 0, report: null };
  return summarize(r.digestId!, report);
}

/** `digest explain --retry <digestId>`: re-runs the digest's `error`/`truncated`/`budget` parts, awaited. */
export async function retryDigest(
  db: DatabaseSync, home: string, digestId: number, provider: ExplanationProvider, opts: ExplainNowOptions = {},
): Promise<ExplainProjectResult> {
  const repo = db.prepare('SELECT repo_id AS repoId FROM digest WHERE change_unit_id = ?').get(digestId) as { repoId: number } | undefined;
  const row = repo ? listProjects(db).find((p) => p.id === repo.repoId) : undefined;
  if (!row) throw new Error(`no digest ${digestId}`);
  const { settled } = await new ExplainJobRunner(db, home, opts).retry(row, digestId, provider);
  if (!settled) return { noChanges: false, digestId, outcome: 'ok', calls: 0, report: { jobId: null, prepMs: 0, parts: [] } };
  return summarize(digestId, await settled);
}
