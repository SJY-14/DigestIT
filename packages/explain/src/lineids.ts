import { rangeSpan, type DiffSide, type LineSpan, type PatchLine } from '@digestit/core/hunks';

// Line IDs for the area walkthrough prompt (DIG-125, docs/l3-step-snippets.md §1a). The prompt
// labels every shown diff line with a hunk-relative ID, "2.7" = hunk 2, 7th shown line, counting
// `-`, `+` and context lines alike, so the model never has to pick a side or copy a line number.
// The parser turns the IDs it gets back into the stored `LineRange` ({side, start, end}); the
// stored shape, `rangeSpan` and the UI do not change.

/** "2.7": hunk `hunk`, `n`-th shown content line of that hunk (1-based). */
export const lineId = (hunk: number, n: number): string => `${hunk}.${n}`;

const ID = /^\s*(\d+)\.(\d+)\s*$/;

/** `{hunk, n}` for a well-formed line ID string, `null` otherwise. Numbers are refused: `2.10` as a JSON number reads as 2.1. */
export function parseLineId(v: unknown): { hunk: number; n: number } | null {
  if (typeof v !== 'string') return null;
  const m = ID.exec(v);
  if (!m) return null;
  const hunk = Number(m[1]);
  const n = Number(m[2]);
  return hunk >= 1 && n >= 1 ? { hunk, n } : null;
}

const isContent = (l: PatchLine): boolean => l.kind === ' ' || l.kind === '+' || l.kind === '-';

/** Both directions between line IDs and indices of one file's `walkPatch` output. */
export interface LineIdIndex {
  /** "2.7" -> walk index. */
  index: Map<string, number>;
  /** walk index -> "2.7" (content lines only). */
  id: Map<number, string>;
  /** Shown content lines per hunk. */
  count: Map<number, number>;
}

export function indexLineIds(lines: readonly PatchLine[]): LineIdIndex {
  const index = new Map<string, number>();
  const id = new Map<number, string>();
  const count = new Map<number, number>();
  lines.forEach((l, i) => {
    if (!isContent(l) || l.hunk === undefined) return;
    const n = (count.get(l.hunk) ?? 0) + 1;
    count.set(l.hunk, n);
    index.set(lineId(l.hunk, n), i);
    id.set(i, lineId(l.hunk, n));
  });
  return { index, id, count };
}

/** One way to store a line span: the `LineRange` fields plus the span `rangeSpan` gives them. */
export interface SnappedRange {
  side: DiffSide;
  start: number;
  end: number;
  span: LineSpan;
}

const sideNo = (l: PatchLine, side: DiffSide): number | undefined =>
  side === 'new'
    ? (l.kind === '+' || l.kind === ' ' ? l.newNo : undefined)
    : (l.kind === '-' || l.kind === ' ' ? l.oldNo : undefined);

function sideCandidates(lines: readonly PatchLine[], from: number, to: number, side: DiffSide): SnappedRange[] {
  const hunk = lines[from]!.hunk;
  const numbered: number[] = [];
  lines.forEach((l, i) => {
    if (l.hunk === hunk && sideNo(l, side) !== undefined) numbered.push(i);
  });
  const inside = numbered.filter((i) => i >= from && i <= to);
  const before = numbered.filter((i) => i < from);
  const after = numbered.filter((i) => i > to);
  // The first/last line of this side inside the named lines, then the nearest one outside them
  // (for named lines at either edge that have no number on this side).
  const starts = [inside[0], before[before.length - 1]].filter((i): i is number => i !== undefined);
  const ends = [inside[inside.length - 1], after[0]].filter((i): i is number => i !== undefined);
  const out: SnappedRange[] = [];
  for (const s of starts) {
    for (const e of ends) {
      if (e < s) continue;
      const start = sideNo(lines[s]!, side)!;
      const end = sideNo(lines[e]!, side)!;
      const r = rangeSpan(lines, side, start, end);
      if (r.ok && r.span.from <= from && r.span.to >= to) out.push({ side, start, end, span: r.span });
    }
  }
  return out.sort((a, b) => (a.span.to - a.span.from) - (b.span.to - b.span.from));
}

/**
 * Every stored `LineRange` whose `rangeSpan` keeps all of the walk lines `from..to` (one hunk),
 * best first: the side is `new` when the named lines hold any new-numbered line (added or
 * context), `old` otherwise, and the other side only when the preferred one cannot hold them
 * all; within a side, the smallest span first. Usually the first candidate is exact; it is
 * larger only where `rangeSpan` cannot cut there (a `new` range starting on an added line takes
 * the deletions right before it; a run of deletions at either edge of mixed lines needs the
 * nearest numbered line beyond it). Empty when no stored range can hold the lines.
 */
export function snapCandidates(lines: readonly PatchLine[], from: number, to: number): SnappedRange[] {
  if (from > to || !lines[from] || !lines[to] || lines[from]!.hunk === undefined || lines[from]!.hunk !== lines[to]!.hunk) return [];
  let hasNew = false;
  for (let i = from; i <= to; i++) if (sideNo(lines[i]!, 'new') !== undefined) hasNew = true;
  const order: DiffSide[] = hasNew ? ['new', 'old'] : ['old', 'new'];
  return order.flatMap((side) => sideCandidates(lines, from, to, side));
}

/** The best stored range for walk lines `from..to`, or `null` (see `snapCandidates`). */
export function snapSpan(lines: readonly PatchLine[], from: number, to: number): SnappedRange | null {
  return snapCandidates(lines, from, to)[0] ?? null;
}

/** "2.3-2.9" (or "2.5" for one line): the IDs of the first and last content line of `span`. */
export function spanIds(ids: LineIdIndex, lines: readonly PatchLine[], span: LineSpan): string {
  let a = span.from;
  while (a < span.to && !isContent(lines[a]!)) a++;
  let b = span.to;
  while (b > a && !isContent(lines[b]!)) b--;
  const first = ids.id.get(a) ?? '?';
  const last = ids.id.get(b) ?? '?';
  return first === last ? first : `${first}-${last}`;
}
