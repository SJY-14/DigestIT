import { describe, expect, it } from 'vitest';
import { annotate, keyLineSet, lineRange, parsePatch } from './diff.js';

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
