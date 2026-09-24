/** Line numbers that exist on each side of a per-file unified patch. */
export interface FileLines {
  newLines: Set<number>;
  oldLines: Set<number>;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface NumberedLine {
  kind: 'header' | 'hunk' | ' ' | '+' | '-';
  text: string;
  oldNo?: number;
  newNo?: number;
}

/**
 * Walks a patch using hunk counts, so content lines that look like headers
 * ("--- x") are not misread. A hunk ends early at an unknown prefix (e.g. the
 * truncation marker), so only lines the model actually saw are indexed.
 */
function walk(patch: string): NumberedLine[] {
  const out: NumberedLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === ' ' && oldLeft > 0 && newLeft > 0) {
        out.push({ kind: ' ', text: line.slice(1), oldNo, newNo });
        oldNo++; newNo++; oldLeft--; newLeft--;
        continue;
      }
      if (c === '-' && oldLeft > 0) {
        out.push({ kind: '-', text: line.slice(1), oldNo });
        oldNo++; oldLeft--;
        continue;
      }
      if (c === '+' && newLeft > 0) {
        out.push({ kind: '+', text: line.slice(1), newNo });
        newNo++; newLeft--;
        continue;
      }
      if (c === '\\') {
        out.push({ kind: 'header', text: line });
        continue;
      }
      oldLeft = 0;
      newLeft = 0;
    }
    const m = HUNK.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      out.push({ kind: 'hunk', text: line });
    } else {
      out.push({ kind: 'header', text: line });
    }
  }
  return out;
}

export function indexPatch(patch: string): FileLines {
  const r: FileLines = { newLines: new Set(), oldLines: new Set() };
  for (const l of walk(patch)) {
    if (l.newNo !== undefined) r.newLines.add(l.newNo);
    if (l.oldNo !== undefined) r.oldLines.add(l.oldNo);
  }
  return r;
}

/**
 * Renders a patch for the prompt with explicit line numbers so the model never
 * has to count from hunk headers: `N+ text` / `N  text` use the new-side number,
 * `N- text` uses the old-side number. Git header lines are dropped.
 */
export function numberPatch(patch: string): string {
  const out: string[] = [];
  for (const l of walk(patch)) {
    if (l.kind === 'hunk') out.push(l.text);
    else if (l.kind === '+' || l.kind === ' ') out.push(`${l.newNo}${l.kind} ${l.text}`);
    else if (l.kind === '-') out.push(`${l.oldNo}- ${l.text}`);
    else if (l.text.startsWith('\\') || l.text.startsWith('[...')) out.push(l.text);
  }
  return out.join('\n');
}
