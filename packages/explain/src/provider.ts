import type { L0Content, L1Content, L2Content, L3Content } from '@digestit/core';

export interface ProviderFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'B';
  additions: number;
  deletions: number;
  /** Prepared (filtered, budgeted, redacted) patch; null when the file was filtered out. */
  patch: string | null;
  filteredReason: string | null;
}

/** Prepared input for one change unit. Diff text is data, never instructions. */
export interface ExplanationInput {
  repoName: string;
  title: string;
  message: string;
  files: ProviderFile[];
  /** Validation problems from the previous attempt; only set on the pipeline's single retry. */
  retryFeedback?: string[];
}

export interface AllLevels {
  l0: L0Content;
  l1: L1Content;
  l2: L2Content;
  l3: L3Content;
}

export interface ProviderResult {
  levels: AllLevels;
  provider: string;
  model: string;
}

/** One commit inside a range unit; the subject is quoted data. */
export interface RangeMember {
  sha: string;
  subject: string;
}

/** Prepared input for a multi-commit range unit (`git diff base head`). `files` come from the range diff. */
export interface RangeInput {
  repoName: string;
  title: string;
  members: RangeMember[];
  files: ProviderFile[];
  retryFeedback?: string[];
}

/** One work unit that moved in a roll-up window, described only by its own L0/L1 text. */
export interface RollupUnit {
  key: string;
  title: string;
  state: string;
  l0: string;
  userVisible: boolean;
  bullets: string[];
}

/** Text-only roll-up input: no diff, no file contents. */
export interface RollupInput {
  repoName: string;
  windowStart: string;
  windowEnd: string;
  units: RollupUnit[];
  retryFeedback?: string[];
}

export interface RollupLevels {
  l0: L0Content;
  l1: L1Content;
}

export interface RollupResult {
  levels: RollupLevels;
  provider: string;
  model: string;
}

export interface ExplanationProvider {
  readonly id: string;
  readonly model: string;
  /** One call returns all four levels. */
  explain(input: ExplanationInput): Promise<ProviderResult>;
  /** One call returns all four levels for a multi-commit range diff. */
  explainRange?(input: RangeInput): Promise<ProviderResult>;
  /** One text-only call returns L0 + L1 for a time window. */
  rollup?(input: RollupInput): Promise<RollupResult>;
}
