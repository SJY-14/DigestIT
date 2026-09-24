import { describe, expect, it } from 'vitest';
import { checkLevels } from './validate.js';
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

  it('flags and repairs over-limit output; repaired output is itself valid', () => {
    const g = good();
    g.l0.text = w(30);
    g.l1.bullets = [w(30), w(30), w(30), w(30)];
    g.l2.items = Array.from({ length: 10 }, () => ({ path: 'a.ts', role: 'r', change: w(40) }));
    g.l3.annotations = Array.from({ length: 12 }, () => ({ path: 'a.ts', side: 'new' as const, startLine: 2, endLine: 2, note: w(50) }));
    const r = checkLevels(g, files)!;
    expect(r.violations.length).toBeGreaterThanOrEqual(5);
    const again = checkLevels(r.levels, files)!;
    expect(again.violations).toEqual([]);
    expect(r.levels.l2.items).toHaveLength(8);
    expect(r.levels.l3.annotations).toHaveLength(10);
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
