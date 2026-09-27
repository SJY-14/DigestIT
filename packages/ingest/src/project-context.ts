// Project context (direction-v2 §3) for both the CLI and the server: build it from a checkpoint,
// build it once when missing, and refresh it automatically only on a structural change.
import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  buildProjectContext, buildProjectMap, compactContext, hashUserMd, needsRefresh,
  type ExplanationProvider, type ProjectMap,
} from '@digestit/explain';
import type { ProjectContextContent } from '@digestit/core';
import { projectDataDir } from './datahome.js';
import { latestCheckpoint, type ProjectRow } from './project.js';
import { listTree, openShadow, readTreeFile, type Shadow } from './shadow.js';

export interface ContextBuildOptions {
  budget: number;
  now?: () => Date;
}

/** Latest usable context, compacted for prompt grounding; undefined when none ever built ok. */
export function latestContextText(db: DatabaseSync, repoId: number): string | undefined {
  const row = db.prepare(
    `SELECT content FROM project_context WHERE repo_id = ? AND status IN ('ok','truncated')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(repoId) as { content: string } | undefined;
  if (!row) return undefined;
  try {
    return compactContext(JSON.parse(row.content) as ProjectContextContent);
  } catch {
    return undefined;
  }
}

/**
 * The project map of a checkpoint, read from the shadow store (so it is exactly what was
 * snapshotted, never a denylisted file). `buildProjectMap` reads synchronously and chooses which
 * files to read from their paths alone, so one dry pass collects the paths, then they are loaded.
 */
async function mapOfTree(shadow: Shadow, treeSha: string): Promise<ProjectMap> {
  const files = await listTree(shadow, treeSha);
  const wanted: string[] = [];
  buildProjectMap(files, (p) => {
    wanted.push(p);
    return null;
  });
  const contents = new Map<string, string | null>();
  for (const p of wanted) contents.set(p, await readTreeFile(shadow, treeSha, p));
  return buildProjectMap(files, (p) => contents.get(p) ?? null);
}

function readUserMd(row: ProjectRow): string | null {
  return row.contextPath && existsSync(row.contextPath) ? readFileSync(row.contextPath, 'utf8') : null;
}

/** One build from the latest checkpoint: one provider call against the daily budget. */
export async function buildContext(
  db: DatabaseSync, home: string, row: ProjectRow, provider: ExplanationProvider, opts: ContextBuildOptions,
) {
  const latest = latestCheckpoint(db, row.id);
  if (!latest) throw new Error('project has no checkpoint yet');
  const shadow = await openShadow(projectDataDir(home, row.id), row.path);
  const map = await mapOfTree(shadow, latest.treeSha);
  return buildProjectContext(db, row.id, latest.id, row.name, map, readUserMd(row), provider, { budget: opts.budget, now: opts.now });
}

/**
 * Explain-time policy: build when the project has no context yet; otherwise rebuild only when the
 * README, a manifest, the user `.md` or the top-level folders changed since the last build, at
 * most once a day (`needsRefresh`). Returns whether a build ran.
 */
export async function ensureContext(
  db: DatabaseSync, home: string, row: ProjectRow, provider: ExplanationProvider, opts: ContextBuildOptions,
): Promise<boolean> {
  const last = db.prepare(
    `SELECT pc.created_at AS createdAt, pc.user_context_hash AS userHash, c.shadow_sha AS treeSha
     FROM project_context pc LEFT JOIN checkpoint c ON c.id = pc.checkpoint_id
     WHERE pc.repo_id = ? ORDER BY pc.created_at DESC, pc.id DESC LIMIT 1`,
  ).get(row.id) as { createdAt: string; userHash: string | null; treeSha: string | null } | undefined;
  const latest = latestCheckpoint(db, row.id);
  if (!latest) return false;
  if (last) {
    if (!last.treeSha) return false;
    const shadow = await openShadow(projectDataDir(home, row.id), row.path);
    const [prev, next] = [await mapOfTree(shadow, last.treeSha), await mapOfTree(shadow, latest.treeSha)];
    const now = (opts.now ?? (() => new Date()))();
    if (!needsRefresh(prev, next, last.userHash, hashUserMd(readUserMd(row)), last.createdAt, now)) return false;
  }
  await buildContext(db, home, row, provider, opts);
  return true;
}
