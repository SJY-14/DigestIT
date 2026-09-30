import { describe, expect, it } from 'vitest';
import { changedCount, rangeSpan, spanContains, spanContext, spansOverlap, walkPatch, type LineSpan } from './hunks.js';

// Two hunks. Hunk 1 (new 10..19): context, a replacement (-2 +3), context, a pure addition, context.
// Hunk 2 (old 40..42 / new 41..42): context, one deletion, context.
const PATCH = [
  'diff --git a/src/retry.ts b/src/retry.ts',
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -10,8 +10,10 @@ export async function fetchJson(url) {',
  ' a10',        // 4: old 10 / new 10
  ' a11',        // 5: old 11 / new 11
  '-old12',      // 6: old 12
  '-old13',      // 7: old 13
  '+new12',      // 8: new 12
  '+new13',      // 9: new 13
  '+new14',      // 10: new 14
  ' a14',        // 11: old 14 / new 15
  '+new16',      // 12: new 16
  ' a15',        // 13: old 15 / new 17
  ' a16',        // 14: old 16 / new 18
  ' a17',        // 15: old 17 / new 19
  '@@ -40,3 +42,2 @@',
  ' b40',        // 17: old 40 / new 42
  '-gone41',     // 18: old 41
  ' b42',        // 19: old 42 / new 43
].join('\n');
const lines = walkPatch(PATCH);
const span = (side: 'old' | 'new', a: number, b: number): LineSpan => {
  const r = rangeSpan(lines, side, a, b);
  if (!r.ok) throw new Error(r.reason);
  return r.span;
};

describe('rangeSpan', () => {
  it('takes the removed half of a replacement with a new-side range that starts on an added line', () => {
    expect(span('new', 12, 14)).toEqual({ hunk: 1, from: 6, to: 10 });
    expect(lines.slice(6, 11).map((l) => l.kind)).toEqual(['-', '-', '+', '+', '+']);
  });

  it('starts at a context line without pulling in earlier deletions', () => {
    expect(span('new', 15, 16)).toEqual({ hunk: 1, from: 11, to: 12 });
  });

  it('includes deleted lines that sit between the matched new-side lines', () => {
    expect(span('new', 11, 12)).toEqual({ hunk: 1, from: 5, to: 8 });
  });

  it('matches deleted and context lines by old number on the old side', () => {
    expect(span('old', 41, 41)).toEqual({ hunk: 2, from: 18, to: 18 });
    expect(span('old', 12, 13)).toEqual({ hunk: 1, from: 6, to: 7 });
  });

  it('clamps a range that runs past the patch to the lines that exist', () => {
    expect(span('new', 18, 30)).toEqual({ hunk: 1, from: 14, to: 15 });
  });

  it('rejects bad, empty and hunk-crossing ranges', () => {
    expect(rangeSpan(lines, 'new', 0, 3)).toEqual({ ok: false, reason: 'bad-range' });
    expect(rangeSpan(lines, 'new', 5, 4)).toEqual({ ok: false, reason: 'bad-range' });
    expect(rangeSpan(lines, 'new', 1.5, 4)).toEqual({ ok: false, reason: 'bad-range' });
    expect(rangeSpan(lines, 'new', 25, 30)).toEqual({ ok: false, reason: 'no-lines' });
    expect(rangeSpan(lines, 'old', 12, 12).ok).toBe(true);
    expect(rangeSpan(lines, 'new', 16, 42)).toEqual({ ok: false, reason: 'crosses-hunks' });
  });

  it('keeps a trailing "no newline" marker with its line', () => {
    const l = walkPatch('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n');
    const r = rangeSpan(l, 'new', 1, 1);
    expect(r).toEqual({ ok: true, span: { hunk: 1, from: 1, to: 3 } });
  });
});

describe('span helpers', () => {
  it('detects overlap, including through the pulled-in removed half of a replacement', () => {
    expect(spansOverlap(span('old', 12, 13), span('new', 12, 14))).toBe(true);
    expect(spansOverlap(span('new', 12, 14), span('new', 15, 16))).toBe(false);
    expect(spanContains(span('new', 12, 14), span('new', 13, 13))).toBe(true);
    expect(spanContains(span('new', 13, 13), span('new', 12, 14))).toBe(false);
  });

  it('counts changed lines in a span and in the file', () => {
    expect(changedCount(lines, span('new', 12, 14))).toBe(5);
    expect(changedCount(lines)).toBe(7);
  });

  it('gives up to n unchanged lines of the same hunk around a span, stopping at a change', () => {
    const c = spanContext(lines, span('new', 12, 14));
    expect(c.before.map((l) => l.text)).toEqual(['a10', 'a11']);
    expect(c.after.map((l) => l.text)).toEqual(['a14']);
    const d = spanContext(lines, span('new', 16, 16), 2);
    expect(d.before.map((l) => l.text)).toEqual(['a14']);
    expect(d.after.map((l) => l.text)).toEqual(['a15', 'a16']);
    const e = spanContext(lines, span('old', 41, 41));
    expect(e.before.map((l) => l.text)).toEqual(['b40']);
    expect(e.after.map((l) => l.text)).toEqual(['b42']);
  });
});
