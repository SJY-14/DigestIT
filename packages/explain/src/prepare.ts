import { createHash } from 'node:crypto';
import type { FilteredReason } from '@digestit/core';
import type { ExplanationInput, ProviderFile } from './provider.js';
import { redact } from './redact.js';

/** Bump when filtering, budgeting or redaction behaviour changes; it feeds `input_hash`. */
export const PREP_VERSION = 'prep1';

export interface PrepareOptions {
  /** Total token budget for all patches. Tokens are estimated as ceil(chars / 4). */
  tokenBudget: number;
  /** Patches larger than this many bytes are filtered as `too_large`. */
  maxFileBytes: number;
  /** Do not bother truncating a file into fewer tokens than this. */
  minTruncateTokens: number;
}

export const DEFAULT_PREPARE_OPTIONS: PrepareOptions = {
  tokenBudget: 30_000,
  maxFileBytes: 200_000,
  minTruncateTokens: 200,
};

export interface RawFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'B';
  additions: number;
  deletions: number;
  patch: string | null;
  filteredReason?: FilteredReason | null;
}

export interface RawChange {
  repoName: string;
  title: string;
  message: string;
  files: RawFile[];
}

export interface PreparedInput {
  input: ExplanationInput;
  inputHash: string;
  /** Paths whose patch was cut to fit the budget (still sent, partially). */
  truncated: string[];
}

const LOCKFILES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'gemfile.lock', 'poetry.lock', 'pipfile.lock', 'composer.lock', 'go.sum',
  'packages.lock.json', 'pubspec.lock', 'podfile.lock', 'flake.lock', 'uv.lock', 'gradle.lockfile',
]);

const GENERATED_PATH =
  /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|coverage|__pycache__|\.next|\.yarn)\/|\.min\.(?:js|css)$|\.map$|\.(?:pb\.go|pb\.cc|pb\.h|_pb2\.py|g\.dart|designer\.cs)$|\.snap$/;

const GENERATED_MARKER = /@generated|DO NOT EDIT|Code generated .* by |auto-?generated/i;

export function filterReason(f: RawFile): FilteredReason | null {
  if (f.filteredReason) return f.filteredReason;
  if (f.status === 'B' || f.patch === null || /^Binary files .* differ$/m.test(f.patch)) return 'binary';
  const base = f.path.split('/').pop()!.toLowerCase();
  if (LOCKFILES.has(base)) return 'lockfile';
  if (GENERATED_PATH.test(f.path)) return 'generated';
  // Marker only counts in the first lines of the diff body (file header comments).
  const head = f.patch.split('\n').slice(0, 40).join('\n');
  if (GENERATED_MARKER.test(head)) return 'generated';
  return null;
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function truncateToTokens(patch: string, tokens: number): string {
  const marker = '\n[... truncated to fit token budget ...]\n';
  const maxChars = Math.max(0, tokens * 4 - marker.length);
  let cut = patch.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl);
  return cut + marker;
}

/**
 * Filter, redact and budget a change. Deterministic: files are admitted smallest
 * first (ties by path); the first file that does not fit is truncated to the
 * remaining budget and every later (larger) file is dropped as `too_large`.
 * Output keeps the original file order.
 */
export function prepareInput(
  raw: RawChange,
  options: Partial<PrepareOptions> = {},
): PreparedInput {
  const opt = { ...DEFAULT_PREPARE_OPTIONS, ...options };
  const out: ProviderFile[] = raw.files.map((f) => ({
    path: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: null,
    filteredReason: null,
  }));
  const candidates: { idx: number; patch: string }[] = [];

  raw.files.forEach((f, idx) => {
    const reason = filterReason(f);
    if (reason) {
      out[idx]!.filteredReason = reason;
    } else if (Buffer.byteLength(f.patch!, 'utf8') > opt.maxFileBytes) {
      out[idx]!.filteredReason = 'too_large';
    } else {
      candidates.push({ idx, patch: redact(f.patch!) });
    }
  });

  // Plain code-unit order for ties: localeCompare depends on the ICU locale and would make the hash host-dependent.
  const pathOf = (c: { idx: number }) => raw.files[c.idx]!.path;
  candidates.sort((a, b) => a.patch.length - b.patch.length || (pathOf(a) < pathOf(b) ? -1 : pathOf(a) > pathOf(b) ? 1 : 0));

  let remaining = opt.tokenBudget;
  let exhausted = false;
  const truncated: string[] = [];
  for (const c of candidates) {
    const f = out[c.idx]!;
    const cost = estimateTokens(c.patch);
    if (!exhausted && cost <= remaining) {
      f.patch = c.patch;
      remaining -= cost;
    } else if (!exhausted && remaining >= opt.minTruncateTokens) {
      f.patch = truncateToTokens(c.patch, remaining);
      truncated.push(f.path);
      remaining = 0;
      exhausted = true;
    } else {
      exhausted = true;
      f.filteredReason = 'too_large';
    }
  }

  const input: ExplanationInput = {
    repoName: raw.repoName,
    title: redact(raw.title),
    message: redact(raw.message),
    files: out,
  };
  const inputHash = createHash('sha256')
    .update(JSON.stringify({ v: PREP_VERSION, input }))
    .digest('hex');
  return { input, inputHash, truncated };
}
