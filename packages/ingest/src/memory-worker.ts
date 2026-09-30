// MemoryWorker (docs/milestone-4-memory.md §2, DIG-103): one queue, one task at a time, in the
// `digest serve` process. Explain never awaits this worker -- `ExplainJobRunner.onJobSettled`
// enqueues the deterministic after-explain re-extraction and returns at once; the idle/daily/manual
// triggers run on the worker's own timer. The worker yields between queued items whenever an
// Explain job is running (checked before every item, not just at tick start), so a slow summary
// batch never delays the next Explain by more than the item already in flight.
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryTrigger } from '@digestit/core';
import { canStartMemoryJob, finishJob, startJob, type ExplanationProvider } from '@digestit/explain';
import { dropStaleItems, memorySummariesEnabled } from './memory.js';
import { updateProjectMemory } from './memory-update.js';
import { pickSummaryWork, runAreaSummaryBatch, runThreadSummaryBatch } from './memory-summarize.js';
import { listProjects, type ProjectRow } from './project.js';
import { DEFAULT_DAILY_BUDGET } from './scheduler.js';

export const DEFAULT_MEMORY_DAILY_JOBS = 4;
export const DEFAULT_MEMORY_RESERVE = 10;
/** No Explain job and no API write for this long (docs/milestone-4-memory.md §2). */
export const DEFAULT_MEMORY_IDLE_MS = 2 * 60 * 1000;
const TICK_MS = 5_000;
const STALE_DROP_DAYS = 30;

export interface MemoryWorkerOptions {
  home: string;
  providerFactory: (allow: string[]) => ExplanationProvider | null;
  now?: () => Date;
  budgetLimit?: number;
  /** `DIGESTIT_MEMORY_DAILY_JOBS`; 0 turns background summaries off entirely. */
  dailyJobShare?: number;
  /** `DIGESTIT_MEMORY_RESERVE`. */
  reserve?: number;
  /** True while any Explain job (digest, retry or area) is running, anywhere: the summary queue and
   * the daily sweep both wait for this to clear before touching the shared LLM budget or the shadow
   * store's checkpoint read a running Explain also reads from. */
  isExplaining?: () => boolean;
  idleMs?: number;
  tickMs?: number;
}

type Task = () => Promise<void>;

/** `docs/milestone-4-memory.md §2`'s four triggers, wired into one FIFO queue processed one item at
 * a time. `after-explain` tasks are deterministic (no LLM) and always run as soon as they are
 * queued, regardless of idle state -- only the summary queue (idle trigger) and the LLM half of the
 * daily sweep wait for idleness, since only they spend the shared LLM budget. */
export class MemoryWorker {
  private queue: Task[] = [];
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt: number;
  private lastDailySweepDate = new Map<number, string>();

  constructor(private readonly db: DatabaseSync, private readonly opts: MemoryWorkerOptions) {
    this.lastActivityAt = this.now().getTime();
  }

  private get now(): () => Date {
    return this.opts.now ?? (() => new Date());
  }
  private get budgetLimit(): number {
    return this.opts.budgetLimit ?? DEFAULT_DAILY_BUDGET;
  }
  private get dailyJobShare(): number {
    return this.opts.dailyJobShare ?? DEFAULT_MEMORY_DAILY_JOBS;
  }
  private get reserve(): number {
    return this.opts.reserve ?? DEFAULT_MEMORY_RESERVE;
  }
  private get idleMs(): number {
    return this.opts.idleMs ?? DEFAULT_MEMORY_IDLE_MS;
  }
  private isExplaining(): boolean {
    return this.opts.isExplaining?.() ?? false;
  }

  /** Any API write (docs/milestone-4-memory.md §2's idle definition, "no API write for 2 min");
   * call from the same write gate that already exists in `apps/server`'s onRequest hook. */
  noteActivity(): void {
    this.lastActivityAt = this.now().getTime();
  }

  private idle(): boolean {
    return !this.isExplaining() && this.now().getTime() - this.lastActivityAt >= this.idleMs;
  }

  private localDateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private enqueue(task: Task): void {
    this.queue.push(task);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        try {
          await task();
        } catch {
          // One item's failure (a provider error, a missing project) never stops the queue; the
          // next tick re-derives what is still due from the store, so nothing is silently dropped.
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Trigger 1 (docs/milestone-4-memory.md §2): after an Explain job's last part is stored, wired
   * from `ExplainJobRunnerOptions.onJobSettled`. Explain never awaits this. */
  afterExplain(repoId: number): void {
    this.enqueue(async () => {
      const project = listProjects(this.db).find((p) => p.id === repoId);
      if (!project) return;
      await updateProjectMemory(this.db, this.opts.home, project, 'after-explain', this.now);
    });
  }

  /** Trigger 4: `POST /api/projects/:id/memory/update` and `digest memory update` (DIG-100's CLI
   * already runs this synchronously; this is the same call queued through the worker so a manual
   * update from the page never races a live Explain's own store writes). */
  manualUpdate(repoId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        const project = listProjects(this.db).find((p) => p.id === repoId);
        if (!project) return resolve();
        try {
          await updateProjectMemory(this.db, this.opts.home, project, 'manual', this.now);
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
  }

  /** Starts the idle/daily timer; safe to call once per server process. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Awaits until the queue is empty; for tests and the CLI, which need to know a triggered update
   * actually landed rather than just got queued. */
  async flush(): Promise<void> {
    while (this.running || this.queue.length > 0) await new Promise((r) => setTimeout(r, 1));
  }

  /** One tick's worth of trigger selection (docs/milestone-4-memory.md §2): public so a test or the
   * CLI can drive it without a real timer. `start()` calls this on `tickMs`. */
  tick(): void {
    // One item at a time, including queueing: a summary call can outlast many ticks, and items
    // queued behind it would each start a job before the first one's calls count toward the share.
    if (this.running || this.queue.length > 0) return;
    if (!this.idle()) return;
    const today = this.localDateKey(this.now());
    const projects = listProjects(this.db);

    // Trigger 3 (daily): the first idle moment after local midnight, one project per tick.
    const dueForSweep = projects.find((p) => this.lastDailySweepDate.get(p.id) !== today);
    if (dueForSweep) {
      this.lastDailySweepDate.set(dueForSweep.id, today);
      this.enqueue(() => this.runDailySweep(dueForSweep));
      return;
    }

    // Trigger 2 (idle): drain the summary queue, one unit of work per tick, only for opted-in
    // projects with budget-share left (docs/milestone-4-memory.md §4).
    for (const project of projects) {
      if (!memorySummariesEnabled(this.db, project.id)) continue;
      if (!canStartMemoryJob(this.db, this.now(), this.budgetLimit, this.dailyJobShare, this.reserve)) continue;
      if (!pickSummaryWork(this.db, project.id)) continue;
      this.enqueue(() => this.runSummaryWork(project));
      return;
    }
  }

  private async runDailySweep(project: ProjectRow): Promise<void> {
    await updateProjectMemory(this.db, this.opts.home, project, 'daily', this.now);
    dropStaleItems(this.db, project.id, STALE_DROP_DAYS, this.now);
  }

  /** Re-picks the work rather than reusing what `tick` saw: the queue may have sat behind an
   * `after-explain` or an earlier summary item, and the yield rule (docs/milestone-4-memory.md §2,
   * "the worker yields between items when a job starts") means a result already stale by the time
   * its own turn comes up must not be written as if it were still current. */
  private async runSummaryWork(project: ProjectRow): Promise<void> {
    if (this.isExplaining()) return;
    // Re-checked at start, not only when queued: the gates are what `startJob` must never bypass.
    if (!memorySummariesEnabled(this.db, project.id)) return;
    if (!canStartMemoryJob(this.db, this.now(), this.budgetLimit, this.dailyJobShare, this.reserve)) return;
    const work = pickSummaryWork(this.db, project.id);
    if (!work) return;
    const provider = this.opts.providerFactory([project.name]);
    if (!provider) return;
    const jobId = startJob(this.db, 'memory', { repoId: project.id }, this.budgetLimit, this.now);
    if (jobId === null) return;
    const job = { jobId, budget: this.budgetLimit, now: this.now };
    try {
      if (work.kind === 'areas') await runAreaSummaryBatch(this.db, project, provider, work.items, job, 'idle', this.now);
      else await runThreadSummaryBatch(this.db, project, provider, work.item, job, 'idle', this.now);
    } finally {
      finishJob(this.db, jobId, this.now);
    }
  }
}

export type { MemoryTrigger };
