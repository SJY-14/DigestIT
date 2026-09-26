import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangeStatus } from '@digestit/core';

const execFileAsync = promisify(execFile);

/** Runs git with an argument array (never a shell) inside `repoPath`. */
export async function git(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoPath, '-c', 'core.quotepath=off', ...args],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
    },
  );
  return stdout;
}

export interface GitCommit {
  sha: string;
  parents: string[];
  authorName: string;
  authoredAt: string;
  committedAt: string;
  message: string;
}

export interface GitFile {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  patch: string | null;
}

const SEP = '\x1f';

export async function listBranches(repo: string): Promise<{ name: string; sha: string }[]> {
  const out = await git(repo, ['for-each-ref', `--format=%(refname:short)${SEP}%(objectname)`, 'refs/heads']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, sha] = l.split(SEP);
      return { name: name!, sha: sha! };
    });
}

/** Commit shas reachable from `branch`, parents before children. */
export async function revList(repo: string, args: readonly string[]): Promise<string[]> {
  const out = await git(repo, ['rev-list', '--topo-order', '--reverse', ...args]);
  return out.split('\n').filter(Boolean);
}

export async function headSha(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
  } catch {
    return null; // unborn branch
  }
}

export async function readCommit(repo: string, sha: string): Promise<GitCommit> {
  const out = await git(repo, [
    'show', '-s', '--no-show-signature',
    `--format=%P${SEP}%an${SEP}%aI${SEP}%cI${SEP}%B`, sha,
  ]);
  const [parents, authorName, authoredAt, committedAt, ...rest] = out.split(SEP);
  return {
    sha,
    parents: parents!.split(' ').filter(Boolean),
    authorName: authorName!,
    authoredAt: authoredAt!,
    committedAt: committedAt!,
    message: rest.join(SEP).replace(/\s+$/, ''),
  };
}

const STATUS_MAP: Record<string, ChangeStatus> = { A: 'A', M: 'M', D: 'D', R: 'R', T: 'M', C: 'A' };

/** Splits `-z` output into NUL-separated fields. */
export const nul = (s: string): string[] => {
  const parts = s.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
};

export const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M', '-r'] as const;

export interface DiffRawEntry {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  typeChange: boolean;
}

/** Parses `diff-tree --raw -z` (or `diff --raw -z`) output. */
export function parseDiffRaw(rawText: string): DiffRawEntry[] {
  const raw = nul(rawText);
  const entries: DiffRawEntry[] = [];
  for (let i = 0; i < raw.length; ) {
    // Root form without a parent prints the commit id first.
    if (!raw[i]!.startsWith(':')) { i++; continue; }
    const code = raw[i]!.split(' ').at(-1)![0]!;
    const status = STATUS_MAP[code] ?? 'M';
    if (code === 'R' || code === 'C') {
      entries.push({ oldPath: code === 'R' ? raw[i + 1]! : null, path: raw[i + 2]!, status, typeChange: false });
      i += 3;
    } else {
      entries.push({ oldPath: null, path: raw[i + 1]!, status, typeChange: code === 'T' });
      i += 2;
    }
  }
  return entries;
}

/**
 * Combines raw entries with `--numstat -z` output and a `-p` patch stream (as split by
 * `splitPatch`) into `GitFile[]`. `label` is only used in the mismatch error message.
 */
export function combineDiffTree(
  entries: DiffRawEntry[],
  numstatText: string,
  patchText: string,
  label: string,
): GitFile[] {
  const numstat = nul(numstatText);
  const counts = new Map<string, { add: number; del: number; binary: boolean }>();
  for (let i = 0; i < numstat.length; ) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(numstat[i]!);
    if (!m) { i++; continue; }
    const binary = m[1] === '-';
    const entry = { add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary };
    if (m[3] === '') { // rename: "a\td\t\0old\0new\0"
      counts.set(numstat[i + 2]!, entry);
      i += 3;
    } else {
      counts.set(m[3]!, entry);
      i++;
    }
  }

  const patches = splitPatch(patchText);
  // A type change (file <-> symlink) is printed as a delete section plus an add section.
  const expected = entries.reduce((n, e) => n + (e.typeChange ? 2 : 1), 0);
  if (patches.length !== expected) {
    throw new Error(`patch/file count mismatch for ${label}: ${patches.length} vs ${expected}`);
  }

  let p = 0;
  return entries.map((e) => {
    const c = counts.get(e.path) ?? { add: 0, del: 0, binary: false };
    const patch = e.typeChange ? patches[p]! + patches[p + 1]! : patches[p]!;
    p += e.typeChange ? 2 : 1;
    return {
      path: e.path,
      oldPath: e.oldPath,
      status: c.binary ? 'B' : e.status,
      additions: c.add,
      deletions: c.del,
      patch: c.binary ? null : patch,
    };
  });
}

/**
 * Files changed by `sha` against its first parent (or the empty tree for a
 * root commit), with numstat and one patch per file. Merges therefore show
 * what the merge brought in relative to the branch it landed on.
 */
export async function readFiles(repo: string, sha: string, firstParent: string | null): Promise<GitFile[]> {
  const target = firstParent ? [firstParent, sha] : ['--root', sha];

  const entries = parseDiffRaw(await git(repo, ['diff-tree', ...DIFF_FLAGS, '--raw', '-z', ...target]));
  if (entries.length === 0) return [];

  const numstatText = await git(repo, ['diff-tree', ...DIFF_FLAGS, '--numstat', '-z', ...target]);
  const patchText = await git(repo, ['diff-tree', ...DIFF_FLAGS, '-p', ...target]);
  return combineDiffTree(entries, numstatText, patchText, sha);
}

/** Content lines always start with ' ', '+', '-', '@' or '\', so a "diff --git " line is a file boundary. */
export function splitPatch(text: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur) out.push(cur.join('\n'));
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) out.push(cur.join('\n').replace(/\n+$/, '\n'));
  return out;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
}

/** Parses `git worktree list --porcelain` (blank-line separated records). */
export function parseWorktrees(text: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of text.split('\n\n')) {
    const wt: Worktree = { path: '', head: null, branch: null, bare: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt.path = line.slice(9);
      else if (line.startsWith('HEAD ')) wt.head = /^0+$/.test(line.slice(5)) ? null : line.slice(5);
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'bare') wt.bare = true;
    }
    if (wt.path) out.push(wt);
  }
  return out;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  return parseWorktrees(await git(repo, ['worktree', 'list', '--porcelain']));
}

/** Every ref and its object id, sorted by ref name by git. */
export async function listRefs(repo: string): Promise<string> {
  return git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
}

export interface DirtyStat { files: number; additions: number; deletions: number; untracked: number }

/** Uncommitted changes in a worktree: tracked diff vs HEAD (numstat) plus a count of untracked files. */
export async function dirtyStat(worktree: string): Promise<DirtyStat> {
  let files = 0, additions = 0, deletions = 0;
  try {
    for (const rec of nul(await git(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', 'HEAD']))) {
      const m = /^(-|\d+)\t(-|\d+)\t/.exec(rec);
      if (!m) continue; // rename path fields
      files++;
      if (m[1] !== '-') { additions += Number(m[1]); deletions += Number(m[2]); }
    }
  } catch { /* unborn HEAD: only untracked files below */ }
  const untracked = nul(await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).length;
  return { files: files + untracked, additions, deletions, untracked };
}
