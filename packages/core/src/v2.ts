// Direction v2 (DIG-33): data-model rows and API DTOs shared by ingest, explain, server and web.
// Design: docs/direction-v2.md. The API contract here is what apps/web builds against.
import type { ChangeStatus, CommitStats, ExplanationStatus, FilteredReason, L0Content, L1Content } from './types.js';

export type RepoMode = 'history' | 'project';
export type CheckpointReason = 'init' | 'explain' | 'manual';
/** Why a file was not stored in the shadow store at snapshot time. */
export type SkipReason = 'denylist' | 'too_large' | 'nested_repo' | 'unreadable';

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

export interface AreaNote {
  path: string;
  side: 'new' | 'old';
  startLine: number;
  endLine: number;
  note: string;
}
/** Lazy L3 for one L2 area. */
export interface AreaL3Content {
  why: string;
  design: string;
  risks: string[];
  notes: AreaNote[];
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
  context: ContextStatusDto;
  lastCheckpointAt: string | null;
  digestCount: number;
}

/** GET /api/projects/:id/status: cheap, no LLM call. */
export interface ProjectStatusDto {
  project: ProjectDto;
  pending: CommitStats;
  budget: BudgetDto;
  /** True while an Explain for this project is running. */
  explaining: boolean;
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
}

/** GET /api/digests/:id/areas/:areaId and POST .../explain (POST generates if not cached). */
export interface AreaDetailDto {
  digestId: number;
  areaId: string;
  status: ExplanationStatus | 'none';
  l3: AreaL3Content | null;
  files: (DigestFileDto & { patch: string | null })[];
}

/** POST /api/projects/:id/explain */
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

/** GET /api/digests/:id/graph?expand=<dir>&expand=<dir> (deterministic, no LLM call) */
export interface ProjectGraphDto {
  digestId: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Files in the digest's `to` checkpoint plus the deleted ones. */
  totalFiles: number;
  /** True when changed folders had to be folded to stay under the node cap. */
  truncated: boolean;
}
