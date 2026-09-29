// T4-b (docs/milestone-3.md): "area" is a workspace-aware prefix. It needs no configuration and
// works for any repo, not just this one: a pnpm-workspace.yaml (if present) names the package
// roots (`apps/*`, `packages/*`); anything else buckets to its top-level directory.
// The prefix-parsing helpers moved to `@digestit/ingest` (DIG-75): `groupDigestAreas` needs them
// at digest-creation time, and ingest cannot depend on apps/server. Re-exported here so this
// package's existing imports (`insights.ts`) keep working unchanged.
export { loadWorkspacePrefixes, parseWorkspacePrefixes } from '@digestit/ingest';

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
