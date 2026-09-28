import { describe, expect, it } from 'vitest';
import { splitHunks, walkPatch } from './hunks.js';

// Content lines that look like headers: a removed "-- x" is "--- x", an added "++ y" is "+++ y",
// an added or kept line whose text starts with "@@" is "+@@ …" / " @@ …".
const TRICKY = [
  'diff --git a/f.ts b/f.ts',
  'index 1..2 100644',
  '--- a/f.ts',
  '+++ b/f.ts',
  '@@ -3,4 +3,4 @@ function f() {',
  ' keep',
  '--- looks like a header',
  '+++ so does this',
  ' @@ -1 +1 @@ a kept line that looks like a hunk header',
  ' tail',
  '@@ -20 +20,2 @@',
  '-gone',
  '+@@ -9,9 +9,9 @@ added text that looks like a hunk header',
  '+b',
  '\\ No newline at end of file',
].join('\n');

describe('splitHunks', () => {
  it('numbers hunks 1..n by header counts, not by line prefixes', () => {
    const h = splitHunks(TRICKY);
    expect(h.map((x) => x.index)).toEqual([1, 2]);
    expect(h[0]).toMatchObject({ oldStart: 3, oldCount: 4, newStart: 3, newCount: 4, complete: true });
    expect(h[0]!.lines.map((l) => l.kind)).toEqual([' ', '-', '+', ' ', ' ']);
    expect(h[0]!.lines[1]).toMatchObject({ kind: '-', text: '-- looks like a header', oldNo: 4 });
    expect(h[1]).toMatchObject({ oldStart: 20, oldCount: 1, newStart: 20, newCount: 2, complete: true });
    expect(h[1]!.lines.map((l) => l.kind)).toEqual(['-', '+', '+', '\\']);
    expect(h[1]!.lines[1]!.newNo).toBe(20);
  });

  it('keeps a hunk cut by a truncation marker as incomplete and drops everything after it', () => {
    const cut = '@@ -1,5 +1,5 @@\n a\n b\n[... truncated to fit token budget ...]\n';
    const h = splitHunks(cut);
    expect(h).toHaveLength(1);
    expect(h[0]!.complete).toBe(false);
    expect(h[0]!.lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('numbers a truncated patch the same as the full one, for the hunks that survive', () => {
    const full = '@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -10,2 +10,3 @@\n x\n+y\n z\n@@ -30 +31 @@\n-p\n+q\n';
    const cut = `${full.slice(0, full.indexOf(' z\n'))}[... truncated to fit token budget ...]\n`;
    const fullHunks = splitHunks(full);
    const cutHunks = splitHunks(cut);
    expect(fullHunks.map((h) => h.header)).toEqual(['@@ -1,2 +1,2 @@', '@@ -10,2 +10,3 @@', '@@ -30 +31 @@']);
    expect(cutHunks.map((h) => [h.index, h.header, h.complete])).toEqual([
      [1, '@@ -1,2 +1,2 @@', true],
      [2, '@@ -10,2 +10,3 @@', false],
    ]);
  });

  it('returns no hunks for an empty or binary patch', () => {
    expect(splitHunks('')).toEqual([]);
    expect(splitHunks('Binary files a/x.png and b/x.png differ\n')).toEqual([]);
  });

  it('marks non-hunk lines as header lines in the walk', () => {
    const kinds = walkPatch(TRICKY).map((l) => l.kind);
    expect(kinds.slice(0, 4)).toEqual(['header', 'header', 'header', 'header']);
    expect(kinds.filter((k) => k === 'hunk')).toHaveLength(2);
  });
});
