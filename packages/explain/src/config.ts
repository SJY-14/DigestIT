import { ClaudeCodeProvider } from './claude-code.js';
import type { ContextInput, ContextResult, ExplanationInput, ExplanationProvider, ProviderResult } from './provider.js';
import { StubProvider } from './stub.js';

export interface ExplainConfig {
  provider: 'stub' | 'claude-code';
  /** Repo names allowed to be explained; anything else is refused before a provider call. */
  repoAllowlist: string[];
  claudeBin?: string;
  claudeModel?: string;
  timeoutMs?: number;
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
      });
      break;
    default:
      throw new Error(`unknown provider: ${String((config as { provider: unknown }).provider)}`);
  }
  return withAllowlist(inner, config.repoAllowlist);
}
