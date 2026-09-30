// Hunk walker shared by the explain prompts, the walkthrough validator and the web UI (DIG-48).
// Pure and browser-safe: no Node imports. Exported as `@digestit/core/hunks` for the web bundle.

/** One line of a per-file unified patch, as seen by a count-aware walk. */
export interface PatchLine {
  /**
   * `hunk`: an `@@` header. `' '`/`+`/`-`: a content line inside a hunk. `\`: a
   * "\ No newline at end of file" marker. `header`: anything outside a hunk (git
   * file headers, a truncation marker, stray text).
   */
  kind: 'hunk' | ' ' | '+' | '-' | '\\' | 'header';
  /** Content without the one-character prefix for `' '`/`+`/`-`; the raw line otherwise. */
  text: string;
  oldNo?: number;
  newNo?: number;
  /** 1-based index of the hunk this line belongs to (set on the header and its lines). */
  hunk?: number;
}

export interface PatchHunk {
  /** 1-based, in patch order: "hunk 1", "hunk 2", … */
  index: number;
  /** The raw `@@ -a,b +c,d @@ section` line. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Content and `\` lines that are actually present in the patch. */
  lines: PatchLine[];
  /** False when the patch ends (or is cut, e.g. by a token-budget marker) before the header's counts are used up. */
  complete: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Walks a patch using the hunk header counts, so content lines that look like
 * headers (a removed "-- x" shows as "--- x", an added "@@ x" as "+@@ x") are
 * never misread. A hunk ends early at a line with an unknown prefix (e.g. the
 * truncation marker), so only lines that are really there are returned.
 */
export function walkPatch(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let hunk = 0;
  const lines = patch.split('\n');
  // A trailing newline is not a line of its own.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === ' ' && oldLeft > 0 && newLeft > 0) {
        out.push({ kind: ' ', text: line.slice(1), oldNo, newNo, hunk });
        oldNo++; newNo++; oldLeft--; newLeft--;
        continue;
      }
      if (c === '-' && oldLeft > 0) {
        out.push({ kind: '-', text: line.slice(1), oldNo, hunk });
        oldNo++; oldLeft--;
        continue;
      }
      if (c === '+' && newLeft > 0) {
        out.push({ kind: '+', text: line.slice(1), newNo, hunk });
        newNo++; newLeft--;
        continue;
      }
      if (c === '\\') {
        out.push({ kind: '\\', text: line, hunk });
        continue;
      }
      oldLeft = 0;
      newLeft = 0;
    } else if (line[0] === '\\' && hunk > 0 && out[out.length - 1]?.hunk === hunk) {
      // "\ No newline at end of file" right after the hunk's last counted line.
      out.push({ kind: '\\', text: line, hunk });
      continue;
    }
    const m = HUNK.exec(line);
    if (m) {
      hunk++;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      out.push({ kind: 'hunk', text: line, hunk });
    } else {
      out.push({ kind: 'header', text: line });
    }
  }
  return out;
}

/** The hunks of one file's patch, numbered 1..n in patch order. `[]` for an empty or binary patch. */
export function splitHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  for (const l of walkPatch(patch)) {
    if (l.kind === 'hunk') {
      const m = HUNK.exec(l.text)!;
      hunks.push({
        index: l.hunk!,
        header: l.text,
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
        complete: false,
      });
    } else if (l.hunk !== undefined) {
      hunks[hunks.length - 1]!.lines.push(l);
    }
  }
  for (const h of hunks) {
    const olds = h.lines.filter((l) => l.kind === ' ' || l.kind === '-').length;
    const news = h.lines.filter((l) => l.kind === ' ' || l.kind === '+').length;
    h.complete = olds === h.oldCount && news === h.newCount;
  }
  return hunks;
}

// ---- Step ranges and callouts (DIG-96, docs/l3-step-snippets.md) ----------------------------
// A walkthrough step points at an exact line range of one file, not at whole hunks. These helpers
// turn such a range into a span of `walkPatch` lines, so the validator (overlap, size, callouts
// inside their step) and the web UI (the step's snippet, the full diff's step badges) cut the
// patch the same way.

export type DiffSide = 'old' | 'new';

/**
 * A contiguous span of one file's `walkPatch(patch)` output: indices `from..to` (inclusive), all
 * inside hunk `hunk`. Deleted lines between the matched lines are part of the span.
 */
export interface LineSpan {
  hunk: number;
  from: number;
  to: number;
}

export type SpanResult =
  | { ok: true; span: LineSpan }
  /** `bad-range`: start/end not positive integers with start ≤ end. `no-lines`: no patch line has
   * such a number on that side. `crosses-hunks`: the matched lines are in more than one hunk. */
  | { ok: false; reason: 'bad-range' | 'no-lines' | 'crosses-hunks' };

const isChange = (l: PatchLine): boolean => l.kind === '+' || l.kind === '-';

/**
 * The span of `lines` (one file's `walkPatch` output) that the range `side` `start..end` covers.
 * Line numbers are the prompt's (`N+`/`N ` are new-side numbers, `N-` old-side numbers):
 * - `new` matches added and context lines whose new number is in the range;
 * - `old` matches deleted and context lines whose old number is in the range.
 * The span runs from the first to the last matched line, so it also takes the lines of the other
 * side that sit between them. A `new` span whose first line is an added line also takes the
 * deleted lines right before it (the removed half of a replacement), so "what replaced what"
 * always stays together. A range must stay inside one hunk.
 */
export function rangeSpan(lines: readonly PatchLine[], side: DiffSide, start: number, end: number): SpanResult {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return { ok: false, reason: 'bad-range' };
  let from = -1;
  let to = -1;
  lines.forEach((l, i) => {
    const no = side === 'new'
      ? (l.kind === '+' || l.kind === ' ' ? l.newNo : undefined)
      : (l.kind === '-' || l.kind === ' ' ? l.oldNo : undefined);
    if (no !== undefined && no >= start && no <= end) {
      if (from < 0) from = i;
      to = i;
    }
  });
  if (from < 0) return { ok: false, reason: 'no-lines' };
  const hunk = lines[from]!.hunk!;
  if (lines[to]!.hunk !== hunk) return { ok: false, reason: 'crosses-hunks' };
  if (side === 'new' && lines[from]!.kind === '+') {
    while (from > 0 && lines[from - 1]!.kind === '-' && lines[from - 1]!.hunk === hunk) from--;
  }
  // A "\ No newline at end of file" marker right after the span belongs to its last line.
  while (to + 1 < lines.length && lines[to + 1]!.kind === '\\' && lines[to + 1]!.hunk === hunk) to++;
  return { ok: true, span: { hunk, from, to } };
}

/** Whether two spans of the same file share at least one patch line. */
export function spansOverlap(a: LineSpan, b: LineSpan): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** Whether `inner` lies completely inside `outer` (same file). */
export function spanContains(outer: LineSpan, inner: LineSpan): boolean {
  return outer.from <= inner.from && inner.to <= outer.to;
}

/** Added plus deleted lines inside `span`, or in the whole file when `span` is omitted. */
export function changedCount(lines: readonly PatchLine[], span?: LineSpan): number {
  const part = span ? lines.slice(span.from, span.to + 1) : lines;
  return part.filter(isChange).length;
}

/**
 * Up to `n` unchanged lines of the same hunk right before and right after `span`, for the dimmed
 * context around a step's snippet. It stops at the first changed line, so a snippet never shows
 * another step's changes as context.
 */
export function spanContext(lines: readonly PatchLine[], span: LineSpan, n = 3): { before: PatchLine[]; after: PatchLine[] } {
  const before: PatchLine[] = [];
  for (let i = span.from - 1; i >= 0 && before.length < n; i--) {
    const l = lines[i]!;
    if (l.hunk !== span.hunk || l.kind !== ' ') break;
    before.unshift(l);
  }
  const after: PatchLine[] = [];
  for (let i = span.to + 1; i < lines.length && after.length < n; i++) {
    const l = lines[i]!;
    if (l.hunk !== span.hunk || l.kind !== ' ') break;
    after.push(l);
  }
  return { before, after };
}
