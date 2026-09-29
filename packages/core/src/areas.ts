// Fast Explain (DIG-75, docs/explain-speed.md §4): deterministic L2 areas, computed from the
// changed files alone, no LLM call. Stored in `digest.areas` when the digest row is created, so an
// existing digest's grouping never changes when these rules do.
import type { DigestAreaSkeleton } from './v2.js';

export interface GroupableFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface GroupDigestAreasOptions {
  /** Package-root prefixes of a pnpm workspace (`apps`, `packages`, ...), as derived from
   * `pnpm-workspace.yaml` by the caller (`apps/server/src/areas.ts`'s `loadWorkspacePrefixes`).
   * A repo with no workspace file passes `[]`. */
  workspacePrefixes?: readonly string[];
  /** At most this many areas; smaller groups are merged into their parent directory first. */
  maxAreas?: number;
}

const DEFAULT_MAX_AREAS = 8;
const ROOT_KEY = '.';
const ROOT_LABEL = 'project root';

const TEST_SUFFIX = /^(.*)\.(?:test|spec)\.([A-Za-z0-9]+)$/;
const TEST_PREFIX = /^test_(.+)$/;

/**
 * The file this test file is testing, when the name says so: `x.test.ts` -> `x.ts`, `test_x.py` ->
 * `x.py`, `dir/__tests__/x.ts` -> `dir/x.ts`. Returns `null` for a file that is not named like a test.
 */
function subjectOf(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash);
  const base = slash === -1 ? path : path.slice(slash + 1);

  const suffix = TEST_SUFFIX.exec(base);
  if (suffix) return dir === '' ? `${suffix[1]}.${suffix[2]}` : `${dir}/${suffix[1]}.${suffix[2]}`;

  const prefix = TEST_PREFIX.exec(base);
  if (prefix) return dir === '' ? prefix[1]! : `${dir}/${prefix[1]}`;

  const segments = path.split('/');
  const testsAt = segments.indexOf('__tests__');
  if (testsAt !== -1 && testsAt < segments.length - 1) {
    return [...segments.slice(0, testsAt), ...segments.slice(testsAt + 1)].join('/');
  }
  return null;
}

/** Full directory of a path, or `.` for a top-level file (repo root). */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? ROOT_KEY : path.slice(0, slash);
}

/**
 * Buckets one file's directory into a group key, without walking further up: a file under a
 * recognised workspace package (`apps/web/...`) buckets at the package root (`apps/web`) when it
 * sits deeper than that, or the package root itself when it does not; anything else buckets by its
 * own full directory (or `.` at the repo root).
 */
function bucketOf(path: string, prefixes: readonly string[]): string {
  const segments = path.split('/');
  if (segments.length === 1) return ROOT_KEY;
  const top = segments[0]!;
  if (prefixes.includes(top) && segments.length >= 2) {
    return segments.length > 2 ? `${top}/${segments[1]}` : dirOf(path);
  }
  return dirOf(path);
}

function parentOf(key: string): string {
  if (key === ROOT_KEY) return ROOT_KEY;
  const slash = key.lastIndexOf('/');
  return slash === -1 ? ROOT_KEY : key.slice(0, slash);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface Group {
  key: string;
  paths: string[];
  additions: number;
  deletions: number;
}

/**
 * Partitions a digest's changed files into 1-`maxAreas` `DigestAreaSkeleton`s, deterministically
 * and without an LLM call (docs/explain-speed.md §4). A test file joins its subject's group when the
 * subject is also among `files`. Groups are then merged into their parent directory, smallest
 * (fewest files) first, until at most `maxAreas` remain; top-level files always form one "project
 * root" group. Every file in `files` (analysed or not) ends up in exactly one area.
 */
export function groupDigestAreas(files: readonly GroupableFile[], opts: GroupDigestAreasOptions = {}): DigestAreaSkeleton[] {
  if (files.length === 0) return [];
  const prefixes = opts.workspacePrefixes ?? [];
  const maxAreas = opts.maxAreas ?? DEFAULT_MAX_AREAS;

  const subjectPaths = new Set(files.map((f) => f.path));
  const groups = new Map<string, Group>();
  for (const f of files) {
    const subject = subjectOf(f.path);
    const bucketPath = subject && subjectPaths.has(subject) ? subject : f.path;
    const key = bucketOf(bucketPath, prefixes);
    const g = groups.get(key) ?? { key, paths: [], additions: 0, deletions: 0 };
    g.paths.push(f.path);
    g.additions += f.additions;
    g.deletions += f.deletions;
    groups.set(key, g);
  }

  // Merge smallest (fewest files, then fewest changed lines, then key) into its parent directory
  // until at most maxAreas remain. The root group ('.') never merges further up.
  while (groups.size > maxAreas) {
    const mergeable = [...groups.values()].filter((g) => g.key !== ROOT_KEY);
    const target = mergeable.length > 0 ? mergeable : [...groups.values()];
    target.sort((a, b) =>
      a.paths.length - b.paths.length || (a.additions + a.deletions) - (b.additions + b.deletions) || a.key.localeCompare(b.key),
    );
    const smallest = target[0];
    if (!smallest || smallest.key === ROOT_KEY) break; // only the root group left: nothing more to merge
    const parentKey = parentOf(smallest.key);
    groups.delete(smallest.key);
    const parent = groups.get(parentKey) ?? { key: parentKey, paths: [], additions: 0, deletions: 0 };
    parent.paths.push(...smallest.paths);
    parent.additions += smallest.additions;
    parent.deletions += smallest.deletions;
    groups.set(parentKey, parent);
  }

  const ordered = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  const seenIds = new Set<string>();
  return ordered.map((g) => {
    const label = g.key === ROOT_KEY ? ROOT_LABEL : g.key;
    let id = slugify(label) || 'area';
    if (seenIds.has(id)) {
      let n = 2;
      while (seenIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    seenIds.add(id);
    return { id, label, paths: [...g.paths].sort(), additions: g.additions, deletions: g.deletions };
  });
}
