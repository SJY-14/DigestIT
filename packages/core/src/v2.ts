// Direction v2 (DIG-33): data-model rows and API DTOs shared by ingest, explain, server and web.
// Design: docs/direction-v2.md. The API contract here is what apps/web builds against.
import type { ChangeStatus, CommitStats, ExplanationStatus, FilteredReason, L0Content, L1Content } from './types.js';

export type RepoMode = 'history' | 'project';
export type CheckpointReason = 'init' | 'explain' | 'manual';
/**
 * Why a file was not stored in the shadow store at snapshot time. `denylist` is DigestIT's own
 * hardcoded safety net; `gitignore` is the project's own `.gitignore`; `project-ignore` is a
 * pattern the operator added in DigestIT's data dir (DIG-56); `git-exclude` is the project's
 * `.git/info/exclude` or its configured global excludes file.
 */
export type SkipReason = 'denylist' | 'gitignore' | 'project-ignore' | 'too_large' | 'nested_repo' | 'unreadable' | 'git-exclude';

export interface Checkpoint {
  id: number;
  repoId: number;
  seq: number;
  shadowSha: string;
  treeSha: string;
  takenAt: string;
  reason: CheckpointReason;
  /** User's own HEAD/branch if the project is a git repo (read-only info, may be null). */
  userHead: string | null;
  userBranch: string | null;
  skipped: { path: string; reason: SkipReason }[];
}

export interface Digest {
  changeUnitId: number;
  repoId: number;
  fromCheckpointId: number;
  toCheckpointId: number;
  createdAt: string;
  stats: CommitStats;
}

/** L2 for a digest: changed areas (file/module groups), each clickable for lazy L3. */
export interface DigestL2Item {
  /** Stable within the digest; the key for `area_explanation.area_id`. [a-z0-9-], ≤ 40 chars. */
  id: string;
  paths: string[];
  /** L0 for the area: one line, ≤ 8 words. */
  title: string;
  /** L1 for the area: what a user notices (≤ 20 words), or "No visible change". */
  effect: string;
  /** Roughly how the code was changed. */
  how: string;
  /** Why it was changed that way (grounded in the diff or project context). */
  why: string;
}
export interface DigestL2Content {
  items: DigestL2Item[];
  notAnalysed: string[];
}

// ---- UX v3 (DIG-47, docs/ux-v3.md): L3 walkthrough and explanation language ----

/** Language the explanations (L0–L3, context, step titles) are written in. Code identifiers stay as written. */
export type ExplainLanguage = 'en' | 'ko';
export const EXPLAIN_LANGUAGES: readonly ExplainLanguage[] = ['en', 'ko'];

/**
 * One hunk of one file's patch. `hunk` is 1-based: the n-th `@@` hunk header of that file's
 * patch, counted the same way in the prompt ("hunk n"), the validator and the UI. The patch is
 * the one `AreaDetailDto.files[].patch` returns; hunks cut off by the token budget are simply
 * absent from the prompt and shown by the UI as "not covered by the walkthrough".
 */
export interface HunkRef {
  path: string;
  hunk: number;
}

export interface WalkthroughStep {
  /** Short title, ≤ 8 words, in the explanation language. */
  title: string;
  /** Prose: what this code does now, what it did before, and why it was changed this way. */
  body: string;
  /** The hunks this step explains, in reading order; at least one. Shown right under `body`. */
  hunks: HunkRef[];
  /** True only for the (at most one) step that groups mechanical changes: renames, formatting, moves. */
  mechanical: boolean;
}

/** Lazy L3 for one L2 area: a step-by-step walkthrough of its hunks (DIG-48). */
export interface AreaWalkthrough {
  /** 2–3 sentences on the area's change as a whole. */
  overview: string;
  /** Ordered; together they cover every hunk of the area that was in the prompt. */
  steps: WalkthroughStep[];
  /** "What to check": risks, edge cases, tests to look at. 1–5 items. */
  check: string[];
}

export interface ProjectContextContent {
  purpose: string;
  modules: { path: string; role: string }[];
  glossary: { term: string; meaning: string }[];
  conventions: string[];
}

// ---- API DTOs ----

export interface BudgetDto {
  limit: number;
  used: number;
  remaining: number;
  /** ISO time the daily window resets. */
  resetsAt: string;
}

export interface ContextStatusDto {
  status: ExplanationStatus | 'none';
  builtAt: string | null;
  fromFiles: number | null;
  hasUserContext: boolean;
}

/** GET /api/projects */
export interface ProjectDto {
  id: number;
  name: string;
  rootPath: string;
  language: ExplainLanguage;
  context: ContextStatusDto;
  lastCheckpointAt: string | null;
  digestCount: number;
}

/** A suggested ignore pattern (DIG-56): detected on `init` of a folder without its own
 * `.gitignore`, never applied automatically. */
export interface IgnoreSuggestionDto {
  pattern: string;
  reason: string;
}

/** POST /api/projects response: the project, plus any detected-but-unapplied ignore suggestions. */
export interface CreateProjectResponseDto extends ProjectDto {
  suggestedIgnorePatterns: IgnoreSuggestionDto[];
}

/** One reason group in `ProjectIgnoreDto.notTracked`, with a couple of example paths. */
export interface NotTrackedGroupDto {
  reason: SkipReason;
  count: number;
  examples: string[];
}

/** GET/POST /api/projects/:id/ignore */
export interface ProjectIgnoreDto {
  /** This project's own gitignore-syntax patterns, in DigestIT's data dir (never in the project). */
  patterns: string[];
  /** Paths not stored in the shadow, from the latest checkpoint, grouped by why. */
  notTracked: NotTrackedGroupDto[];
}

/** GET /api/projects/:id/status: cheap, no LLM call. */
export interface ProjectStatusDto {
  project: ProjectDto;
  pending: CommitStats;
  budget: BudgetDto;
  /** True while an Explain for this project is running. */
  explaining: boolean;
  /** When the running Explain started, so a reload can still show elapsed time. Null when not explaining. */
  explainStartedAt: string | null;
}

/** GET /api/projects/:id/digests?cursor=&limit= (newest first) */
export interface DigestSummaryDto {
  id: number;
  seq: number;
  fromAt: string;
  toAt: string;
  stats: CommitStats;
  status: ExplanationStatus;
  l0: L0Content | null;
  /** The language this digest's explanations were generated in. */
  language: ExplainLanguage;
}
export interface DigestPageDto {
  items: DigestSummaryDto[];
  nextCursor: string | null;
}

export interface DigestFileDto {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  filteredReason: FilteredReason | null;
}

/** GET /api/digests/:id, and POST /api/digests/:id/explain: re-runs L0/L1/L2 for an
 * `error`/`truncated` digest. Costs 1 call. Both return this DTO. */
export interface DigestDetailDto extends DigestSummaryDto {
  projectId: number;
  l1: L1Content | null;
  l2: DigestL2Content | null;
  files: DigestFileDto[];
  skipped: { path: string; reason: SkipReason }[];
  /** Deterministic areas (DIG-73), present from the moment the digest row exists; `l2.items[].id`
   * matches `areas[].id` once each area's text lands. Optional only until DIG-75 ships. */
  areas?: DigestAreaSkeleton[];
  /** Per-part progress of the split Explain (DIG-73). Optional only until DIG-75 ships. */
  parts?: DigestPartsDto;
}

/** GET /api/digests/:id/areas/:areaId and POST .../explain (POST generates if not cached). */
export interface AreaDetailDto {
  digestId: number;
  areaId: string;
  status: ExplanationStatus | 'none';
  /** `null` until generated; rows from an older area prompt version read as `status: 'none'`. */
  l3: AreaWalkthrough | null;
  files: (DigestFileDto & { patch: string | null })[];
}

/** POST /api/projects/:id/explain. Since DIG-73 it returns as soon as the snapshot, checkpoint and
 * digest row exist (target < 1 s) with `status: 'pending'`; the LLM parts run in the background and
 * report through `GET /api/digests/:id/events`. */
export interface ExplainResultDto {
  noChanges: boolean;
  digestId: number | null;
  status: ExplanationStatus | null;
  budget: BudgetDto;
}

// ---- Project graph (main-screen right pane, docs/direction-v2.md §5) ----

/** `root` is the project folder. `group` stands for several unchanged children of one folder. */
export type GraphNodeKind = 'root' | 'dir' | 'file' | 'group';
/** Only containment today. `imports` and `cochange` edges can be added later without changing nodes. */
export type GraphEdgeKind = 'contains';

export interface GraphNode {
  /** `d:<dir>` (root is `d:`), `f:<file>` or `g:<dir>`. Stable across digests of one project. */
  id: string;
  kind: GraphNodeKind;
  /** Project-relative path; for a group, its folder. */
  path: string;
  /** Basename, or "12 files" / "3 folders, 12 files" for a group. */
  name: string;
  parentId: string | null;
  depth: number;
  /** A folder whose children are not shown (unchanged, or folded to fit the node cap). */
  collapsed: boolean;
  /** Files at or under this node (1 for a file). */
  fileCount: number;
  /** True if anything at or under this node changed in the digest: drawn blue. */
  changed: boolean;
  changedFiles: number;
  additions: number;
  deletions: number;
  /** Files only. */
  status: ChangeStatus | null;
  /** L2 areas touching this node or anything under it. */
  areaIds: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

/**
 * GET /api/digests/:id/graph?expand=<dir>&expand=<dir>, or GET /api/projects/:id/graph for a
 * project with no digest yet (`digestId: null`; every node then has `changed: false`,
 * `changedFiles`/`additions`/`deletions: 0`, `status: null` and `areaIds: []`). Deterministic, no
 * LLM call either way.
 */
export interface ProjectGraphDto {
  digestId: number | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Files in the digest's `to` checkpoint plus the deleted ones (or, with no digest yet, the latest checkpoint's files). */
  totalFiles: number;
  /** True when changed folders had to be folded to stay under the node cap. */
  truncated: boolean;
}

// ---- Fast Explain (DIG-73, docs/explain-speed.md) ----

/** One area of a digest, computed without an LLM from the changed files (`groupDigestAreas`). */
export interface DigestAreaSkeleton {
  /** Stable within the digest, [a-z0-9-], ≤ 40 chars; also the `DigestL2Item.id` and `area_explanation.area_id`. */
  id: string;
  /** Human-readable folder/module label shown until the LLM title lands, e.g. `packages/explain` or `docs`. */
  label: string;
  /** Every analysed and not-analysed changed file of the digest is in exactly one area. */
  paths: string[];
  additions: number;
  deletions: number;
}

/** `budget`: the daily limit was reached before the part could start; `skipped`: not needed. */
export type PartStatus = 'pending' | 'running' | 'ok' | 'truncated' | 'error' | 'budget' | 'skipped';

export interface DigestPartsDto {
  /** The L0 + L1 call. */
  summary: PartStatus;
  /** The L2 text of each area, keyed by `DigestAreaSkeleton.id`. */
  areas: Record<string, PartStatus>;
  /** The project context build when it runs inside this Explain (first Explain of a project); else `skipped`. */
  context: PartStatus;
  /** When the whole Explain started and (once every part settled) finished; ISO times. */
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * `GET /api/digests/:id/events` (SSE). The server sends `event: parts` with the full `DigestPartsDto`
 * on connect and whenever a part changes status; the client refetches `GET /api/digests/:id` to get
 * the text of a part that turned `ok`/`truncated`. `event: area-progress` carries an L3 walkthrough
 * as it streams in (steps are appended, never reordered); the final, validated walkthrough is the one
 * `GET /api/digests/:id/areas/:areaId` returns once `done` is true. `event: done` is sent when every
 * part of the digest and every running area L3 has settled; the server then closes the stream.
 */
export interface AreaProgressEvent {
  areaId: string;
  /** Present once the model has written it. */
  overview: string | null;
  /** Complete steps so far, in order; a step is sent only after its closing brace arrived. */
  steps: WalkthroughStep[];
  done: boolean;
}
