import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// T4-b (docs/milestone-3.md): "area" is a workspace-aware prefix. It needs no configuration and
// works for any repo, not just this one: a pnpm-workspace.yaml (if present) names the package
// roots (`apps/*`, `packages/*`); anything else buckets to its top-level directory.

const GLOB_LINE = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/;
const PACKAGES_KEY = /^packages\s*:\s*$/;

/**
 * Package-root prefixes from a pnpm-workspace.yaml's `packages:` list, e.g. `apps/*` and
 * `packages/*` both yield `apps` / `packages`. Only single-level globs (`dir/*`) are recognised;
 * other patterns (exact paths, `**`, negations) are ignored rather than mis-bucketed.
 */
export function parseWorkspacePrefixes(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const prefixes: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (PACKAGES_KEY.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const m = GLOB_LINE.exec(line);
    if (!m) break; // list ended (next key or blank/other content)
    const pattern = m[1]!.trim();
    const star = /^([^*]+)\/\*$/.exec(pattern);
    if (star) prefixes.push(star[1]!.replace(/\/+$/, ''));
  }
  return prefixes;
}

/** Reads `<repoPath>/pnpm-workspace.yaml`; returns `[]` when the repo has none (not a pnpm monorepo). */
export function loadWorkspacePrefixes(repoPath: string): string[] {
  try {
    return parseWorkspacePrefixes(readFileSync(resolve(repoPath, 'pnpm-workspace.yaml'), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Buckets a repo-relative file path into an area.
 * - Under a recognised workspace prefix (`apps/*`) with a package folder: `apps/web`.
 * - `root` given: one level under `root` (`root=apps/web` -> `apps/web/src`); paths outside
 *   `root` return `null` (excluded from that view).
 * - Otherwise: the top-level directory, or `.` for a file with no directory (repo root).
 * Renames always bucket under the new (current) path — callers pass `file_change.path`, never
 * `old_path`.
 */
export function areaOf(path: string, prefixes: readonly string[], root: string | null = null): string | null {
  const segments = path.split('/');
  if (root !== null) {
    const prefix = `${root}/`;
    if (!path.startsWith(prefix)) return null;
    const rest = path.slice(prefix.length).split('/');
    return rest.length > 1 ? `${root}/${rest[0]}` : root;
  }
  if (segments.length === 1) return '.';
  const top = segments[0]!;
  if (prefixes.includes(top) && segments.length > 2) return `${top}/${segments[1]}`;
  return top;
}
