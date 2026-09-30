import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hunkRange, splitPatch, uncoveredHunks } from './hunks.js';
import { fixtureArea, fixtureWalkthrough } from './v2Fixtures.js';

interface VectorCase {
  name: string;
  patch: string;
  hunks: { hunk: number; header: string; oldStart: number; newStart: number; lines: string[] }[];
}
const vector = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/test-vectors/hunk-split.json'), 'utf8'),
) as { cases: VectorCase[] };

const marker = { add: '+', del: '-', ctx: ' ' } as const;

describe('splitPatch (shared vector, packages/core/test-vectors/hunk-split.json)', () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const got = splitPatch(c.patch).map((h) => ({
        hunk: h.hunk,
        header: h.header,
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines.map((l) => `${marker[l.kind as keyof typeof marker]}${l.text}`),
      }));
      expect(got).toEqual(c.hunks);
    });
  }

  it('numbers lines on both sides', () => {
    const [h] = splitPatch('@@ -10,2 +20,3 @@\n a\n+b\n-c\n+d');
    expect(h!.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([['ctx', 10, 20], ['add', null, 21], ['del', 11, null], ['add', null, 22]]);
  });
});

// Worked examples from docs/ux/dig71-step-code-mapping.md §5/§7 (rev 2): the range covers only
// `add` lines, or only `del` lines when the hunk has no adds, never context lines.
describe('hunkRange', () => {
  it('upload.js worked example: new-side range of just the added lines (12-14)', () => {
    const [h] = splitPatch([
      '@@ -10,4 +10,6 @@',
      ' ',
      ' function upload(file) {',
      '+  for (let i = 0; i <= retries; i++) {',
      '   const res = put(file);',
      '+    if (res.ok || i === retries) return res;',
      ' }',
    ].join('\n'));
    expect(hunkRange(h!)).toEqual({ side: 'new', start: 12, end: 14 });
  });

  it('cli.js worked example: a single added line reads as one line, not a 41-41 range', () => {
    const [h] = splitPatch([
      '@@ -40,1 +40,2 @@',
      " program.option('--folder <path>');",
      "+program.option('--retries <n>', 'retry count', 3);",
    ].join('\n'));
    expect(hunkRange(h!)).toEqual({ side: 'new', start: 41, end: 41 });
  });

  it('a deletion-only hunk with context on both sides: old-side range of just the deleted lines', () => {
    const [h] = splitPatch(['@@ -5,4 +5,2 @@', ' ctx before', '-first deleted', '-second deleted', ' ctx after'].join('\n'));
    expect(hunkRange(h!)).toEqual({ side: 'old', start: 6, end: 7 });
  });

  it('a pure-add hunk (no context, no deletions)', () => {
    const [h] = splitPatch(['@@ -3,0 +3,2 @@', '+added line one', '+added line two'].join('\n'));
    expect(hunkRange(h!)).toEqual({ side: 'new', start: 3, end: 4 });
  });

  it('a mixed hunk (context, a deletion and an addition): still takes the new side', () => {
    const [h] = splitPatch(['@@ -20,3 +20,3 @@', ' ctx before', '-old line', '+new line', ' ctx after'].join('\n'));
    expect(hunkRange(h!)).toEqual({ side: 'new', start: 21, end: 21 });
  });

  it('ranges within a step cannot overlap (unified-diff hunks are strictly ordered, §5)', () => {
    const hunks = splitPatch(fixtureArea.files[0]!.patch!); // graphPatch: 3 hunks, one file
    expect(hunks.length).toBeGreaterThan(1);
    const ranges = hunks.map(hunkRange);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.start).toBeGreaterThan(ranges[i - 1]!.end);
    }
  });
});

describe('uncoveredHunks', () => {
  it('lists the hunks no step references, in file then patch order', () => {
    const left = uncoveredHunks(fixtureArea.files, fixtureWalkthrough);
    expect(left.map((h) => `${h.path}#${h.hunk}`)).toEqual(['apps/web/src/ProjectGraph.tsx#3']);
  });
  it('lists every hunk when there is no walkthrough', () => {
    expect(uncoveredHunks(fixtureArea.files, null)).toHaveLength(5);
  });
});
