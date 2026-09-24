export interface Annotation {
  path: string;
  side: 'new' | 'old';
  startLine: number;
  endLine: number;
  note: string;
}

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line text without the leading +/-/space marker (full header for hunks). */
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** Annotations whose range ends at this line; rendered right below it. */
  notes: Annotation[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a unified-diff patch (hunks only; file headers before the first hunk are ignored). */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const h = HUNK.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null, notes: [] });
      continue;
    }
    if (!inHunk || raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const c = raw[0];
    if (c === '+') out.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++, notes: [] });
    else if (c === '-') out.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null, notes: [] });
    else if (c === ' ') out.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++, notes: [] });
    // anything else (e.g. the empty string after the trailing newline) is not a diff line
  }
  return out;
}

/**
 * Attach each annotation to the line where its range ends on its side. Returns the notes that
 * could not be placed (line not in the diff) so the UI can still show them rather than lose them.
 */
export function annotate(lines: DiffLine[], annotations: Annotation[]): Annotation[] {
  const unplaced: Annotation[] = [];
  for (const a of annotations) {
    const target = lines.find((l) => (a.side === 'new' ? l.newNo : l.oldNo) === a.endLine);
    if (target) target.notes.push(a);
    else unplaced.push(a);
  }
  return unplaced;
}

/** Card header for an annotation, e.g. "Lines 11–13" or "Line 4 (old)". */
export function lineRange(a: Pick<Annotation, 'side' | 'startLine' | 'endLine'>): string {
  const r = a.startLine === a.endLine ? `Line ${a.startLine}` : `Lines ${a.startLine}–${a.endLine}`;
  return a.side === 'old' ? `${r} (old)` : r;
}

/** True when a line falls inside any annotated range for the file (used for highlighting key lines). */
export function keyLineSet(lines: DiffLine[], annotations: Annotation[]): Set<DiffLine> {
  const key = new Set<DiffLine>();
  for (const a of annotations) {
    for (const l of lines) {
      const n = a.side === 'new' ? l.newNo : l.oldNo;
      if (n !== null && n >= a.startLine && n <= a.endLine) key.add(l);
    }
  }
  return key;
}
