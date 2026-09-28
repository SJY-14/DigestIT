// Per-project ignore patterns (DIG-56): gitignore-syntax patterns stored in DigestIT's own data
// dir, never in the project. Configured as the shadow repo's `core.excludesFile` (shadow.ts), so
// an output directory with, say, 100k files is skipped by git itself at listing time (it never
// descends into it), not walked file by file here.
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where a project's own ignore patterns live, relative to its `projectDataDir`. */
export function ignoreFilePath(dataDir: string): string {
  return join(dataDir, 'ignore');
}

const HEADER = '# DigestIT project ignore patterns (gitignore syntax). Never written into the project.\n';

function parsePatternLines(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const p = line.trim();
    if (!p || p.startsWith('#') || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** This project's own patterns, in file order, deduplicated; `[]` if none were ever set. */
export function readIgnorePatterns(dataDir: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(ignoreFilePath(dataDir), 'utf8');
  } catch {
    return [];
  }
  return parsePatternLines(raw);
}

async function writePatterns(dataDir: string, patterns: readonly string[]): Promise<string[]> {
  await mkdir(dataDir, { recursive: true });
  const path = ignoreFilePath(dataDir);
  const body = patterns.length ? patterns.join('\n') + '\n' : '';
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, HEADER + body);
  await rename(tmp, path);
  return [...patterns];
}

/** Longest pattern accepted; a real gitignore line is far shorter. */
export const MAX_IGNORE_PATTERN_LENGTH = 512;

/** One gitignore line: non-blank, bounded, and free of control characters (a newline would
 * otherwise smuggle extra lines into the ignore file). */
export function isValidIgnorePattern(raw: string): boolean {
  const p = raw.trim();
  return p.length > 0 && p.length <= MAX_IGNORE_PATTERN_LENGTH && !/[\u0000-\u001f\u007f]/.test(p);
}

/** Appends patterns not already present (comments/blank lines dropped, order preserved). Returns the resulting list. */
export async function addIgnorePatterns(dataDir: string, patterns: readonly string[]): Promise<string[]> {
  const bad = patterns.find((p) => p.trim() && !p.trim().startsWith('#') && !isValidIgnorePattern(p));
  if (bad !== undefined) throw new Error(`invalid ignore pattern: ${JSON.stringify(bad.slice(0, 80))}`);
  const next = readIgnorePatterns(dataDir);
  const seen = new Set(next);
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p || p.startsWith('#') || seen.has(p)) continue;
    seen.add(p);
    next.push(p);
  }
  return writePatterns(dataDir, next);
}

/** Removes patterns by exact text match. Returns the resulting list. */
export async function removeIgnorePatterns(dataDir: string, patterns: readonly string[]): Promise<string[]> {
  const toRemove = new Set(patterns.map((p) => p.trim()));
  const next = readIgnorePatterns(dataDir).filter((p) => !toRemove.has(p));
  return writePatterns(dataDir, next);
}

// --- pragmatic gitignore-subset matcher (mirrors shadow.ts's DEFAULT_DENYLIST matcher) ----------

function escapeRegExpChar(c: string): string {
  return /[.+^${}()|\\]/.test(c) ? `\\${c}` : c;
}

/** `*` -> any run of chars, `?` -> one char, `[...]` character classes pass through verbatim.
 * No `**`, no `\`-escapes: a deliberately small subset, same ambition as the built-in denylist. */
function patternToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') { out += '.*'; continue; }
    if (c === '?') { out += '.'; continue; }
    if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end !== -1) { out += pattern.slice(i, end + 1); i = end; continue; }
    }
    out += escapeRegExpChar(c);
  }
  return new RegExp(`^${out}$`);
}

export interface CompiledIgnorePattern {
  raw: string;
  /** Trailing-slash pattern: matches a directory (and anything under it), not a single file. */
  dir: boolean;
  /** Contains a `/` (besides a trailing one) or a leading `/`: matches the full relative path, not just the basename anywhere. */
  anchored: boolean;
  regex: RegExp;
}

export function compileIgnorePatterns(patterns: readonly string[]): CompiledIgnorePattern[] {
  return patterns.map((raw) => {
    let pattern = raw;
    const dir = pattern.endsWith('/');
    if (dir) pattern = pattern.slice(0, -1);
    const leadingSlash = pattern.startsWith('/');
    if (leadingSlash) pattern = pattern.slice(1);
    const anchored = leadingSlash || pattern.includes('/');
    return { raw, dir, anchored, regex: patternToRegExp(pattern) };
  });
}

/**
 * Matches a project-relative, `/`-separated path — optionally a trailing-slash directory boundary,
 * as `git ls-files --directory` reports it — against compiled project-ignore patterns. An
 * unanchored pattern matches that name at any depth (same rule as `matchesDenylist` in shadow.ts);
 * an anchored one (containing an internal or leading `/`) matches the full relative path.
 */
export function matchesIgnorePatterns(compiled: readonly CompiledIgnorePattern[], relPath: string): boolean {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1]!; // '' for a trailing-slash directory boundary
  const full = relPath.endsWith('/') ? relPath.slice(0, -1) : relPath;
  const fullSegments = full.split('/');
  for (const p of compiled) {
    if (p.anchored) {
      if (p.regex.test(full)) return true;
      if (p.dir && fullSegments.some((_, idx) => p.regex.test(fullSegments.slice(0, idx + 1).join('/')))) return true;
    } else if (p.dir) {
      if (segments.slice(0, -1).some((seg) => p.regex.test(seg))) return true;
    } else if (p.regex.test(base)) return true;
  }
  return false;
}

// --- suggestions on init of a folder without its own .gitignore ---------------------------------

export interface IgnoreSuggestion {
  pattern: string;
  reason: string;
}

/** A directory at/beyond this many of its *own* entries is suggested outright, no matter what's in it. */
const LARGE_DIR_ENTRY_THRESHOLD = 1000;
/** Sampled to decide "mostly large files": first N files, average size at/beyond this counts. */
const LARGE_FILE_SAMPLE = 20;
const LARGE_FILE_SAMPLE_MIN_AVG_BYTES = 1024 * 1024;
/** Filenames scanned per subdirectory when it isn't already large, so a pathological tree can't blow up the cost. */
const SHALLOW_SCAN_CAP = 2000;
const JOB_LOG_RE = /\.[oe]\d+$/;

async function mostlyLargeFiles(dir: string, entries: readonly Dirent[]): Promise<boolean> {
  const files = entries.filter((e) => e.isFile()).slice(0, LARGE_FILE_SAMPLE);
  if (files.length === 0) return false;
  let total = 0;
  for (const f of files) {
    try {
      total += (await stat(join(dir, f.name))).size;
    } catch {
      /* raced away between readdir and stat */
    }
  }
  return total / files.length >= LARGE_FILE_SAMPLE_MIN_AVG_BYTES;
}

/**
 * On `init` of a folder with no `.gitignore` of its own, suggests gitignore-syntax patterns for
 * likely generated-output areas: a top-level directory with (at or beyond) a few thousand entries
 * of its own or mostly large files, scheduler job logs (`*.o<N>`/`*.e<N>`), `__pycache__`, and
 * `*.log` files. Looks at the top two levels only, and counting a directory's own entries is one
 * `readdir` — not a recursive walk — so a 100k-file output directory costs about the same as an
 * empty one. Never applied: callers only ever show these as suggestions.
 */
export async function suggestIgnorePatterns(projectRoot: string): Promise<IgnoreSuggestion[]> {
  let topEntries: Dirent[];
  try {
    topEntries = await readdir(projectRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const suggestions: IgnoreSuggestion[] = [];
  const dirNames: string[] = [];
  let jobLogCount = 0;
  let logFileCount = 0;
  let sawPycache = false;

  for (const entry of topEntries) {
    if (entry.name === '.git') continue;
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') { sawPycache = true; continue; }
      dirNames.push(entry.name);
    } else if (entry.isFile()) {
      if (JOB_LOG_RE.test(entry.name)) jobLogCount++;
      else if (entry.name.endsWith('.log')) logFileCount++;
    }
  }

  for (const name of dirNames) {
    const dir = join(projectRoot, name);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.length >= LARGE_DIR_ENTRY_THRESHOLD) {
      suggestions.push({ pattern: `${name}/`, reason: `${entries.length.toLocaleString('en-US')} entries` });
      continue;
    }
    for (const e of entries.slice(0, SHALLOW_SCAN_CAP)) {
      if (e.name === '__pycache__' && e.isDirectory()) sawPycache = true;
      else if (e.isFile() && JOB_LOG_RE.test(e.name)) jobLogCount++;
      else if (e.isFile() && e.name.endsWith('.log')) logFileCount++;
    }
    if (await mostlyLargeFiles(dir, entries)) suggestions.push({ pattern: `${name}/`, reason: 'mostly large files' });
  }

  if (jobLogCount > 0) {
    suggestions.push({ pattern: '*.o[0-9]*', reason: 'scheduler job logs (*.o<N>)' });
    suggestions.push({ pattern: '*.e[0-9]*', reason: 'scheduler job logs (*.e<N>)' });
  }
  if (logFileCount > 0) suggestions.push({ pattern: '*.log', reason: 'log files' });
  if (sawPycache) suggestions.push({ pattern: '__pycache__/', reason: 'Python bytecode cache' });

  return suggestions;
}

export function hasOwnGitignore(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.gitignore'));
}
