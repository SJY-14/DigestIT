import { describe, expect, it } from 'vitest';
import { LENGTH_TOLERANCE, checkLevels, cleanText, fitBullets, fitProse, hasUnsafeMarkup, tolerated } from './validate.js';
import type { ProviderFile } from './provider.js';

const files: ProviderFile[] = [
  { path: 'a.ts', status: 'M', additions: 2, deletions: 1, filteredReason: null,
    patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n x\n-old\n+new1\n+new2\n' },
  { path: 'pnpm-lock.yaml', status: 'M', additions: 9, deletions: 9, patch: null, filteredReason: 'lockfile' },
];
const good = () => ({
  l0: { text: 'Lets owners see why a change happened.' },
  l1: { userVisible: true, bullets: ['Owners see a reason next to each change.'] },
  l2: { items: [{ path: 'a.ts', role: 'core', change: 'adds lines' }], notAnalysed: [] },
  l3: { annotations: [{ path: 'a.ts', side: 'new' as const, startLine: 2, endLine: 3, note: 'New lines.' }] },
});
const w = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('checkLevels', () => {
  it('accepts valid output and derives notAnalysed from the input', () => {
    const r = checkLevels(good(), files)!;
    expect(r.violations).toEqual([]);
    expect(r.levels.l2.notAnalysed).toEqual(['pnpm-lock.yaml (lockfile)']);
  });

  it('returns null for unusable shapes', () => {
    expect(checkLevels(null, files)).toBeNull();
    expect(checkLevels({ ...good(), l1: { userVisible: 'yes', bullets: [] } }, files)).toBeNull();
  });

  it('flags and repairs over-limit L1-L3 output; repaired output is itself valid', () => {
    const g = good();
    g.l1.bullets = [w(30), w(30), w(30), w(30)];
    g.l2.items = Array.from({ length: 10 }, () => ({ path: 'a.ts', role: 'r', change: w(40) }));
    g.l3.annotations = Array.from({ length: 12 }, () => ({ path: 'a.ts', side: 'new' as const, startLine: 2, endLine: 2, note: w(50) }));
    const r = checkLevels(g, files)!;
    expect(r.violations.length).toBeGreaterThanOrEqual(4);
    const again = checkLevels(r.levels, files)!;
    expect(again.violations).toEqual([]);
    expect(r.levels.l2.items).toHaveLength(8);
    expect(r.levels.l3.annotations).toHaveLength(10);
  });

  it('flags an over-limit L0 but never cuts it mid-sentence (DIG-94)', () => {
    const g = good();
    g.l0.text = w(30);
    const r = checkLevels(g, files)!;
    expect(r.violations).toContain('l0: 30 words, limit 20');
    // Kept whole, not word/char-truncated with a trailing ellipsis: a headline is never a fragment.
    expect(r.levels.l0.text).toBe(w(30));
    expect(r.levels.l0.text.endsWith('…')).toBe(false);
  });

  it('accepts L0-L3 up to the DIG-94 tolerance band with a length note, not a violation', () => {
    const g = good();
    g.l0.text = w(24);
    g.l1.bullets = [w(40), w(30)];
    g.l3.annotations[0]!.note = w(36);
    const r = checkLevels(g, files)!;
    expect(r.violations).toEqual([]);
    expect(r.lengthNotes).toEqual(['l0: 24 words, target 20', 'l1: 70 words, target 60', 'l3: annotation 0 has 36 words, target 30']);
    expect(r.levels.l3.annotations[0]!.note).toBe(w(36));
  });

  it('cuts an L3 note past the band at a sentence boundary (DIG-94)', () => {
    const g = good();
    const first = 'withRetry now wraps the PUT, so a 503 from the server is retried with backoff before the upload gives up on the file.';
    g.l3.annotations[0]!.note = `${first} The base delay of 200 ms and the cap of ten retries both come from the new config defaults added in this change.`;
    const r = checkLevels(g, files)!;
    expect(r.violations).toEqual([expect.stringMatching(/^l3: annotation 0 has \d+ words, limit 30$/)]);
    expect(r.levels.l3.annotations[0]!.note).toBe(first);
  });

  it('drops anchors that do not exist in the diff or point at filtered files', () => {
    const g = good();
    g.l3.annotations = [
      { path: 'a.ts', side: 'new', startLine: 2, endLine: 99, note: 'x' },
      { path: 'a.ts', side: 'old', startLine: 3, endLine: 3, note: 'new-only line on the old side' },
      { path: 'pnpm-lock.yaml', side: 'new', startLine: 1, endLine: 1, note: 'x' },
      { path: 'a.ts', side: 'old', startLine: 2, endLine: 2, note: 'removed line' },
    ];
    const r = checkLevels(g, files)!;
    expect(r.violations).toHaveLength(3);
    expect(r.levels.l3.annotations.map((a) => a.note)).toEqual(['removed line']);
  });

  it('enforces the no-user-visible-change convention, single-sentence L0 and no HTML/links', () => {
    const g = good();
    g.l1 = { userVisible: false, bullets: ['Internal refactor.'] };
    g.l0.text = 'Fixes it. Also does more.';
    g.l2.items[0]!.change = 'see <b>x</b> https://evil.example/x';
    const r = checkLevels(g, files)!;
    expect(r.violations).toEqual(expect.arrayContaining([
      expect.stringContaining('No user-visible change'),
      expect.stringContaining('more than one sentence'),
      expect.stringContaining('HTML or a link'),
    ]));
    expect(r.levels.l1.bullets[0]).toBe('No user-visible change');
    expect(r.levels.l2.items[0]!.change).not.toMatch(/[<>]|https?:/);
  });

  it('rejects file names and identifiers in L0', () => {
    const g = good();
    g.l0.text = 'Updates `parse()` in a.ts.';
    expect(checkLevels(g, files)!.violations).toContain('l0: mentions a file name or code identifier');
  });
});

describe('markup check', () => {
  it('flags real HTML tags and links, but keeps generics and JSX components in prose about code', () => {
    expect(hasUnsafeMarkup('see <b>this</b>')).toBe(true);
    expect(hasUnsafeMarkup('<script>alert(1)</script>')).toBe(true);
    expect(hasUnsafeMarkup('<a href="x">x</a>')).toBe(true);
    expect(hasUnsafeMarkup('see https://example.com')).toBe(true);
    expect(hasUnsafeMarkup('runQueue now returns Outcome<R> records and Promise<void>.')).toBe(false);
    expect(hasUnsafeMarkup('App renders <Settings /> under /settings.')).toBe(false);
    expect(cleanText('returns Outcome<R> records')).toBe('returns Outcome<R> records');
  });
});

describe('tolerance band and sentence-boundary cuts (DIG-94)', () => {
  it('tolerates a quarter over each limit, rounded up', () => {
    expect(LENGTH_TOLERANCE).toBe(1.25);
    expect([8, 20, 30, 60, 70].map(tolerated)).toEqual([10, 25, 38, 75, 88]);
  });

  it('fitProse keeps whole sentences and only word-cuts a single over-long sentence', () => {
    expect(fitProse('One two three. Four five six. Seven eight.', 6, 100)).toBe('One two three. Four five six.');
    expect(fitProse('Use e.g. config.ts first. Then more words here.', 5, 100)).toBe('Use e.g. config.ts first.');
    expect(fitProse('One two three four five six.', 4, 100)).toBe('One two three four…');
    expect(fitProse('Short.', 4, 100)).toBe('Short.');
    expect(fitProse('가나다. 라마바사아자.', 10, 5)).toBe('가나다.');
  });

  it('fitBullets keeps whole bullets, cuts the next at a sentence, and drops one that has no sentence to keep', () => {
    expect(fitBullets(['a b c.', 'd e. f g h.', 'i.'], 5)).toEqual(['a b c.', 'd e.']);
    expect(fitBullets(['a b c.', 'd e f g.'], 5)).toEqual(['a b c.']);
    expect(fitBullets(['a b c d e f g.'], 5)).toEqual(['a b c d e…']);
  });
});
