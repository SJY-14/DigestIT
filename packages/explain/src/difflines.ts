import { splitHunks, walkPatch, type PatchHunk, type PatchLine } from '@digestit/core/hunks';
import { lineId } from './lineids.js';
import type { ProviderFile } from './provider.js';

/** Line numbers that exist on each side of a per-file unified patch. */
export interface FileLines {
  newLines: Set<number>;
  oldLines: Set<number>;
}

export function indexPatch(patch: string): FileLines {
  const r: FileLines = { newLines: new Set(), oldLines: new Set() };
  for (const l of walkPatch(patch)) {
    if (l.newNo !== undefined) r.newLines.add(l.newNo);
    if (l.oldNo !== undefined) r.oldLines.add(l.oldNo);
  }
  return r;
}

function numberLine(l: PatchLine): string | null {
  if (l.kind === '+' || l.kind === ' ') return `${l.newNo}${l.kind} ${l.text}`;
  if (l.kind === '-') return `${l.oldNo}- ${l.text}`;
  if (l.kind === '\\') return l.text;
  return null;
}

/**
 * Renders a patch for the prompt with explicit line numbers so the model never
 * has to count from hunk headers: `N+ text` / `N  text` use the new-side number,
 * `N- text` uses the old-side number. Git header lines are dropped.
 */
export function numberPatch(patch: string): string {
  const out: string[] = [];
  for (const l of walkPatch(patch)) {
    if (l.kind === 'hunk') out.push(l.text);
    else if (l.kind === 'header') {
      if (l.text.startsWith('[...')) out.push(l.text);
    } else out.push(numberLine(l)!);
  }
  return out.join('\n');
}

/**
 * The hunks of a prepared patch that the model actually sees: at least one
 * content line survived the token budget. Numbering is `splitHunks`' own, so
 * "hunk n" means the same hunk in the prompt, the validator and the UI.
 */
export function promptHunks(patch: string | null): PatchHunk[] {
  return patch === null ? [] : splitHunks(patch).filter((h) => h.lines.length > 0);
}

/**
 * The area walkthrough prompt's rendering (DIG-125): each hunk is labelled
 * `hunk n`, and every content line carries its line ID instead of a line
 * number: `2.7+ text` (added), `2.8  text` (context), `2.9- text` (deleted),
 * counting the hunk's shown `-`, `+` and context lines from 1 (`indexLineIds`
 * numbers them the same way). A `\ No newline` marker is shown as is, with no
 * ID. Hunks with no visible line are left out. A hunk cut by the token budget
 * ends with the truncation marker.
 */
export function renderHunks(patch: string): string {
  const out: string[] = [];
  const hunks = promptHunks(patch);
  for (const h of hunks) {
    out.push(`hunk ${h.index}  ${h.header}`);
    let n = 0;
    for (const l of h.lines) out.push(l.kind === '\\' ? l.text : `${lineId(h.index, ++n)}${l.kind} ${l.text}`);
  }
  const all = splitHunks(patch);
  const last = hunks[hunks.length - 1];
  if (last && (!last.complete || all.length > hunks.length || /^\[\.\.\./m.test(patch))) {
    out.push('[... the rest of this file was cut to fit the token budget ...]');
  }
  return out.join('\n');
}

/** The hunk numbers the area prompt shows, per analysed file, in file order; files with no visible hunk are left out. */
export function areaHunks(files: readonly ProviderFile[]): { path: string; hunks: number[] }[] {
  return files
    .filter((f) => f.filteredReason === null && f.patch !== null)
    .map((f) => ({ path: f.path, hunks: promptHunks(f.patch).map((h) => h.index) }))
    .filter((f) => f.hunks.length > 0);
}
