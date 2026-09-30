import { describe, expect, it } from 'vitest';
import type { MemorySummarizeAreasInput, MemorySummarizeThreadInput } from './provider.js';
import {
  buildAreaSummaryPrompt, buildThreadSummaryPrompt, checkAreaSummaries, checkThreadSummary,
} from './memory-tasks.js';

const AREAS_INPUT: MemorySummarizeAreasInput = {
  repoName: 'demo',
  language: 'en',
  areas: [
    {
      path: 'packages/core/src/db', fileCount: 4, exports: ['openDb', 'migrate'], uses: [], usedBy: ['packages/explain'],
      doc: 'Owns the SQLite connection and migrations.', terms: ['openDb'],
    },
    { path: 'packages/explain/src/area', fileCount: 2, exports: ['explainArea'], uses: ['packages/core/src/db'], usedBy: [], doc: null, terms: [] },
  ],
};

describe('buildAreaSummaryPrompt', () => {
  it('lists every requested area with its own relationships and terms', () => {
    const prompt = buildAreaSummaryPrompt(AREAS_INPUT);
    expect(prompt).toContain('packages/core/src/db');
    expect(prompt).toContain('packages/explain/src/area');
    expect(prompt).toContain('openDb');
    expect(prompt).toContain('<areas repo="demo">');
  });

  it('includes retry feedback when given', () => {
    const prompt = buildAreaSummaryPrompt({ ...AREAS_INPUT, retryFeedback: ['areas: packages/core/src/db summary is empty'] });
    expect(prompt).toContain('rejected for these reasons');
    expect(prompt).toContain('summary is empty');
  });
});

describe('checkAreaSummaries', () => {
  const validReply = {
    areas: [
      { path: 'packages/core/src/db', summary: 'Owns the SQLite connection and runs migrations for the whole app.', terms: [{ term: 'openDb', meaning: 'Opens the shared SQLite connection.' }] },
      { path: 'packages/explain/src/area', summary: 'Builds the L3 walkthrough for one area of a digest.', terms: [] },
    ],
  };

  it('accepts a reply covering every requested area with only its own terms', () => {
    const r = checkAreaSummaries(validReply, AREAS_INPUT);
    expect(r).not.toBeNull();
    expect(r!.violations).toEqual([]);
    expect(r!.areas).toHaveLength(2);
    expect(r!.areas[0]!.terms).toEqual([{ term: 'openDb', meaning: 'Opens the shared SQLite connection.' }]);
  });

  it('rejects an area path that was never requested', () => {
    const r = checkAreaSummaries({ areas: [{ path: 'made/up', summary: 'Something.', terms: [] }] }, AREAS_INPUT);
    expect(r).not.toBeNull();
    expect(r!.violations.some((v) => v.includes('not one of the requested areas'))).toBe(true);
    expect(r!.areas).toHaveLength(0);
  });

  it('rejects a term that is not one of that area\'s own requested terms', () => {
    const bad = {
      areas: [
        { path: 'packages/core/src/db', summary: 'Owns the SQLite connection and runs migrations.', terms: [{ term: 'invented', meaning: 'Made up.' }] },
        { path: 'packages/explain/src/area', summary: 'Builds the L3 walkthrough for one area of a digest.', terms: [] },
      ],
    };
    const r = checkAreaSummaries(bad, AREAS_INPUT);
    expect(r).not.toBeNull();
    expect(r!.violations.some((v) => v.includes('not one of its requested terms'))).toBe(true);
  });

  it('flags a missing summary for a requested area', () => {
    const r = checkAreaSummaries({ areas: [validReply.areas[0]] }, AREAS_INPUT);
    expect(r).not.toBeNull();
    expect(r!.violations.some((v) => v.includes('no summary for'))).toBe(true);
  });

  it('returns null for an unusable shape', () => {
    expect(checkAreaSummaries({ nope: true }, AREAS_INPUT)).toBeNull();
  });
});

const THREAD_INPUT: MemorySummarizeThreadInput = {
  repoName: 'demo',
  title: 'Retry/dedupe work',
  areas: ['packages/explain/src/digest'],
  terms: ['explainDigest'],
  digests: [
    { at: '2026-09-28T10:00:00.000Z', l0: 'Retries now log why they fired.' },
    { at: '2026-09-29T10:00:00.000Z', l0: 'L0 no longer truncates mid-sentence.' },
  ],
  language: 'en',
};

describe('buildThreadSummaryPrompt', () => {
  it('lists the thread title and every digest so far, oldest first', () => {
    const prompt = buildThreadSummaryPrompt(THREAD_INPUT);
    const first = prompt.indexOf('Retries now log why they fired.');
    const second = prompt.indexOf('L0 no longer truncates mid-sentence.');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });
});

describe('checkThreadSummary', () => {
  it('accepts a short summary', () => {
    const r = checkThreadSummary({ summary: 'Cleans up retry logging and stops L0 from truncating mid-sentence.' }, 'en');
    expect(r).not.toBeNull();
    expect(r!.violations).toEqual([]);
  });

  it('flags an empty summary', () => {
    const r = checkThreadSummary({ summary: '' }, 'en');
    expect(r).not.toBeNull();
    expect(r!.violations).toContain('summary: empty');
  });

  it('returns null for an unusable shape', () => {
    expect(checkThreadSummary({ text: 'wrong key' }, 'en')).toBeNull();
  });
});
