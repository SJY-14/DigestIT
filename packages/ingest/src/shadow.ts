import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SkipReason } from '@digestit/core';
import { DIFF_FLAGS, combineDiffTree, nul, parseDiffRaw, type GitFile } from './git.js';

const execFileAsync = promisify(execFile);

/** The sha of an empty tree (`git hash-object -t tree /dev/null`); stands in for "no parent". */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** Patterns never stored in the shadow, regardless of the project's own `.gitignore`. */
export const DEFAULT_DENYLIST = [
  '.env*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '*.p12', '*.pfx',
  'credentials*', '.npmrc', '.netrc',
  'node_modules/', 'dist/', 'build/', '.venv/', 'target/', '__pycache__/',
];

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

type DenylistMatcher = { dir: string } | { file: RegExp };
const DENYLIST_MATCHERS: DenylistMatcher[] = DEFAULT_DENYLIST.map((p) =>
  p.endsWith('/') ? { dir: p.slice(0, -1) } : { file: globToRegExp(p) },
);

/** Matches a project-relative, `/`-separated path against the default denylist. */
export function matchesDenylist(relPath: string): boolean {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1]!;
  for (const m of DENYLIST_MATCHERS) {
    if ('dir' in m) { if (segments.slice(0, -1).includes(m.dir)) return true; }
    else if (m.file.test(base)) return true;
  }
  return false;
}

export interface Shadow {
  dataDir: string;
  gitDir: string;
  projectRoot: string;
  indexFile: string;
  maxFileBytes: number;
}

export interface ShadowOptions {
  maxFileBytes?: number;
}

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface SnapshotResult {
  treeSha: string;
  skipped: SkippedFile[];
  unchanged: boolean;
}

export interface PendingResult {
  files: number;
  additions: number;
  deletions: number;
}

export interface UserGitInfo {
  head: string | null;
  branch: string | null;
}

const baseEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
});

/** Runs git for the shadow's own store: `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` always set. */
async function runGit(shadow: Shadow, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.quotepath=off', ...args],
    {
      cwd: shadow.projectRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 1024,
      env: {
        ...baseEnv(),
        GIT_DIR: shadow.gitDir,
        GIT_WORK_TREE: shadow.projectRoot,
        GIT_INDEX_FILE: shadow.indexFile,
      },
    },
  );
  return stdout;
}

/** Runs git against the shadow's `GIT_DIR` only, before a work tree/index makes sense (init). */
async function runGitBare(gitDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...baseEnv(), GIT_DIR: gitDir },
  });
  return stdout;
}

const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; } catch { return false; }
};

/** Creates or opens `<dataDir>/shadow.git`, its index and its denylist `info/exclude`. */
export async function openShadow(dataDir: string, projectRoot: string, opts: ShadowOptions = {}): Promise<Shadow> {
  const gitDir = join(dataDir, 'shadow.git');
  const indexFile = join(dataDir, 'shadow.index');
  const hooksDir = join(dataDir, 'shadow-hooks');
  await mkdir(dataDir, { recursive: true });
  await mkdir(hooksDir, { recursive: true });

  if (!(await exists(join(gitDir, 'HEAD')))) {
    await runGitBare(gitDir, ['init', '--bare', '-q']);
  }
  await runGitBare(gitDir, ['config', 'core.hooksPath', hooksDir]);
  await runGitBare(gitDir, ['config', 'core.fsmonitor', 'false']);
  await writeFile(join(gitDir, 'info', 'exclude'), DEFAULT_DENYLIST.join('\n') + '\n');

  return { dataDir, gitDir, projectRoot, indexFile, maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES };
}

async function writeTmpPathList(shadow: Shadow, paths: readonly string[]): Promise<string> {
  const dir = join(shadow.dataDir, 'tmp');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `pathspec-${randomUUID()}`);
  await writeFile(file, paths.length ? paths.join('\0') + '\0' : '');
  return file;
}

async function addPaths(shadow: Shadow, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const listFile = await writeTmpPathList(shadow, paths);
  try {
    await runGit(shadow, ['add', '--pathspec-from-file', listFile, '--pathspec-file-nul']);
  } finally {
    await rm(listFile, { force: true });
  }
}

async function removePaths(shadow: Shadow, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const listFile = await writeTmpPathList(shadow, paths);
  try {
    await runGit(shadow, [
      'rm', '-q', '--cached', '--ignore-unmatch', '-r',
      '--pathspec-from-file', listFile, '--pathspec-file-nul',
    ]);
  } finally {
    await rm(listFile, { force: true });
  }
}

/** True for a path git reports as a directory boundary (a nested repo it did not descend into). */
const isDirBoundary = (path: string): boolean => path.endsWith('/');

interface Categorized {
  /** Every untracked path, `.gitignore` and the denylist both ignored (for denylist reporting). */
  rawOthers: string[];
  /** Untracked, respecting the project's own `.gitignore` (and, redundantly, the denylist). */
  keptOthers: string[];
  modified: string[];
  deleted: string[];
}

async function listCategorized(shadow: Shadow): Promise<Categorized> {
  const [rawOut, keptOut, modifiedOut, deletedOut] = await Promise.all([
    runGit(shadow, ['ls-files', '-z', '--others']),
    runGit(shadow, ['ls-files', '-z', '--others', '--exclude-standard']),
    runGit(shadow, ['ls-files', '-z', '--modified']),
    runGit(shadow, ['ls-files', '-z', '--deleted']),
  ]);
  const noDotGit = (paths: string[]) => paths.filter((p) => !p.split('/').includes('.git'));
  return {
    rawOthers: noDotGit(nul(rawOut)),
    keptOthers: noDotGit(nul(keptOut)),
    modified: noDotGit(nul(modifiedOut)),
    deleted: noDotGit(nul(deletedOut)),
  };
}

interface ChangeSet {
  toAdd: string[];
  toDelete: string[];
  skipped: SkippedFile[];
}

/**
 * Applies the denylist and size cap to the candidates found by {@link listCategorized}.
 * `rawOthers` (not `keptOthers`) is walked for untracked files: `keptOthers` already had the
 * denylist silently subtracted via `info/exclude`, so it can't tell a denylisted file from one
 * dropped by the project's own `.gitignore` — the former must be named in `skipped`, the latter not.
 */
async function computeChanges(shadow: Shadow): Promise<ChangeSet> {
  const { rawOthers, keptOthers, modified, deleted } = await listCategorized(shadow);
  const kept = new Set(keptOthers);
  const toAdd: string[] = [];
  const toDelete: string[] = [...deleted];
  const skipped: SkippedFile[] = [];

  const checkOne = async (path: string, tracked: boolean): Promise<void> => {
    if (isDirBoundary(path)) { skipped.push({ path: path.slice(0, -1), reason: 'nested_repo' }); return; }
    if (matchesDenylist(path)) {
      skipped.push({ path, reason: 'denylist' });
      if (tracked) toDelete.push(path);
      return;
    }
    if (!tracked && !kept.has(path)) return; // dropped by the project's own .gitignore; not reported
    const abs = join(shadow.projectRoot, path);
    let stat;
    try {
      stat = await lstat(abs);
      if (stat.isFile()) await access(abs, fsConstants.R_OK);
    } catch {
      skipped.push({ path, reason: 'unreadable' });
      if (tracked) toDelete.push(path);
      return;
    }
    if (stat.isFile() && stat.size > shadow.maxFileBytes) {
      skipped.push({ path, reason: 'too_large' });
      if (tracked) toDelete.push(path);
      return;
    }
    toAdd.push(path);
  };

  await Promise.all([
    ...rawOthers.map((p) => checkOne(p, false)),
    ...modified.map((p) => checkOne(p, true)),
  ]);
  return { toAdd, toDelete, skipped };
}

async function nextSeq(shadow: Shadow): Promise<number> {
  const out = await runGit(shadow, ['for-each-ref', '--format=%(refname)', 'refs/digestit/cp']);
  const seqs = out.split('\n').filter(Boolean).map((r) => Number(r.split('/').pop()));
  return seqs.length ? Math.max(...seqs) + 1 : 1;
}

/**
 * Snapshots the current work tree (tracked, untracked and deleted files, minus the denylist and
 * oversized files) as a tree object. `parent` is the previous checkpoint's tree sha, if any.
 */
export async function snapshot(shadow: Shadow, opts: { parent?: string } = {}): Promise<SnapshotResult> {
  const parentTree = opts.parent ?? EMPTY_TREE_SHA;
  await runGit(shadow, ['read-tree', opts.parent ? opts.parent : '--empty']);

  const { toAdd, toDelete, skipped } = await computeChanges(shadow);
  await addPaths(shadow, toAdd);
  await removePaths(shadow, toDelete);

  const treeSha = (await runGit(shadow, ['write-tree'])).trim();
  if (treeSha === parentTree) {
    return { treeSha, skipped, unchanged: true };
  }

  const seq = await nextSeq(shadow);
  await runGit(shadow, ['update-ref', `refs/digestit/cp/${seq}`, treeSha]);
  await runGit(shadow, ['gc', '--auto', '-q']);
  return { treeSha, skipped, unchanged: false };
}

/** Files changed between two checkpoint trees, parsed the same way as a commit diff. */
export async function diff(shadow: Shadow, fromSha: string, toSha: string): Promise<GitFile[]> {
  const target = [fromSha, toSha];
  const entries = parseDiffRaw(await runGit(shadow, ['diff-tree', ...DIFF_FLAGS, '--raw', '-z', ...target]));
  if (entries.length === 0) return [];
  const numstatText = await runGit(shadow, ['diff-tree', ...DIFF_FLAGS, '--numstat', '-z', ...target]);
  const patchText = await runGit(shadow, ['diff-tree', ...DIFF_FLAGS, '-p', ...target]);
  return combineDiffTree(entries, numstatText, patchText, `${fromSha}..${toSha}`);
}

/** Every path in a checkpoint tree (`ls-tree -r`), for the project graph. */
export async function listTree(shadow: Shadow, treeSha: string): Promise<string[]> {
  return nul(await runGit(shadow, ['ls-tree', '-r', '-z', '--name-only', treeSha]));
}

const parseNumstatCounts = (text: string): { add: number; del: number }[] =>
  nul(text).map((line) => {
    const m = /^(-|\d+)\t(-|\d+)\t/.exec(line);
    if (!m) return { add: 0, del: 0 };
    return m[1] === '-' ? { add: 0, del: 0 } : { add: Number(m[1]), del: Number(m[2]) };
  });

async function countAddedLines(absPath: string, maxBytes: number): Promise<number> {
  let buf;
  try {
    buf = await readFile(absPath);
  } catch {
    return 0;
  }
  if (buf.byteLength > maxBytes || buf.subarray(0, 8000).includes(0)) return 0; // oversized or binary
  if (buf.byteLength === 0) return 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/** Cheap "what changed since `lastSha`" count. Read-only: never touches the store or the index. */
export async function pending(shadow: Shadow, lastSha: string): Promise<PendingResult> {
  const { keptOthers, modified, deleted } = await listCategorized(shadow);
  const keep = (paths: string[]) => paths.filter((p) => !isDirBoundary(p) && !matchesDenylist(p));
  const keptUntracked = keep(keptOthers);
  const keptModified = keep(modified);
  const keptDeleted = keep(deleted);

  let additions = 0, deletions = 0;
  const trackedPaths = [...keptModified, ...keptDeleted];
  if (trackedPaths.length > 0) {
    // `git diff` has no `--pathspec-from-file`; pass paths positionally after `--`.
    const numstatText = await runGit(shadow, [
      'diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', lastSha, '--', ...trackedPaths,
    ]);
    for (const { add, del } of parseNumstatCounts(numstatText)) { additions += add; deletions += del; }
  }
  for (const p of keptUntracked) {
    additions += await countAddedLines(join(shadow.projectRoot, p), shadow.maxFileBytes);
  }

  return { files: keptUntracked.length + keptModified.length + keptDeleted.length, additions, deletions };
}

const execTrim = async (args: readonly string[], cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/** Read-only info from the project's own git repo, if it has one. Never writes. */
export async function userGitInfo(projectRoot: string): Promise<UserGitInfo | null> {
  const gitDir = await execTrim(['rev-parse', '--git-dir'], projectRoot);
  if (gitDir === null) return null;
  const head = await execTrim(['rev-parse', '--verify', '-q', 'HEAD'], projectRoot);
  const branch = await execTrim(['symbolic-ref', '--short', '-q', 'HEAD'], projectRoot);
  return { head, branch };
}
