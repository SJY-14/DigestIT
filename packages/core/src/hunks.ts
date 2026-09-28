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
