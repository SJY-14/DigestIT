import { describe, expect, it } from 'vitest';
import { buildV2Url, parseV2Url } from './v2Url.js';

describe('parseV2Url', () => {
  it('parses all four params', () => {
    expect(parseV2Url('?project=3&digest=41&node=f%3Asrc%2Findex.ts&area=api')).toEqual({
      project: 3, digest: 41, node: 'f:src/index.ts', area: 'api',
    });
  });
  it('defaults missing or non-numeric params to null', () => {
    expect(parseV2Url('')).toEqual({ project: null, digest: null, node: null, area: null });
    expect(parseV2Url('?project=nope')).toEqual({ project: null, digest: null, node: null, area: null });
  });
});

describe('buildV2Url', () => {
  it('omits null fields and keeps the path bare when everything is null', () => {
    expect(buildV2Url('/', { project: null, digest: null, node: null, area: null })).toBe('/');
  });
  it('round-trips through parse', () => {
    const state = { project: 1, digest: 2, node: 'd:apps/web', area: null };
    expect(parseV2Url(buildV2Url('/', state).slice(1))).toEqual(state);
  });
});
