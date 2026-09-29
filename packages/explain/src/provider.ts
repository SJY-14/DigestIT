import type {
  AreaWalkthrough,
  DigestAreaSkeleton,
  DigestL2Content,
  ExplainLanguage,
  L0Content,
  L1Content,
  L2Content,
  L3Content,
  ProjectContextContent,
  WalkthroughStep,
} from '@digestit/core';

/** The four Fast Explain tasks (docs/explain-speed.md §3), each with its own model/effort. */
export type ExplainTask = 'context' | 'summary' | 'area' | 'walkthrough';
export const EXPLAIN_TASKS: readonly ExplainTask[] = ['context', 'summary', 'area', 'walkthrough'];

/** `claude --effort`. */
export type Effort = 'low' | 'medium' | 'high';

/** Per-call timing (docs/explain-speed.md §1), from the CLI's `stream-json` events. */
export interface CallTiming {
  /** Spawn to the CLI's `system`/`init` event. */
  startupMs: number;
  /** Init to the first text delta. */
  ttftMs: number;
  /** First text delta to the `result` event. */
  genMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Outcome of one part of a split Explain (docs/explain-speed.md §4); shared by every part function. */
export type PartOutcome = {
  outcome: 'ok' | 'truncated' | 'error' | 'cached';
  calls: number;
  detail?: string;
};

/** A provider call's own model/effort and timing, present once the call is made over `stream-json`. */
export interface CallMeta {
  effort?: Effort;
  timing?: CallTiming;
}

/** Steps arrive in order and are only ever appended; `overview` is set once the model has written it. */
export interface AreaStreamChunk {
  overview: string | null;
  steps: WalkthroughStep[];
  done: boolean;
}

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

// ---- Project context (DIG-36, docs/direction-v2.md §3) ----

/** Per-directory rollup inside a `ProjectMap`; `path` is `''` for the project root. */
export interface ProjectMapDir {
  path: string;
  fileCount: number;
  /** Extension (no dot; `''` for none) to file count, within this directory only. */
  extensions: Record<string, number>;
}

export type ManifestKind = 'package.json' | 'pyproject.toml' | 'Cargo.toml' | 'go.mod';

export interface ProjectManifest {
  path: string;
  kind: ManifestKind;
  name: string | null;
  description: string | null;
  /** `package.json` script names only (no commands); `null` for other manifest kinds. */
  scripts: string[] | null;
  /** `package.json` workspaces globs; `null` for other manifest kinds. */
  workspaces: string[] | null;
}

export interface ProjectDoc {
  path: string;
  headings: string[];
}

/**
 * Deterministic structural map of a project: no LLM call. Built from the
 * (already ignore/denylist-filtered) tracked file list.
 */
export interface ProjectMap {
  /** Up to 400 paths, sorted; the full set is still reflected in `dirs` and `totalFiles`. */
  paths: string[];
  truncatedPaths: boolean;
  totalFiles: number;
  /** First path segment of every non-root file, sorted and de-duplicated. */
  topLevelDirs: string[];
  dirs: ProjectMapDir[];
  readme: { path: string; content: string; truncated: boolean } | null;
  manifests: ProjectManifest[];
  docs: ProjectDoc[];
  /** Deterministic hash of everything above; equal maps hash equal. */
  sourceHash: string;
}

export interface ContextInput {
  repoName: string;
  map: ProjectMap;
  /** Redacted and capped by the caller; `null` when the project has no user-authored context. */
  userMd: string | null;
  /** Language the description is written in. */
  language: ExplainLanguage;
  retryFeedback?: string[];
}

export interface ContextResult extends CallMeta {
  content: ProjectContextContent;
  provider: string;
  model: string;
}

/**
 * Prepared input for a digest (changes between two checkpoints, no commit
 * messages). `context` is the compact project description, when built (DIG-36).
 */
export interface DigestInput {
  repoName: string;
  files: ProviderFile[];
  context?: string;
  /** Language every prose field is written in; code stays as written. */
  language: ExplainLanguage;
  retryFeedback?: string[];
}

export interface DigestLevels {
  l0: L0Content;
  l1: L1Content;
  /** 1-8 clickable areas; no L3 here, it is lazy per area (DIG-37). */
  l2: DigestL2Content;
}

export interface DigestResult {
  levels: DigestLevels;
  provider: string;
  model: string;
}

/**
 * Prepared input for the split `summary` part (docs/explain-speed.md §4): the
 * whole diff under a smaller budget, plus the deterministic area list (labels
 * only, no LLM text yet) so L0/L1 can refer to "the area list" for shape.
 */
export interface DigestSummaryInput {
  repoName: string;
  files: ProviderFile[];
  areas: Pick<DigestAreaSkeleton, 'id' | 'label'>[];
  context?: string;
  language: ExplainLanguage;
  retryFeedback?: string[];
}

export interface DigestSummaryLevels {
  l0: L0Content;
  l1: L1Content;
}

export interface DigestSummaryResult extends CallMeta {
  levels: DigestSummaryLevels;
  provider: string;
  model: string;
}

/** Prepared input for one `area:<id>` part: only that area's own files. */
export interface DigestAreaTextInput {
  repoName: string;
  area: Pick<DigestAreaSkeleton, 'id' | 'label'>;
  areas: Pick<DigestAreaSkeleton, 'id' | 'label'>[];
  files: ProviderFile[];
  context?: string;
  language: ExplainLanguage;
  retryFeedback?: string[];
}

export interface DigestAreaTextContent {
  title: string;
  effect: string;
  how: string;
  why: string;
}

export interface DigestAreaTextResult extends CallMeta {
  content: DigestAreaTextContent;
  provider: string;
  model: string;
}

/**
 * Prepared input for one L2 area's lazy L3 (DIG-37): only that area's own
 * files (already filtered, budgeted and redacted), plus the digest's L0/L1
 * and this area's own L2 item as grounding, and the compact project context.
 */
export interface AreaInput {
  repoName: string;
  context?: string;
  digest: { l0: string; l1Bullets: string[] };
  area: { id: string; title: string; effect: string; how: string; why: string };
  files: ProviderFile[];
  /** Language every prose field is written in; code stays as written. */
  language: ExplainLanguage;
  retryFeedback?: string[];
}

export interface AreaResult extends CallMeta {
  content: AreaWalkthrough;
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
  /** One call returns the project's purpose, key modules, glossary and conventions. */
  explainContext?(input: ContextInput): Promise<ContextResult>;
  /** One call returns L0 + L1 + L2 areas for a digest (the one-call path; kept for the CLI). */
  digest?(input: DigestInput): Promise<DigestResult>;
  /** Split `summary` part (DIG-74/75): one call returns L0 + L1 only. */
  explainDigestSummary?(input: DigestSummaryInput): Promise<DigestSummaryResult>;
  /** Split `area:<id>` part (DIG-74/75): one call returns one area's title/effect/how/why. */
  explainDigestAreaText?(input: DigestAreaTextInput): Promise<DigestAreaTextResult>;
  /**
   * One call returns the lazy L3 walkthrough (overview, steps over hunks, what to check) for one
   * L2 area. `onProgress`, when given, is called with the partial walkthrough as it streams;
   * steps are only ever appended, never reordered or edited.
   */
  explainArea?(input: AreaInput, onProgress?: (chunk: AreaStreamChunk) => void): Promise<AreaResult>;
}
