import { describe, expect, it } from 'vitest';
import { annotate, foldHunk, keyLineSet, lineRange, parsePatch, splitHunks, type DiffLine } from './diff.js';

const patch = ['@@ -1,3 +1,3 @@ fn', ' a', '-b', '+B', '+c', ' d', '\\ No newline at end of file', ''].join('\n');

describe('parsePatch', () => {
  it('numbers old and new sides and skips markers', () => {
    const l = parsePatch(patch);
    expect(l.map((x) => [x.kind, x.oldNo, x.newNo])).toEqual([
      ['hunk', null, null],
      ['ctx', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['ctx', 3, 4],
    ]);
  });
  it('ignores headers before the first hunk and handles multiple hunks', () => {
    const l = parsePatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -10,2 +10,2 @@\n x\n-y\n+z');
    expect(l.filter((x) => x.kind === 'add').map((x) => x.newNo)).toEqual([1, 11]);
    expect(l.find((x) => x.text === 'x')?.oldNo).toBe(10);
  });
  it('does not treat text starting with "@@" inside a hunk as markup', () => {
    expect(parsePatch('@@ -1 +1 @@\n+@@ not a hunk').at(1)?.text).toBe('@@ not a hunk');
  });
});

describe('annotate', () => {
  it('anchors on the requested side and returns unplaced notes', () => {
    const l = parsePatch(patch);
    const un = annotate(l, [
      { path: 'x', side: 'new', startLine: 2, endLine: 3, note: 'n1' },
      { path: 'x', side: 'old', startLine: 2, endLine: 2, note: 'o1' },
      { path: 'x', side: 'new', startLine: 99, endLine: 99, note: 'gone' },
    ]);
    expect(l.find((x) => x.newNo === 3)?.notes.map((n) => n.note)).toEqual(['n1']);
    expect(l.find((x) => x.kind === 'del')?.notes.map((n) => n.note)).toEqual(['o1']);
    expect(un.map((a) => a.note)).toEqual(['gone']);
  });
  it('marks key lines across the range', () => {
    const l = parsePatch(patch);
    const k = keyLineSet(l, [{ path: 'x', side: 'new', startLine: 2, endLine: 3, note: '' }]);
    expect(k.size).toBe(2);
  });
});

describe('lineRange', () => {
  it('labels single lines, ranges and the old side', () => {
    expect(lineRange({ side: 'new', startLine: 4, endLine: 4 })).toBe('Line 4');
    expect(lineRange({ side: 'new', startLine: 11, endLine: 13 })).toBe('Lines 11–13');
    expect(lineRange({ side: 'old', startLine: 2, endLine: 5 })).toBe('Lines 2–5 (old)');
  });
});

const ctxLine = (n: number): DiffLine => ({ kind: 'ctx', text: `l${n}`, oldNo: n, newNo: n, notes: [] });

describe('splitHunks', () => {
  it('groups lines under their hunk header and drops pre-hunk headers', () => {
    const l = parsePatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -10,2 +10,2 @@\n x\n-y\n+z');
    const hunks = splitHunks(l);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.content.map((x) => x.text)).toEqual(['a', 'b']);
    expect(hunks[1]!.content.map((x) => x.text)).toEqual(['x', 'y', 'z']);
  });
});

describe('foldHunk', () => {
  it('shows everything when the hunk is at or under the threshold', () => {
    const content = Array.from({ length: 20 }, (_, i) => ctxLine(i));
    const segs = foldHunk(content, new Set(), 3, 20);
    expect(segs).toEqual([{ visible: true, lines: content }]);
  });

  it('folds a long hunk entirely when nothing is annotated', () => {
    const content = Array.from({ length: 25 }, (_, i) => ctxLine(i));
    const segs = foldHunk(content, new Set(), 3, 20);
    expect(segs).toEqual([{ visible: false, lines: content }]);
  });

  it('keeps a +/- context window around key lines and folds the rest', () => {
    const content = Array.from({ length: 30 }, (_, i) => ctxLine(i));
    const keySet = new Set([content[15]!]);
    const segs = foldHunk(content, keySet, 3, 20);
    expect(segs.map((s) => [s.visible, s.lines.length])).toEqual([
      [false, 12], // 0..11
      [true, 7],   // 12..18 (15 +/- 3)
      [false, 11], // 19..29
    ]);
  });

  it('merges overlapping context windows from adjacent key lines into one visible segment', () => {
    const content = Array.from({ length: 30 }, (_, i) => ctxLine(i));
    const keySet = new Set([content[10]!, content[13]!]);
    const segs = foldHunk(content, keySet, 3, 20);
    expect(segs.map((s) => s.visible)).toEqual([false, true, false]);
    expect(segs[1]!.lines.map((l) => l.text)).toEqual(['l7', 'l8', 'l9', 'l10', 'l11', 'l12', 'l13', 'l14', 'l15', 'l16']);
  });
});
