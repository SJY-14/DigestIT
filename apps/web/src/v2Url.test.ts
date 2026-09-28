import { describe, expect, it } from 'vitest';
import { buildV2Url, EMPTY_V2_URL, parseV2Url } from './v2Url.js';

describe('parseV2Url', () => {
  it('parses every param', () => {
    expect(parseV2Url('?project=3&digest=41&level=3&area=api&step=2&node=f%3Asrc%2Findex.ts')).toEqual({
      project: 3, digest: 41, level: 3, area: 'api', step: 2, node: 'f:src/index.ts',
    });
  });
  it('defaults missing or invalid params to null', () => {
    expect(parseV2Url('')).toEqual(EMPTY_V2_URL);
    expect(parseV2Url('?project=nope&level=7&step=0')).toEqual(EMPTY_V2_URL);
    expect(parseV2Url('?level=&step=-1')).toEqual(EMPTY_V2_URL);
    expect(parseV2Url('?level=1.5').level).toBeNull();
  });
});

describe('buildV2Url', () => {
  it('omits null fields and keeps the path bare when everything is null', () => {
    expect(buildV2Url('/', EMPTY_V2_URL)).toBe('/');
  });
  it('writes ?digest=&level=&area=&step= and round-trips through parse', () => {
    const state = { project: 1, digest: 2, level: 3 as const, area: 'graph-pane', step: 4, node: null };
    expect(buildV2Url('/', state)).toBe('/?project=1&digest=2&level=3&area=graph-pane&step=4');
    expect(parseV2Url(buildV2Url('/', state).slice(1))).toEqual(state);
    const l0 = { ...EMPTY_V2_URL, digest: 2, level: 0 as const };
    expect(parseV2Url(buildV2Url('/', l0).slice(1))).toEqual(l0);
  });
});
