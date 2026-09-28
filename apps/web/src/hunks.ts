// Split one file's unified patch into numbered hunks (docs/ux-v3.md §2). The walk follows the
// `@@` line counts like packages/explain/src/difflines.ts, so a content line that happens to look
// like a header ("--- x", "@@ ...") is never taken for a hunk boundary, and hunk n here is hunk n
// in the prompt and the validator. Shared test vector: packages/core/test-vectors/hunk-split.json.
import type { AreaWalkthrough, HunkRef } from '@digestit/core';
import type { DiffLine } from './diff.js';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface PatchHunk {
  /** 1-based position in the file's patch. */
  hunk: number;
  header: string;
  oldStart: number;
  newStart: number;
  /** Content lines (no header, no "\ No newline" markers). */
  lines: DiffLine[];
}

export function splitPatch(patch: string): PatchHunk[] {
  const out: PatchHunk[] = [];
  let cur: PatchHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === ' ' && oldLeft > 0 && newLeft > 0) {
        cur.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++, notes: [] });
        oldLeft--; newLeft--;
        continue;
      }
      if (c === '-' && oldLeft > 0) {
        cur.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null, notes: [] });
        oldLeft--;
        continue;
      }
      if (c === '+' && newLeft > 0) {
        cur.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++, notes: [] });
        newLeft--;
        continue;
      }
      if (c === '\\') continue;
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith('\\')) continue; // marker right after a hunk's last line
    const m = HUNK.exec(line);
    if (!m) continue;
    oldNo = Number(m[1]);
    newNo = Number(m[3]);
    oldLeft = m[2] === undefined ? 1 : Number(m[2]);
    newLeft = m[4] === undefined ? 1 : Number(m[4]);
    cur = { hunk: out.length + 1, header: line, oldStart: oldNo, newStart: newNo, lines: [] };
    out.push(cur);
  }
  return out;
}

/** Stable key for a hunk reference. */
export const hunkKey = (ref: HunkRef): string => `${ref.path}#${ref.hunk}`;

export interface FileHunk extends PatchHunk {
  path: string;
}

/**
 * Hunks of `files` that no step references, in file then patch order: the ones the token budget
 * cut from the prompt. They are listed after "What to check" as not covered by the walkthrough.
 */
export function uncoveredHunks(files: readonly { path: string; patch: string | null }[], walkthrough: AreaWalkthrough | null): FileHunk[] {
  const covered = new Set((walkthrough?.steps ?? []).flatMap((s) => s.hunks.map(hunkKey)));
  return files.flatMap((f) =>
    splitPatch(f.patch ?? '')
      .filter((h) => !covered.has(hunkKey({ path: f.path, hunk: h.hunk })))
      .map((h) => ({ ...h, path: f.path })),
  );
}
