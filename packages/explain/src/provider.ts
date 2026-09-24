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

export interface ExplanationProvider {
  readonly id: string;
  readonly model: string;
  /** One call returns all four levels. */
  explain(input: ExplanationInput): Promise<ProviderResult>;
}
