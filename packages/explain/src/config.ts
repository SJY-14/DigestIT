import type { CheapRunFlags, TaskModelConfig } from './claude-code.js';
import { ClaudeCodeProvider } from './claude-code.js';
import type {
  AreaInput, AreaResult, AreaStreamChunk, ContextInput, ContextResult, Effort, ExplainTask, ExplanationInput,
  ExplanationProvider, ProviderResult,
} from './provider.js';
import { EXPLAIN_TASKS } from './provider.js';
import { StubProvider } from './stub.js';

export interface ExplainConfig {
  provider: 'stub' | 'claude-code';
  /** Repo names allowed to be explained; anything else is refused before a provider call. */
  repoAllowlist: string[];
  claudeBin?: string;
  /** Legacy default model for the un-split commit-history calls. */
  claudeModel?: string;
  timeoutMs?: number;
  /** Per-task model/effort (docs/explain-speed.md §3); `DIGESTIT_MODEL_<TASK>`/`DIGESTIT_EFFORT_<TASK>` win over this. */
  tasks?: Partial<Record<ExplainTask, Partial<TaskModelConfig>>>;
  /** Cheaper CLI run flags (docs/explain-speed.md §2), each independently togglable. */
  cheapRun?: Partial<CheapRunFlags>;
  /** Spawn `cwd` for the split parts; see `explainCwd`. */
  cwd?: string;
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

function isEffort(v: string): v is Effort {
  return (EFFORTS as readonly string[]).includes(v);
}

/**
 * Applies `DIGESTIT_MODEL_<TASK>` / `DIGESTIT_EFFORT_<TASK>` (docs/explain-speed.md §3) over the
 * config's own per-task defaults; an unrecognised effort value is ignored (kept as configured).
 */
export function resolveTaskConfig(
  tasks: Partial<Record<ExplainTask, Partial<TaskModelConfig>>> | undefined, env: Record<string, string | undefined> = process.env,
): Partial<Record<ExplainTask, Partial<TaskModelConfig>>> {
  const out: Partial<Record<ExplainTask, Partial<TaskModelConfig>>> = {};
  for (const task of EXPLAIN_TASKS) {
    const base = tasks?.[task] ?? {};
    const model = env[`DIGESTIT_MODEL_${task.toUpperCase()}`];
    const effort = env[`DIGESTIT_EFFORT_${task.toUpperCase()}`];
    out[task] = {
      ...base,
      ...(model ? { model } : {}),
      ...(effort && isEffort(effort) ? { effort } : {}),
    };
  }
  return out;
}

export class RepoNotAllowedError extends Error {
  constructor(repoName: string) {
    super(`repo "${repoName}" is not on the explain allowlist`);
    this.name = 'RepoNotAllowedError';
  }
}

/** Wraps a provider so the allowlist is checked before any call. */
export function withAllowlist(
  inner: ExplanationProvider,
  allowlist: readonly string[],
): ExplanationProvider {
  return {
    id: inner.id,
    model: inner.model,
    explain(input: ExplanationInput): Promise<ProviderResult> {
      if (!allowlist.includes(input.repoName)) {
        return Promise.reject(new RepoNotAllowedError(input.repoName));
      }
      return inner.explain(input);
    },
    explainRange: inner.explainRange && ((input) => {
      if (!allowlist.includes(input.repoName)) return Promise.reject(new RepoNotAllowedError(input.repoName));
      return inner.explainRange!(input);
    }),
    rollup: inner.rollup && ((input) => {
      if (!allowlist.includes(input.repoName)) return Promise.reject(new RepoNotAllowedError(input.repoName));
      return inner.rollup!(input);
    }),
    explainContext: inner.explainContext && ((input: ContextInput): Promise<ContextResult> => {
      if (!allowlist.includes(input.repoName)) return Promise.reject(new RepoNotAllowedError(input.repoName));
      return inner.explainContext!(input);
    }),
    digest: inner.digest && ((input) => {
      if (!allowlist.includes(input.repoName)) return Promise.reject(new RepoNotAllowedError(input.repoName));
      return inner.digest!(input);
    }),
    explainDigestSummary: inner.explainDigestSummary && ((input) => {
      if (!allowlist.includes(input.repoName)) return Promise.reject(new RepoNotAllowedError(input.repoName));
      return inner.explainDigestSummary!(input);
    }),
    explainDigestAreaText: inner.explainDigestAreaText && ((input) => {
      if (!allowlist.includes(input.repoName)) return Promise.reject(new RepoNotAllowedError(input.repoName));
      return inner.explainDigestAreaText!(input);
    }),
    explainArea: inner.explainArea && ((input: AreaInput, onProgress?: (chunk: AreaStreamChunk) => void): Promise<AreaResult> => {
      if (!allowlist.includes(input.repoName)) return Promise.reject(new RepoNotAllowedError(input.repoName));
      return inner.explainArea!(input, onProgress);
    }),
  };
}

export function createProvider(config: ExplainConfig): ExplanationProvider {
  let inner: ExplanationProvider;
  switch (config.provider) {
    case 'stub':
      inner = new StubProvider();
      break;
    case 'claude-code':
      inner = new ClaudeCodeProvider({
        bin: config.claudeBin,
        model: config.claudeModel,
        timeoutMs: config.timeoutMs,
        tasks: resolveTaskConfig(config.tasks),
        cheapRun: config.cheapRun,
        cwd: config.cwd,
      });
      break;
    default:
      throw new Error(`unknown provider: ${String((config as { provider: unknown }).provider)}`);
  }
  return withAllowlist(inner, config.repoAllowlist);
}
