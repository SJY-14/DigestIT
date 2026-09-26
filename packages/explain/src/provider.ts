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

/** One work unit that moved, referenced by its key; L0/L1 text only, as in RollupUnit. */
export interface BriefingFactUnit {
  key: string;
  l0: string;
  userVisible: boolean;
  bullets: string[];
}

/** A unit waiting for human attention, oldest first. */
export interface BriefingUnreviewedFact {
  unit: string;
  size: number;
  deepestLevelViewed: 0 | 1 | 2 | 3 | null;
}

/** A unit flagged by one of the fixed "needs a decision" rules (see docs/milestone-3.md T1). */
export interface BriefingDecisionFact {
  unit: string;
  reason: string;
}

export interface BriefingNumbers {
  landed: number;
  decided: number;
  backlogDelta: number;
  llmCalls: number;
}

/**
 * Text-only briefing input: deterministic facts (SQL, always correct) plus each
 * moved unit's own L0/L1 text. No diff, no file contents, no code.
 */
export interface BriefingFacts {
  repoName: string;
  windowStart: string;
  windowEnd: string;
  numbers: BriefingNumbers;
  units: BriefingFactUnit[];
  unreviewed: BriefingUnreviewedFact[];
  needsDecision: BriefingDecisionFact[];
  retryFeedback?: string[];
}

export interface BriefingSentence {
  text: string;
  /** Unit keys this sentence cites; always a subset of keys present in the facts. */
  units: string[];
}

export interface BriefingResult {
  sentences: BriefingSentence[];
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
  /** One text-only call returns a ≤5-sentence narrative over facts + unit L0/L1 text. */
  briefing?(input: BriefingFacts): Promise<BriefingResult>;
}
