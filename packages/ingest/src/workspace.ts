import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// T4-b (docs/milestone-3.md), moved from apps/server/src/areas.ts for DIG-75: "area" is a
// workspace-aware prefix. It needs no configuration and works for any repo, not just this one: a
// pnpm-workspace.yaml (if present) names the package roots (`apps/*`, `packages/*`); anything else
// buckets to its top-level directory. `groupDigestAreas` (`@digestit/core`) is the caller that needs
// this at digest-creation time, so it lives in `@digestit/ingest`, not `apps/server`.

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
