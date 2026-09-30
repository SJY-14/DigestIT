import { describe, expect, it } from 'vitest';
import type { AreaMemory, MemoryContent, MemoryItem, MemoryProvenance, NoteMemory, TermMemory, ThreadMemory } from '@digestit/core';
import { checkMemoryDateClaims, formatMemoryDate, identifiersInDiff, selectMemory } from './memory.js';
import type { ProviderFile } from './provider.js';

const PROV: MemoryProvenance = { files: [], checkpointId: 1, digestIds: [], jobId: null };

let nextId = 1;
function item(kind: MemoryItem['kind'], key: string, content: MemoryContent, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: nextId++,
    repoId: 1,
    kind,
    key,
    language: 'en',
    content,
    source: 'code',
    status: 'active',
    pinned: false,
    provenance: PROV,
    confirmedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function area(path: string, opts: Partial<AreaMemory> = {}, itemOverrides: Partial<MemoryItem> = {}): MemoryItem {
  const content: AreaMemory = {
    kind: 'area', path, fileCount: 3, exports: [], uses: [], usedBy: [], doc: null, summary: null, fingerprint: 'fp', ...opts,
  };
  return item('area', path, content, itemOverrides);
}

function term(name: string, opts: Partial<TermMemory> = {}, itemOverrides: Partial<MemoryItem> = {}): MemoryItem {
  const content: TermMemory = { kind: 'term', term: name, definedAt: null, meaning: null, areas: [], ...opts };
  return item('term', name, content, itemOverrides);
}

function thread(key: string, opts: Partial<ThreadMemory> = {}, itemOverrides: Partial<MemoryItem> = {}): MemoryItem {
  const content: ThreadMemory = {
    kind: 'thread', title: 'Thread', areas: [], terms: [], digests: [], state: 'open', summary: null, ...opts,
  };
  return item('thread', key, content, itemOverrides);
}

function note(key: string, text: string, target: NoteMemory['target'] = null, itemOverrides: Partial<MemoryItem> = {}): MemoryItem {
  const content: NoteMemory = { kind: 'note', text, target, origin: 'correction' };
  return item('note', key, content, itemOverrides);
}

const KIND = { kind: 'area', identifiers: [], touchedAreas: [], language: 'en' } as const;

describe('selectMemory ordering', () => {
  it('orders user notes on touched areas, then pinned, then touched areas, then diff terms, then open threads, then neighbours', () => {
    const areaA = area('src/a', { uses: ['src/b'], usedBy: [] });
    const areaB = area('src/b', { uses: [], usedBy: ['src/a'] }); // neighbour of a
    const pinnedTerm = term('PinnedThing', { meaning: 'A pinned thing.' }, { pinned: true });
    const diffTerm = term('fetchJson', { meaning: 'Fetches JSON.' });
    const openThread = thread('t1', {
      title: 'Retry work', areas: ['src/a'], state: 'open', digests: [{ digestId: 1, seq: 1, at: '2026-09-29T10:00:00.000Z', l0: 'Did a thing.' }],
    });
    const areaNote = note('n1', 'This area is fragile.', { kind: 'area', key: 'src/a' });

    const items = [areaB, diffTerm, openThread, areaNote, pinnedTerm, areaA];
    const slice = selectMemory(items, {
      touchedAreas: ['src/a'], identifiers: ['fetchJson'], kind: 'summary', language: 'en',
    }, 10_000);

    const lines = slice.text.split('\n');
    expect(lines[0]).toContain('This area is fragile.');
    expect(lines[1]).toContain('PinnedThing');
    // src/a is covered by the note (category 1) so it is not repeated in category 3.
    expect(lines[2]).toContain('fetchJson');
    expect(lines[3]).toContain('Retry work');
    expect(lines[3]).toContain('(thread)');
    expect(lines[4]).toContain('src/b');
    expect(lines).toHaveLength(5);
  });

  it('never includes stale or hidden items', () => {
    const items = [
      area('src/stale', {}, { status: 'stale' }),
      area('src/hidden', {}, { status: 'hidden' }),
      area('src/active', {}),
    ];
    const slice = selectMemory(items, { ...KIND, touchedAreas: ['src/stale', 'src/hidden', 'src/active'] }, 10_000);
    expect(slice.text).not.toContain('stale');
    expect(slice.text).not.toContain('hidden');
    expect(slice.text).toContain('src/active');
  });

  it('excludes closed threads even when they cover a touched area', () => {
    const closed = thread('t-closed', { areas: ['src/a'], state: 'closed' });
    const slice = selectMemory([closed], { ...KIND, touchedAreas: ['src/a'] }, 10_000);
    expect(slice.text).toBe('');
  });

  it('only pulls in neighbours connected to a touched area, not arbitrary areas', () => {
    const touched = area('src/a', { uses: ['src/b'], usedBy: [] });
    const neighbour = area('src/b');
    const unrelated = area('src/z');
    const slice = selectMemory([touched, neighbour, unrelated], { ...KIND, touchedAreas: ['src/a'] }, 10_000);
    expect(slice.text).toContain('src/b');
    expect(slice.text).not.toContain('src/z');
  });

  it('a user note with a target replaces that item\'s own text, without listing both', () => {
    const t = term('fetchJson', { meaning: 'The old meaning.' });
    const n = note('n1', 'Actually fetchJson also retries.', { kind: 'term', key: 'fetchJson' });
    const slice = selectMemory([t, n], { ...KIND, identifiers: ['fetchJson'] }, 10_000);
    expect(slice.text).toContain('Actually fetchJson also retries.');
    expect(slice.text).not.toContain('The old meaning.');
    // Both the note and the term it overrides are recorded as consulted.
    expect(slice.items).toHaveLength(2);
  });

  it('is deterministic: ties within a category break on key', () => {
    const items = [area('src/b'), area('src/a'), area('src/c')];
    const slice = selectMemory(items, { ...KIND, touchedAreas: ['src/a', 'src/b', 'src/c'] }, 10_000);
    const order = slice.text.split('\n').map((l) => l.match(/src\/(\w)/)?.[1]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('selectMemory budget', () => {
  it('stops adding once the budget is reached and counts the rest as dropped', () => {
    const oneLineTokens = selectMemory([area('src/a')], { ...KIND, touchedAreas: ['src/a'] }, 10_000).tokens;
    const items = [area('src/a'), area('src/b'), area('src/c')];
    const slice = selectMemory(items, { ...KIND, touchedAreas: ['src/a', 'src/b', 'src/c'] }, oneLineTokens + 1);
    expect(slice.text.split('\n')).toHaveLength(1);
    expect(slice.droppedForBudget).toBe(2);
  });

  it('drops everything when the budget is zero', () => {
    const slice = selectMemory([area('src/a')], { ...KIND, touchedAreas: ['src/a'] }, 0);
    expect(slice.text).toBe('');
    expect(slice.tokens).toBe(0);
    expect(slice.droppedForBudget).toBe(1);
    expect(slice.items).toHaveLength(0);
  });
});

describe('identifiersInDiff', () => {
  it('finds only words that match a known term', () => {
    const files: ProviderFile[] = [
      { path: 'a.ts', status: 'M', additions: 1, deletions: 0, patch: '+function fetchJson(url) { return doThing(url); }', filteredReason: null },
    ];
    expect(identifiersInDiff(files, ['fetchJson', 'unrelatedTerm'])).toEqual(['fetchJson']);
  });

  it('ignores filtered-out files with a null patch', () => {
    const files: ProviderFile[] = [{ path: 'a.bin', status: 'M', additions: 0, deletions: 0, patch: null, filteredReason: 'binary' }];
    expect(identifiersInDiff(files, ['anything'])).toEqual([]);
  });
});

describe('formatMemoryDate', () => {
  it('renders "Tue 29 Sep" in English', () => {
    expect(formatMemoryDate('2026-09-29T10:00:00.000Z', 'en')).toBe('Tue 29 Sep');
  });

  it('renders a Korean equivalent that names the same weekday', () => {
    const ko = formatMemoryDate('2026-09-29T10:00:00.000Z', 'ko');
    expect(ko).toContain('화'); // Tuesday
    expect(ko).toContain('29');
  });
});

describe('checkMemoryDateClaims', () => {
  it('is clean when the output names no weekday', () => {
    expect(checkMemoryDateClaims(['A plain sentence with no dates.'], '', 'en')).toEqual([]);
  });

  it('is clean when the weekday named in the output is also in the slice', () => {
    const slice = '- retry work (thread): continues Tue 29 Sep';
    expect(checkMemoryDateClaims(['This continues work from Tue 29 Sep.'], slice, 'en')).toEqual([]);
  });

  it('flags a weekday the output names that the slice never mentioned', () => {
    const v = checkMemoryDateClaims(['This continues work from Wed 30 Sep.'], '- retry work (thread): continues Tue 29 Sep', 'en');
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('Wed 30 Sep');
  });

  it('flags a weekday when no memory was sent at all', () => {
    const v = checkMemoryDateClaims(['This continues work from Monday.'], '', 'en');
    expect(v).toHaveLength(1);
  });

  it('checks Korean weekday mentions against the Korean slice', () => {
    const clean = checkMemoryDateClaims(['화요일부터 이어지는 작업입니다.'], '- 스레드: 화요일 계속', 'ko');
    expect(clean).toEqual([]);
    const dirty = checkMemoryDateClaims(['수요일부터 이어지는 작업입니다.'], '- 스레드: 화요일 계속', 'ko');
    expect(dirty).toHaveLength(1);
  });
});
