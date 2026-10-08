import { describe, expect, it } from 'vitest';
import { rangeSpan, walkPatch, type DiffSide, type LineSpan, type PatchLine } from '@digestit/core/hunks';
import { renderHunks } from './difflines.js';
import { indexLineIds, lineId, parseLineId, snapCandidates, snapSpan, spanIds } from './lineids.js';

// snapback's "retry work part 3" diff of src/retry.js (one hunk), plus a second hunk that ends
// on a deletion run and a third that ends at a "\ No newline at end of file" marker.
const PATCH = [
  'diff --git a/src/retry.js b/src/retry.js',
  '--- a/src/retry.js',
  '+++ b/src/retry.js',
  '@@ -1,11 +1,12 @@',
  " import { HttpError } from './errors.js';", //            1.1  walk 4
  ' ', //                                                     1.2  walk 5
  '-export async function retryRequest(fn, times = 3, baseMs = 100) {', // 1.3  walk 6
  '-  for (let i = 0; i < times; i++) {', //                 1.4  walk 7
  '+export async function retryRequest(fn, { maxAttempts = 3, baseMs = 100 } = {}) {', // 1.5 walk 8
  '+  for (let i = 0; i < maxAttempts; i++) {', //           1.6  walk 9
  '     try {', //                                            1.7  walk 10
  '       return await fn();', //                             1.8  walk 11
  '     } catch (e) {', //                                    1.9  walk 12
  '-      if (i === times - 1) throw e instanceof HttpError ? e : new HttpError(0, e.message);', // 1.10 walk 13
  '+      const err = e instanceof HttpError ? e : new HttpError(0, e.message);', // 1.11 walk 14
  '+      if (i === maxAttempts - 1 || (err.status >= 400 && err.status < 500)) throw err;', // 1.12 walk 15
  '       await new Promise((r) => setTimeout(r, baseMs * 2 ** i));', // 1.13 walk 16
  '     }', //                                                1.14 walk 17
  '   }', //                                                  1.15 walk 18
  '@@ -30,4 +31,2 @@', //                                     walk 19
  ' a30', //                                                  2.1  walk 20
  '-gone31', //                                               2.2  walk 21
  '+kept31', //                                               2.3  walk 22
  '-gone32', //                                               2.4  walk 23
  '-gone33', //                                               2.5  walk 24
  '@@ -40,2 +40,2 @@', //                                     walk 25
  '-old40', //                                                3.1  walk 26
  '-old41', //                                                3.2  walk 27
  '+new40', //                                                3.3  walk 28
  '+new41', //                                                3.4  walk 29
  '\\ No newline at end of file', //                          walk 30
].join('\n');
const lines = walkPatch(PATCH);
const ids = indexLineIds(lines);
const at = (id: string): number => ids.index.get(id)!;
const content = (l: PatchLine): boolean => l.kind === ' ' || l.kind === '+' || l.kind === '-';

/** Round trip: what is stored (side/start/end) gives back the very span through `rangeSpan`. */
function stored(fromId: string, toId: string): { side: DiffSide; start: number; end: number; span: LineSpan } {
  const s = snapSpan(lines, at(fromId), at(toId))!;
  const back = rangeSpan(lines, s.side, s.start, s.end);
  expect(back).toEqual({ ok: true, span: s.span });
  return s;
}

describe('line IDs', () => {
  it('numbers every shown -, + and context line per hunk, and gives a "\\ No newline" marker no ID', () => {
    expect(ids.count).toEqual(new Map([[1, 15], [2, 5], [3, 4]]));
    expect(at('1.1')).toBe(4);
    expect(at('1.3')).toBe(6);
    expect(at('3.4')).toBe(29);
    expect([...ids.id.keys()]).not.toContain(30);
    expect(lines[30]!.kind).toBe('\\');
  });

  it('renders the same IDs in the prompt as the parser reads back', () => {
    const out = renderHunks(PATCH).split('\n');
    expect(out).toContain("1.1  import { HttpError } from './errors.js';");
    expect(out).toContain('1.3- export async function retryRequest(fn, times = 3, baseMs = 100) {');
    expect(out).toContain('1.5+ export async function retryRequest(fn, { maxAttempts = 3, baseMs = 100 } = {}) {');
    expect(out).toContain('3.4+ new41');
    expect(out[out.length - 1]).toBe('\\ No newline at end of file');
    for (const [id, i] of ids.index) {
      const l = lines[i]!;
      expect(out).toContain(`${id}${l.kind} ${l.text}`);
    }
  });

  it('reads only "h.n" strings: a JSON number is refused, since 2.10 would read as 2.1', () => {
    expect(parseLineId('2.7')).toEqual({ hunk: 2, n: 7 });
    expect(parseLineId(' 12.30 ')).toEqual({ hunk: 12, n: 30 });
    expect(parseLineId(2.1)).toBeNull();
    expect(parseLineId('2')).toBeNull();
    expect(parseLineId('0.1')).toBeNull();
    expect(parseLineId('2.0')).toBeNull();
    expect(parseLineId('L2.7')).toBeNull();
    expect(lineId(2, 7)).toBe('2.7');
  });
});

describe('snapSpan: line IDs to a stored LineRange', () => {
  it('stores a mixed span on the new side, exactly when rangeSpan can cut there', () => {
    expect(stored('1.7', '1.9')).toEqual({ side: 'new', start: 5, end: 7, span: { hunk: 1, from: 10, to: 12 } });
    expect(stored('1.10', '1.12')).toEqual({ side: 'new', start: 8, end: 9, span: { hunk: 1, from: 13, to: 15 } });
  });

  it('a span that starts on - lines: new side, and the replacement pull-in keeps the deletions', () => {
    // 1.3-1.4 deleted, 1.5-1.6 added: a new range from the first added line takes both deletions.
    expect(stored('1.3', '1.6')).toEqual({ side: 'new', start: 3, end: 4, span: { hunk: 1, from: 6, to: 9 } });
    // Starting inside the deletion run still keeps every named line (a superset: all of the run).
    const s = stored('1.4', '1.6');
    expect(s.span.from).toBeLessThanOrEqual(at('1.4'));
    expect(s.span.to).toBe(at('1.6'));
  });

  it('a span that starts on - lines before a context line takes the nearest new-numbered line before it', () => {
    // 1.3, 1.4 (-), 1.5, 1.6 (+), 1.7 (context): starts at 1.2 (context) on the new side.
    const s = stored('1.3', '1.7');
    expect(s.side).toBe('new');
    expect(s.span.from).toBeLessThanOrEqual(at('1.3'));
    expect(s.span.to).toBe(at('1.7'));
  });

  it('a span of only - lines: old side, exact', () => {
    expect(stored('1.3', '1.4')).toEqual({ side: 'old', start: 3, end: 4, span: { hunk: 1, from: 6, to: 7 } });
    expect(stored('1.10', '1.10')).toEqual({ side: 'old', start: 8, end: 8, span: { hunk: 1, from: 13, to: 13 } });
    expect(stored('2.4', '2.5')).toEqual({ side: 'old', start: 32, end: 33, span: { hunk: 2, from: 23, to: 24 } });
  });

  it('a mixed span ending on a deletion run at the end of its hunk falls back to the old side', () => {
    // 2.3 (+), 2.4, 2.5 (-): no new-numbered line after the run, so `new` cannot hold 2.5.
    const s = stored('2.3', '2.5');
    expect(s.side).toBe('old');
    expect(s.span.from).toBeLessThanOrEqual(at('2.3'));
    expect(s.span.to).toBe(at('2.5'));
  });

  it('a span that ends at a "\\ No newline" marker keeps the marker, both sides', () => {
    expect(stored('3.3', '3.4')).toEqual({ side: 'new', start: 40, end: 41, span: { hunk: 3, from: 26, to: 30 } });
    expect(stored('3.1', '3.4').span).toEqual({ hunk: 3, from: 26, to: 30 });
    expect(stored('3.4', '3.4').span.to).toBe(30);
  });

  it('never crosses hunks', () => {
    expect(snapSpan(lines, at('1.15'), at('2.1'))).toBeNull();
  });

  it('for every pair of lines: keeps them all, round-trips, prefers the documented side, and is the smallest such span', () => {
    // Every stored range rangeSpan can produce in this patch, per side: the candidates the rule picks from.
    const all: { side: DiffSide; span: LineSpan }[] = [];
    for (const side of ['new', 'old'] as const) {
      const nos = lines.flatMap((l) => {
        const no = side === 'new' ? (l.kind === '+' || l.kind === ' ' ? l.newNo : undefined) : (l.kind === '-' || l.kind === ' ' ? l.oldNo : undefined);
        return no === undefined ? [] : [no];
      });
      for (const a of nos) for (const b of nos) {
        if (b < a) continue;
        const r = rangeSpan(lines, side, a, b);
        if (r.ok) all.push({ side, span: r.span });
      }
    }
    const idx = lines.flatMap((l, i) => (content(l) ? [i] : []));
    let pairs = 0;
    for (const a of idx) {
      for (const b of idx) {
        if (b < a || lines[a]!.hunk !== lines[b]!.hunk) continue;
        pairs++;
        const s = snapSpan(lines, a, b);
        const hasNew = lines.slice(a, b + 1).some((l) => l.kind === '+' || l.kind === ' ');
        const holds = all.filter((c) => c.span.from <= a && c.span.to >= b);
        const preferred = hasNew ? 'new' : 'old';
        const pool = holds.some((c) => c.side === preferred) ? holds.filter((c) => c.side === preferred) : holds;
        if (pool.length === 0) {
          expect(s).toBeNull();
          continue;
        }
        expect(s).not.toBeNull();
        expect(s!.side).toBe(pool[0]!.side);
        expect(s!.span.from).toBeLessThanOrEqual(a);
        expect(s!.span.to).toBeGreaterThanOrEqual(b);
        expect(s!.span.to - s!.span.from).toBe(Math.min(...pool.map((c) => c.span.to - c.span.from)));
        expect(rangeSpan(lines, s!.side, s!.start, s!.end)).toEqual({ ok: true, span: s!.span });
      }
    }
    expect(pairs).toBeGreaterThan(100);
  });

  it('lists the other side only after the preferred one', () => {
    const c = snapCandidates(lines, at('1.7'), at('1.9'));
    expect(c[0]!.side).toBe('new');
    expect(c.some((x) => x.side === 'old')).toBe(true);
    expect(c.findIndex((x) => x.side === 'old')).toBeGreaterThan(c.findLastIndex((x) => x.side === 'new'));
  });

  it('names a span by the IDs of its first and last content line', () => {
    expect(spanIds(ids, lines, { hunk: 3, from: 26, to: 30 })).toBe('3.1-3.4');
    expect(spanIds(ids, lines, { hunk: 1, from: 13, to: 13 })).toBe('1.10');
  });
});
