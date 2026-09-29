import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BudgetDto, CheckpointReason, CommitStats, DigestAreaSkeleton, ExplainLanguage, SkipReason } from '@digestit/core';
import { groupDigestAreas } from '@digestit/core';
import { type DigestOutcome, type ExplanationProvider, explainDigest, filterReason } from '@digestit/explain';
import { DEFAULT_DAILY_BUDGET, startOfLocalDay } from './scheduler.js';
import { ensureDir0700, projectDataDir } from './datahome.js';
import { addIgnorePatterns, hasOwnGitignore, readIgnorePatterns, suggestIgnorePatterns, type IgnoreSuggestion } from './ignore.js';
import { diff, listTree, openShadow, pending, snapshot, userGitInfo, type PendingResult } from './shadow.js';
import { loadWorkspacePrefixes } from './workspace.js';

export class ProjectLockedError extends Error {
  constructor() {
    super('an explain is already running for this project');
    this.name = 'ProjectLockedError';
  }
}

interface LockInfo {
  pid: number;
  /** When the explain holding this lock started (ISO); null for a legacy plain-pid lock. */
  startedAt: string | null;
}

/** Accepts the current JSON lock content, and a bare pid (older lock files, or tests). */
function parseLock(raw: string): LockInfo | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
    if (Number.isInteger(parsed.pid) && typeof parsed.startedAt === 'string') {
      return { pid: parsed.pid as number, startedAt: parsed.startedAt };
    }
  } catch {
    /* not JSON: fall through to the bare-pid format */
  }
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? { pid, startedAt: null } : null;
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock's info if it exists and names a live process (a crashed or killed explain leaves a stale one). */
function readLiveLock(path: string): LockInfo | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const info = parseLock(raw);
  return info && isLive(info.pid) ? info : null;
}

function lockHeld(path: string): boolean {
  return readLiveLock(path) !== null;
}

/** Creates the lock atomically with the pid+start time already in it (write a temp file, then hard-link it into place). */
function tryLock(path: string, startedAt: string): boolean {
  const tmp = `${path}.${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt }), { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    unlinkSync(tmp);
  }
}

/**
 * Acquires the per-project explain lock synchronously; throws `ProjectLockedError` when another
 * explain (fresh, retry, or DIG-75's async job) already holds it. Split out from `withProjectLock`
 * so the async job runner can hold the lock across a backgrounded LLM phase instead of only across
 * one awaited call (DIG-75: the lock must stay held until the job settles, not until the HTTP
 * response is sent).
 */
export function acquireProjectLock(dataDir: string, startedAt: string): void {
  ensureDir0700(dataDir);
  const path = `${dataDir}/explain.lock`;
  if (!tryLock(path, startedAt)) {
    if (lockHeld(path)) throw new ProjectLockedError();
    try { unlinkSync(path); } catch { /* removed concurrently */ }
    if (!tryLock(path, startedAt)) throw new ProjectLockedError();
  }
}

export function releaseProjectLock(dataDir: string): void {
  try { unlinkSync(`${dataDir}/explain.lock`); } catch { /* already gone */ }
}

/** Exclusive, per-project lock file: only one `explain` (fresh or `--retry`) runs at a time. */
function withProjectLock<T>(dataDir: string, startedAt: string, fn: () => Promise<T>): Promise<T> {
  acquireProjectLock(dataDir, startedAt);
  return fn().finally(() => releaseProjectLock(dataDir));
}

export function isExplaining(home: string, repoId: number): boolean {
  return lockHeld(`${projectDataDir(home, repoId)}/explain.lock`);
}

/** When the running Explain for this project started (ISO), so the UI can show elapsed time
 * across a reload. Null when nothing is running, or the lock predates this field. */
export function explainingSince(home: string, repoId: number): string | null {
  return readLiveLock(`${projectDataDir(home, repoId)}/explain.lock`)?.startedAt ?? null;
}

export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  language: ExplainLanguage;
  contextPath: string | null;
  createdAt: string | null;
}

interface RepoRow {
  id: number; name: string; path: string; language: ExplainLanguage; context_path: string | null; created_at: string | null;
}
const toProjectRow = (r: RepoRow): ProjectRow => ({
  id: r.id, name: r.name, path: r.path, language: r.language, contextPath: r.context_path, createdAt: r.created_at,
});

export function listProjects(db: DatabaseSync): ProjectRow[] {
  return (db.prepare("SELECT id, name, path, language, context_path, created_at FROM repo WHERE mode = 'project' ORDER BY id")
    .all() as unknown as RepoRow[]).map(toProjectRow);
}

/** `PATCH /api/projects/:id {language}` and `digest config <project> --language <l>`. */
export function updateProjectLanguage(db: DatabaseSync, repoId: number, language: ExplainLanguage): void {
  db.prepare('UPDATE repo SET language = ? WHERE id = ?').run(language, repoId);
}

/** Resolves a `[project]` CLI argument (numeric id or exact name); falls back to the sole registered project. */
export function findProject(db: DatabaseSync, ref?: string): ProjectRow | { error: string } {
  const projects = listProjects(db);
  if (ref) {
    const found = (/^\d+$/.test(ref) ? projects.find((p) => p.id === Number(ref)) : undefined)
      ?? projects.find((p) => p.name === ref);
    return found ?? { error: `no project "${ref}"` };
  }
  if (projects.length === 1) return projects[0]!;
  if (projects.length === 0) return { error: 'no projects registered; run `digest init <path>` first' };
  return { error: `multiple projects registered; specify one: ${projects.map((p) => p.name).join(', ')}` };
}

export interface CheckpointRow {
  id: number;
  repoId: number;
  seq: number;
  shadowSha: string;
  treeSha: string;
  takenAt: string;
  reason: CheckpointReason;
  userHead: string | null;
  userBranch: string | null;
  skipped: { path: string; reason: SkipReason }[];
}

interface CheckpointDbRow {
  id: number; repo_id: number; seq: number; shadow_sha: string; tree_sha: string; taken_at: string;
  reason: CheckpointReason; user_head: string | null; user_branch: string | null; skipped: string;
}
const toCheckpointRow = (r: CheckpointDbRow): CheckpointRow => ({
  id: r.id, repoId: r.repo_id, seq: r.seq, shadowSha: r.shadow_sha, treeSha: r.tree_sha, takenAt: r.taken_at,
  reason: r.reason, userHead: r.user_head, userBranch: r.user_branch, skipped: JSON.parse(r.skipped),
});

export function latestCheckpoint(db: DatabaseSync, repoId: number): CheckpointRow | null {
  const r = db.prepare('SELECT * FROM checkpoint WHERE repo_id = ? ORDER BY seq DESC LIMIT 1').get(repoId) as CheckpointDbRow | undefined;
  return r ? toCheckpointRow(r) : null;
}

function insertCheckpoint(
  db: DatabaseSync, repoId: number, seq: number, treeSha: string, reason: CheckpointReason,
  userHead: string | null, userBranch: string | null, skipped: { path: string; reason: SkipReason }[], at: string,
): number {
  return Number(db.prepare(
    `INSERT INTO checkpoint (repo_id, seq, shadow_sha, tree_sha, taken_at, reason, user_head, user_branch, skipped)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(repoId, seq, treeSha, treeSha, at, reason, userHead, userBranch, JSON.stringify(skipped)).lastInsertRowid);
}

function uniqueRepoName(db: DatabaseSync, base: string): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!db.prepare('SELECT 1 FROM repo WHERE name = ?').get(name)) return name;
  }
}

export interface InitOptions {
  name?: string;
  /** Absolute or cwd-relative path to a user-authored context `.md`; validated to exist. */
  contextPath?: string;
  /** Explanation language for this project (default `'en'`). */
  language?: ExplainLanguage;
  /** Extra gitignore-syntax patterns (DIG-56) to add to this project's own ignore file, on top of whatever it already has. */
  ignorePatterns?: string[];
}

export interface InitResult {
  repoId: number;
  name: string;
  path: string;
  dataDir: string;
  /** False when the path was already registered (a no-op re-run). */
  created: boolean;
  tracked: number;
  skipped: { path: string; reason: SkipReason }[];
  /** Suggested ignore patterns because the project has no `.gitignore` of its own; only populated
   * the first time a project is registered, and never includes a pattern already added. Never
   * applied — the caller (CLI or dashboard) decides whether to add any of them. */
  suggestedIgnorePatterns: IgnoreSuggestion[];
}

/** `digest init`: registers a project, takes checkpoint #1, and reports what will be sent. Idempotent per path. */
export async function initProject(
  db: DatabaseSync, home: string, rawPath: string, opts: InitOptions = {}, now: () => Date = () => new Date(),
): Promise<InitResult> {
  const path = realpathSync(resolve(rawPath));
  const contextPath = opts.contextPath ? resolve(opts.contextPath) : null;
  if (contextPath && !existsSync(contextPath)) throw new Error(`context file not found: ${contextPath}`);

  const existing = db.prepare("SELECT id, name FROM repo WHERE path = ? AND mode = 'project'").get(path) as { id: number; name: string } | undefined;
  if (existing) {
    const dataDir = projectDataDir(home, existing.id);
    if (opts.ignorePatterns?.length) {
      ensureDir0700(dataDir);
      await addIgnorePatterns(dataDir, opts.ignorePatterns);
    }
    const latest = latestCheckpoint(db, existing.id);
    // No checkpoint means an earlier init failed after registering: finish it now.
    if (!latest) {
      return {
        ...(await takeInitCheckpoint(db, dataDir, existing.id, path, now().toISOString())),
        repoId: existing.id, name: existing.name, path, dataDir, created: true, suggestedIgnorePatterns: [],
      };
    }
    const shadow = await openShadow(dataDir, path);
    const tracked = await listTree(shadow, latest.treeSha);
    return {
      repoId: existing.id, name: existing.name, path, dataDir, created: false, tracked: tracked.length,
      skipped: latest.skipped, suggestedIgnorePatterns: [],
    };
  }

  if (opts.name && db.prepare('SELECT 1 FROM repo WHERE name = ?').get(opts.name)) {
    throw new Error(`name "${opts.name}" is already used by another project`);
  }
  const name = opts.name ?? uniqueRepoName(db, basename(path));
  const at = now().toISOString();
  const language = opts.language ?? 'en';
  const repoId = Number(db.prepare(
    "INSERT INTO repo (name, path, mode, context_path, created_at, language) VALUES (?, ?, 'project', ?, ?, ?)",
  ).run(name, path, contextPath, at, language).lastInsertRowid);

  const dataDir = projectDataDir(home, repoId);
  ensureDir0700(dataDir);
  if (opts.ignorePatterns?.length) await addIgnorePatterns(dataDir, opts.ignorePatterns);
  // Detected before checkpoint #1, so it reflects the folder as the operator found it. Never
  // applied on their behalf, and never suggested once the project already has its own .gitignore.
  let suggestedIgnorePatterns: IgnoreSuggestion[] = [];
  if (!hasOwnGitignore(path)) {
    const already = new Set(readIgnorePatterns(dataDir));
    suggestedIgnorePatterns = (await suggestIgnorePatterns(path)).filter((s) => !already.has(s.pattern));
  }
  return {
    ...(await takeInitCheckpoint(db, dataDir, repoId, path, at)), repoId, name, path, dataDir, created: true,
    suggestedIgnorePatterns,
  };
}

async function takeInitCheckpoint(
  db: DatabaseSync, dataDir: string, repoId: number, path: string, at: string,
): Promise<Pick<InitResult, 'tracked' | 'skipped'>> {
  ensureDir0700(dataDir);
  const shadow = await openShadow(dataDir, path);
  const info = await userGitInfo(path);
  const result = await snapshot(shadow);
  insertCheckpoint(db, repoId, 1, result.treeSha, 'init', info?.head ?? null, info?.branch ?? null, result.skipped, at);
  const tracked = await listTree(shadow, result.treeSha);
  return { tracked: tracked.length, skipped: result.skipped };
}

/** Today's shared call budget (every `explain_call` reason counts). `limit` is the configured daily cap. */
export function budgetStatus(db: DatabaseSync, now: Date = new Date(), limit: number = DEFAULT_DAILY_BUDGET): BudgetDto {
  const start = startOfLocalDay(now);
  const used = (db.prepare("SELECT count(*) AS n FROM explain_call WHERE at >= ? AND outcome IN ('ok','error')")
    .get(start.toISOString()) as { n: number }).n;
  const resetsAt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).toISOString();
  return { limit, used, remaining: Math.max(0, limit - used), resetsAt };
}

export interface ProjectStatus {
  project: ProjectRow;
  pending: CommitStats;
  budget: BudgetDto;
  explaining: boolean;
  explainStartedAt: string | null;
}

/** `digest status`: pending changes + remaining budget, no snapshot write and no LLM call. */
export async function projectStatus(
  db: DatabaseSync, home: string, project: ProjectRow, now: Date = new Date(), limit: number = DEFAULT_DAILY_BUDGET,
): Promise<ProjectStatus> {
  const latest = latestCheckpoint(db, project.id);
  const dataDir = projectDataDir(home, project.id);
  const shadow = await openShadow(dataDir, project.path);
  const pendingStats: PendingResult = latest ? await pending(shadow, latest.shadowSha) : { files: 0, additions: 0, deletions: 0 };
  return {
    project, pending: pendingStats, budget: budgetStatus(db, now, limit),
    explaining: isExplaining(home, project.id), explainStartedAt: explainingSince(home, project.id),
  };
}

export interface ExplainProjectResult {
  noChanges: boolean;
  digestId: number | null;
  outcome: DigestOutcome | null;
  calls: number;
  detail?: string;
}

function insertDigestChangeUnit(
  db: DatabaseSync, repoId: number, fromCheckpoint: CheckpointRow, toCheckpointId: number, toTreeSha: string,
  files: Awaited<ReturnType<typeof diff>>, at: string, language: ExplainLanguage, areas: DigestAreaSkeleton[],
): number {
  const title = `checkpoint ${fromCheckpoint.seq} → ${fromCheckpoint.seq + 1}`;
  const changeUnitId = Number(db.prepare(
    "INSERT INTO change_unit (repo_id, kind, head_sha, base_sha, title) VALUES (?, 'digest', ?, ?, ?)",
  ).run(repoId, toTreeSha, fromCheckpoint.shadowSha, title).lastInsertRowid);
  const insFile = db.prepare(
    `INSERT INTO file_change (change_unit_id, path, old_path, status, additions, deletions, patch, filtered_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let additions = 0, deletions = 0;
  for (const f of files) {
    insFile.run(changeUnitId, f.path, f.oldPath, f.status, f.additions, f.deletions, f.patch, filterReason(f));
    additions += f.additions;
    deletions += f.deletions;
  }
  const stats: CommitStats = { files: files.length, additions, deletions };
  db.prepare(
    `INSERT INTO digest (change_unit_id, repo_id, from_checkpoint_id, to_checkpoint_id, created_at, stats, language, areas)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(changeUnitId, repoId, fromCheckpoint.id, toCheckpointId, at, JSON.stringify(stats), language, JSON.stringify(areas));
  return changeUnitId;
}

export interface ExplainOptions {
  /**
   * Compact project context for grounding. `explainProject` calls a function form after the new
   * checkpoint is recorded, so an Explain-time context refresh sees the current structure.
   */
  context?: string | (() => Promise<string | undefined>);
  /** Daily call cap shared with every other `explain_call` reason (default `DEFAULT_DAILY_BUDGET`). */
  budget?: number;
  now?: () => Date;
}

export interface PreparedExplainDigest {
  noChanges: boolean;
  changeUnitId: number | null;
  areas: DigestAreaSkeleton[];
}

/**
 * The snapshot/checkpoint/digest-row half of an Explain, with no LLM call: if the tree changed
 * since the last checkpoint, records a new checkpoint, a `digest` change unit, its files and its
 * deterministic areas (`groupDigestAreas`, DIG-75) in one transaction. Must be called with the
 * project lock already held; the caller reads `from` fresh inside that lock so a second,
 * concurrently queued call never mints a duplicate checkpoint for the same tree.
 *
 * Split out of `explainProject` (DIG-75) so the async job runner can await just this (target
 * < 1 s) before responding, then keep the lock held across the backgrounded LLM phase instead of
 * only across one awaited call.
 */
export async function prepareExplainDigest(
  db: DatabaseSync, home: string, project: ProjectRow, now: () => Date = () => new Date(),
): Promise<PreparedExplainDigest> {
  const dataDir = projectDataDir(home, project.id);
  const shadow = await openShadow(dataDir, project.path);
  const from = latestCheckpoint(db, project.id);
  if (!from) throw new Error(`project ${project.id} has no checkpoints; run \`digest init\` first`);
  const result = await snapshot(shadow, { parent: from.shadowSha });
  if (result.unchanged) return { noChanges: true, changeUnitId: null, areas: [] };
  const at = now().toISOString();
  const info = await userGitInfo(project.path);
  const files = await diff(shadow, from.shadowSha, result.treeSha);
  const areas = groupDigestAreas(
    files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    { workspacePrefixes: loadWorkspacePrefixes(project.path) },
  );
  // Checkpoint and digest land together, so a failure never leaves a checkpoint whose changes have no digest.
  let changeUnitId: number;
  db.exec('BEGIN');
  try {
    const toId = insertCheckpoint(db, project.id, from.seq + 1, result.treeSha, 'explain', info?.head ?? null, info?.branch ?? null, result.skipped, at);
    changeUnitId = insertDigestChangeUnit(db, project.id, from, toId, result.treeSha, files, at, project.language, areas);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { noChanges: false, changeUnitId, areas };
}

/**
 * `digest explain`: snapshots the project; if the tree changed, records a checkpoint, a `digest`
 * change unit and its files, then explains it (v2-4). Unchanged tree: no checkpoint, no call.
 * Serialized per project by a lock file, and the previous checkpoint is read inside that lock so a
 * second, concurrently queued call never mints a duplicate checkpoint for the same tree.
 */
export async function explainProject(
  db: DatabaseSync, home: string, project: ProjectRow, provider: ExplanationProvider, opts: ExplainOptions = {},
): Promise<ExplainProjectResult> {
  const now = opts.now ?? (() => new Date());
  const budget = opts.budget ?? DEFAULT_DAILY_BUDGET;
  const dataDir = projectDataDir(home, project.id);
  return withProjectLock(dataDir, now().toISOString(), async () => {
    const prepared = await prepareExplainDigest(db, home, project, now);
    if (prepared.noChanges) return { noChanges: true, digestId: null, outcome: null, calls: 0 };
    const context = typeof opts.context === 'function' ? await opts.context() : opts.context;
    const r = await explainDigest(db, prepared.changeUnitId!, provider, { context, budget, now, language: project.language });
    return { noChanges: false, digestId: prepared.changeUnitId, outcome: r.outcome, calls: r.calls, detail: r.detail };
  });
}

/** `digest explain --retry <digestId>`: re-runs the provider call for an existing digest; no new snapshot.
 * The retry keeps the language the digest was first written in, even if the project's changed since. */
export async function retryDigest(
  db: DatabaseSync, home: string, digestId: number, provider: ExplanationProvider, opts: ExplainOptions = {},
): Promise<ExplainProjectResult> {
  const row = db.prepare('SELECT repo_id, language FROM digest WHERE change_unit_id = ?').get(digestId) as
    { repo_id: number; language: ExplainLanguage } | undefined;
  if (!row) throw new Error(`no digest ${digestId}`);
  const budget = opts.budget ?? DEFAULT_DAILY_BUDGET;
  const dataDir = projectDataDir(home, row.repo_id);
  const startedAt = (opts.now ?? (() => new Date()))().toISOString();
  return withProjectLock(dataDir, startedAt, async () => {
    const context = typeof opts.context === 'function' ? await opts.context() : opts.context;
    const r = await explainDigest(db, digestId, provider, { context, budget, now: opts.now, language: row.language });
    return { noChanges: false, digestId, outcome: r.outcome, calls: r.calls, detail: r.detail };
  });
}
