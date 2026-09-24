import { describe, expect, it } from 'vitest';
import { indexPatch, numberPatch } from './difflines.js';

const patch = [
  'diff --git a/f.ts b/f.ts',
  'index 1..2 100644',
  '--- a/f.ts',
  '+++ b/f.ts',
  '@@ -3,3 +3,3 @@ ctx',
  ' keep',
  '--- looks like a header',
  '+++ so does this',
  ' tail',
  '@@ -20 +20,2 @@',
  '-gone',
  '+a',
  '+b',
  '\\ No newline at end of file',
].join('\n');

describe('difflines', () => {
  it('indexes both sides using hunk counts', () => {
    const r = indexPatch(patch);
    expect([...r.newLines]).toEqual([3, 4, 5, 20, 21]);
    expect([...r.oldLines]).toEqual([3, 4, 5, 20]);
  });

  it('numbers lines for the prompt and drops git headers', () => {
    const out = numberPatch(patch).split('\n');
    expect(out).toContain('3  keep');
    expect(out).toContain('4- -- looks like a header');
    expect(out).toContain('21+ b');
    expect(out.some((l) => l.startsWith('diff --git') || l.startsWith('index'))).toBe(false);
  });

  it('stops at a truncation marker so unseen lines are not indexed', () => {
    const cut = '@@ -1,5 +1,5 @@\n a\n b\n[... truncated to fit token budget ...]\n';
    expect([...indexPatch(cut).newLines]).toEqual([1, 2]);
  });
});
