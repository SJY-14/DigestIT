// Per-project "N new" signal (UX cycle 2 P4/P7, decision-2.md §2): diffs a project's newest
// digest seq against what this browser last saw for it (storage.ts's LastSeen). Shared by the
// project panel (P4) and the All-projects view (P7), which both need the same number.
import type { ProjectDto } from '@digestit/core';
import type { LastSeen } from './storage.js';

export type UnreadState =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'count'; n: number };

/**
 * `kind: 'none'` covers both "nothing to read" (no digest yet) and "caught up" (seen the newest).
 * `kind: 'new'` is for a `lastSeen` entry written before `seq` existed — there is no ordinal to
 * diff against, so this just says something changed rather than guessing a count.
 */
export function computeUnread(project: Pick<ProjectDto, 'digestCount' | 'latestDigest'>, lastSeen: LastSeen | null): UnreadState {
  if (project.latestDigest === null) return { kind: 'none' };
  if (lastSeen === null) return project.digestCount > 0 ? { kind: 'count', n: project.digestCount } : { kind: 'none' };
  if (lastSeen.seq === undefined) return { kind: 'new' };
  const n = project.latestDigest.seq - lastSeen.seq;
  return n > 0 ? { kind: 'count', n } : { kind: 'none' };
}
