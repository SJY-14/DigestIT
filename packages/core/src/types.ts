export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'B';
export type FilteredReason = 'lockfile' | 'binary' | 'generated' | 'too_large';
export type ExplanationStatus = 'ok' | 'pending' | 'error' | 'truncated';
export type Level = 0 | 1 | 2 | 3;

export interface Repo {
  id: number;
  name: string;
  path: string;
  headSha: string | null;
  ingestedAt: string | null;
}

export interface CommitStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface Commit {
  sha: string;
  repoId: number;
  parents: string[];
  authorName: string;
  authoredAt: string;
  committedAt: string;
  message: string;
  branchRefs: string[];
  isMerge: boolean;
  stats: CommitStats;
}

export interface ChangeUnit {
  id: number;
  repoId: number;
  kind: 'commit' | 'range';
  headSha: string;
  baseSha: string | null;
  title: string;
}

export interface FileChange {
  changeUnitId: number;
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  filteredReason: FilteredReason | null;
}

export interface L0Content { text: string }
export interface L1Content { userVisible: boolean; bullets: string[] }
export interface L2Content {
  items: { path: string; role: string; change: string }[];
  notAnalysed: string[];
}
export interface L3Content {
  annotations: {
    path: string;
    side: 'new' | 'old';
    startLine: number;
    endLine: number;
    note: string;
  }[];
}

export interface LevelContentMap {
  0: L0Content;
  1: L1Content;
  2: L2Content;
  3: L3Content;
}

export interface Explanation<L extends Level = Level> {
  changeUnitId: number;
  level: L;
  content: LevelContentMap[L];
  status: ExplanationStatus;
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  createdAt: string;
}

export type WorkUnitKind = 'issue' | 'branch';
export type WorkUnitState = 'active' | 'handoff' | 'merged';

export interface WorkUnit {
  id: number;
  repoId: number;
  key: string;
  kind: WorkUnitKind;
  title: string;
  state: WorkUnitState;
  tipSha: string;
  baseSha: string | null;
  firstCommitAt: string;
  lastCommitAt: string;
  mergedAt: string | null;
  latestRangeUnitId: number | null;
}
