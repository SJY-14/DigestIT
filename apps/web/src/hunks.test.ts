import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splitPatch, uncoveredHunks } from './hunks.js';
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

describe('uncoveredHunks', () => {
  it('lists the hunks no step references, in file then patch order', () => {
    const left = uncoveredHunks(fixtureArea.files, fixtureWalkthrough);
    expect(left.map((h) => `${h.path}#${h.hunk}`)).toEqual(['apps/web/src/ProjectGraph.tsx#3']);
  });
  it('lists every hunk when there is no walkthrough', () => {
    expect(uncoveredHunks(fixtureArea.files, null)).toHaveLength(5);
  });
});
