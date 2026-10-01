import { describe, expect, it } from 'vitest';
import type { AreaMemory, MemoryContent, MemoryItem, MemoryProvenance, NoteMemory, TermMemory, ThreadMemory } from '@digestit/core';
import {
  checkMemoryDateClaims, checkMemoryMechanism, formatMemoryDate, identifiersInDiff, memoryDateSources, relativeAge, selectMemory,
} from './memory.js';
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
/** A term the diff uses: makes a slice specific to the change, so area lines alone are not all it has (DIG-114). */
const ANCHOR = (): MemoryItem => term('anchorTerm');
const ANCHORED = { ...KIND, identifiers: ['anchorTerm'] } as const;

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
    expect(lines[3]).toContain('(thread;');
    expect(lines[4]).toContain('src/b');
    expect(lines).toHaveLength(5);
  });

  it('never includes stale or hidden items', () => {
    const items = [
      area('src/stale', {}, { status: 'stale' }),
      area('src/hidden', {}, { status: 'hidden' }),
      area('src/active', {}),
      ANCHOR(),
    ];
    const slice = selectMemory(items, { ...ANCHORED, touchedAreas: ['src/stale', 'src/hidden', 'src/active'] }, 10_000);
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
    const slice = selectMemory([touched, neighbour, unrelated, ANCHOR()], { ...ANCHORED, touchedAreas: ['src/a'] }, 10_000);
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
    const items = [area('src/b'), area('src/a'), area('src/c'), ANCHOR()];
    const slice = selectMemory(items, { ...ANCHORED, touchedAreas: ['src/a', 'src/b', 'src/c'] }, 10_000);
    const order = slice.text.split('\n').filter((l) => l.includes('(area)')).map((l) => l.match(/src\/(\w)/)?.[1]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('selectMemory: only what is specific to this change (DIG-114)', () => {
  it('sends nothing when the slice would hold only area relationships', () => {
    const items = [area('src', { usedBy: ['tests'] }), area('tests', { uses: ['src'] })];
    const slice = selectMemory(items, { ...KIND, touchedAreas: ['src'] }, 10_000);
    expect(slice).toEqual({ items: [], text: '', tokens: 0, droppedForBudget: 0 });
  });

  it('keeps the area lines once a term the diff uses is in the slice', () => {
    const items = [area('src'), term('withRetry')];
    const slice = selectMemory(items, { ...KIND, touchedAreas: ['src'], identifiers: ['withRetry'] }, 10_000);
    expect(slice.text.split('\n')).toEqual(['- src (area): uses none; used by none', '- withRetry (term)']);
  });

  it('skips an open thread on a touched area that shares no term with the diff', () => {
    const retry = thread('t-retry', {
      title: 'Failed requests retry automatically', areas: ['src'], terms: ['withRetry', 'HttpError'],
      digests: [{ digestId: 1, seq: 1, at: '2026-09-17T10:00:00.000Z', l0: 'Failed requests retry automatically.' }],
    });
    const cacheChange = selectMemory([area('src'), retry, term('cached')], {
      ...KIND, touchedAreas: ['src'], identifiers: ['cached'], at: '2026-09-25T10:00:00.000Z',
    }, 10_000);
    expect(cacheChange.text).not.toContain('retry');
    const retryChange = selectMemory([area('src'), retry, term('HttpError')], {
      ...KIND, touchedAreas: ['src'], identifiers: ['HttpError'], at: '2026-09-25T10:00:00.000Z',
    }, 10_000);
    expect(retryChange.text).toContain('Failed requests retry automatically (thread;');
  });

  it('keeps a thread with no terms yet on area overlap alone', () => {
    const t = thread('t1', {
      title: 'README usage docs', areas: [''], terms: [],
      digests: [{ digestId: 1, seq: 1, at: '2026-09-19T10:00:00.000Z', l0: 'README usage docs.' }],
    });
    const slice = selectMemory([t], { ...KIND, touchedAreas: [''], at: '2026-09-28T10:00:00.000Z' }, 10_000);
    expect(slice.text).toContain('README usage docs (thread;');
  });
});

describe('selectMemory: how earlier work and notes are shown (DIG-114)', () => {
  const retryThread = (): MemoryItem => thread('t-retry', {
    title: 'Failed requests now retry automatically.', areas: ['src'], terms: ['withRetry'],
    digests: [
      { digestId: 1, seq: 1, at: '2026-09-17T10:00:00.000Z', l0: 'Failed requests now retry automatically.' },
      { digestId: 3, seq: 2, at: '2026-09-20T10:00:00.000Z', l0: 'Retries now back off and report HTTP errors.' },
      { digestId: 4, seq: 3, at: '2026-09-21T10:00:00.000Z', l0: 'This change itself, already threaded.' },
    ],
  });

  it('names the earlier changes by title and age relative to this change, with no date', () => {
    const slice = selectMemory([retryThread()], {
      ...KIND, touchedAreas: ['src'], identifiers: ['withRetry'], at: '2026-09-21T10:00:00.000Z',
    }, 10_000);
    expect(slice.text).toBe(
      '- Failed requests now retry automatically. (thread; 2 earlier changes; first 4 days earlier; '
      + 'latest "Retries now back off and report HTTP errors." the day before)',
    );
    expect(checkMemoryDateClaims([slice.text], '', 'en')).toEqual([]); // the slice itself names no date
  });

  it('leaves out the change being explained and skips a thread with nothing earlier', () => {
    const t = thread('t1', {
      title: 'Only this change', areas: ['src'],
      digests: [{ digestId: 9, seq: 1, at: '2026-09-21T10:00:00.000Z', l0: 'Only this change' }],
    });
    const slice = selectMemory([t, term('anchorTerm')], { ...ANCHORED, touchedAreas: ['src'], at: '2026-09-21T10:00:00.000Z' }, 10_000);
    expect(slice.text).not.toContain('Only this change');
  });

  it('labels a note that replaces a term\'s text as the user\'s note of its date', () => {
    const t = term('withRetry', { meaning: 'Retries a call.' });
    const n = note('n1', 'The backoff base is 200ms by team convention.', { kind: 'term', key: 'withRetry' }, {
      updatedAt: '2026-09-22T09:00:00.000Z',
    });
    const slice = selectMemory([t, n], { ...KIND, identifiers: ['withRetry'] }, 10_000);
    expect(slice.text).toBe('- withRetry (term) — note from the user, Tue 22 Sep: The backoff base is 200ms by team convention.');
  });

  it('labels a note on a touched area the same way, naming what it is about', () => {
    const n = note('n1', 'This area is fragile.', { kind: 'area', key: 'src/a' }, { updatedAt: '2026-09-22T09:00:00.000Z' });
    const slice = selectMemory([n], { ...KIND, touchedAreas: ['src/a'] }, 10_000);
    expect(slice.text).toBe('- note from the user, Tue 22 Sep on src/a: This area is fragile.');
  });
});

describe('relativeAge', () => {
  const at = '2026-09-30T12:00:00.000Z';
  it('counts calendar days back from the change being explained (en)', () => {
    expect(relativeAge('2026-09-30T08:00:00.000Z', at, 'en')).toBe('earlier the same day');
    expect(relativeAge('2026-09-29T08:00:00.000Z', at, 'en')).toBe('the day before');
    // 5 days and 22 hours of elapsed time, but six calendar days apart
    expect(relativeAge('2026-09-24T14:00:00.000Z', at, 'en')).toBe('6 days earlier');
    expect(relativeAge('2026-09-25T12:00:00.000Z', at, 'en')).toBe('5 days earlier');
    expect(relativeAge('2026-09-09T12:00:00.000Z', at, 'en')).toBe('3 weeks earlier');
    expect(relativeAge('2026-07-30T12:00:00.000Z', at, 'en')).toBe('2 months earlier');
  });

  it('has ko equivalents', () => {
    expect(relativeAge('2026-09-30T08:00:00.000Z', at, 'ko')).toBe('같은 날 앞서');
    expect(relativeAge('2026-09-29T08:00:00.000Z', at, 'ko')).toBe('하루 전');
    expect(relativeAge('2026-09-25T12:00:00.000Z', at, 'ko')).toBe('5일 전');
    expect(relativeAge('2026-09-09T12:00:00.000Z', at, 'ko')).toBe('3주 전');
  });
});

describe('selectMemory language', () => {
  it('sends only items in the request language or with none, preferring the language copy of a key', () => {
    const items = [
      area('src/a', { summary: 'English summary.' }, { language: 'en', pinned: true }),
      area('src/a', { summary: '한국어 요약.' }, { language: 'ko', pinned: true }),
      area('src/b', {}, { language: null, pinned: true }),
      term('onlyKo', { meaning: '한국어 뜻.' }, { language: 'ko', pinned: true }),
    ];
    const ko = selectMemory(items, { ...KIND, language: 'ko' }, 10_000);
    expect(ko.text).toContain('한국어 요약.');
    expect(ko.text).not.toContain('English summary.');
    expect(ko.text).toContain('src/b');
    const en = selectMemory(items, KIND, 10_000);
    expect(en.text).toContain('English summary.');
    expect(en.text).not.toContain('onlyKo');
  });
});

describe('selectMemory budget', () => {
  it('stops adding once the budget is reached and counts the rest as dropped', () => {
    const oneLineTokens = selectMemory([term('termA')], { ...KIND, identifiers: ['termA'] }, 10_000).tokens;
    const items = [term('termA'), term('termB'), term('termC')];
    const slice = selectMemory(items, { ...KIND, identifiers: ['termA', 'termB', 'termC'] }, oneLineTokens + 1);
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

  it('flags a bare date, a month-first date and an ISO date the slice never gave', () => {
    const slice = '- retry work (continues Tue 29 Sep) (thread): x';
    expect(checkMemoryDateClaims(['Picks up from 29 Sep.'], slice, 'en')).toEqual([]);
    expect(checkMemoryDateClaims(['Picks up from 28 Sep.'], slice, 'en')).toHaveLength(1);
    expect(checkMemoryDateClaims(['Picks up from Sep 28.'], slice, 'en')).toHaveLength(1);
    expect(checkMemoryDateClaims(['Picks up from 2026-09-28.'], slice, 'en')).toHaveLength(1);
  });

  it('does not read ordinary words as dates', () => {
    expect(checkMemoryDateClaims(['It may retry; the sun is out; mark 2 items.'], '', 'en')).toEqual([]);
  });

  it('matches whole words, so "Sat" is not found inside "saturated"', () => {
    expect(checkMemoryDateClaims(['Runs on Sat.'], 'the cache is saturated', 'en')).toHaveLength(1);
  });

  it('accepts a date the diff itself shows (memoryDateSources)', () => {
    const files: ProviderFile[] = [
      { path: 'fmt.ts', status: 'M', additions: 1, deletions: 0, patch: "+// renders 'Tue 29 Sep'", filteredReason: null },
    ];
    const sources = memoryDateSources('', files);
    expect(checkMemoryDateClaims(['`formatDate` now renders Tue 29 Sep.'], sources, 'en')).toEqual([]);
    expect(checkMemoryDateClaims(['`formatDate` now renders Tue 29 Sep.'], '', 'en')).toHaveLength(1);
  });

  it('accepts a Korean date followed by a particle, and checks English-form dates in a Korean reply', () => {
    const slice = '- 재시도 작업 (continues 9월 29일 (화)) (thread): x';
    expect(checkMemoryDateClaims(['9월 29일 (화)에 시작한 작업을 이어갑니다.'], slice, 'ko')).toEqual([]);
    expect(checkMemoryDateClaims(['9월 28일에 시작한 작업입니다.'], slice, 'ko')).toHaveLength(1);
    expect(checkMemoryDateClaims(['2026-09-28에 시작한 작업입니다.'], slice, 'ko')).toHaveLength(1);
  });

  it('checks Korean weekday mentions against the Korean slice', () => {
    const clean = checkMemoryDateClaims(['화요일부터 이어지는 작업입니다.'], '- 스레드: 화요일 계속', 'ko');
    expect(clean).toEqual([]);
    const dirty = checkMemoryDateClaims(['수요일부터 이어지는 작업입니다.'], '- 스레드: 화요일 계속', 'ko');
    expect(dirty).toHaveLength(1);
  });
});

describe('checkMemoryMechanism (DIG-114)', () => {
  it('flags the DIG-109 pair 04 wording and other ways of citing memory itself (en)', () => {
    for (const text of [
      'The 200ms convention in memory is not applied here.',
      'Memory says the team uses 200ms.',
      'According to project memory, the base is 200ms.',
      'Per memory, this continues the retry work.',
      'This matches the thread listed in memory.',
      'The <memory> block notes a 200ms base.',
    ]) {
      expect(checkMemoryMechanism([text], '', 'en'), text).toHaveLength(1);
    }
    expect(checkMemoryMechanism(['The 200ms convention in memory is not applied here.'], '', 'en')[0])
      .toMatch(/names the memory mechanism \("convention in memory"\), cite the source the way a colleague would/);
    // `explain_call.violations` joins messages with "; ", so one message must not contain it.
    expect(checkMemoryMechanism(['Memory says so.'], '', 'en')[0]).not.toContain('; ');
  });

  it('does not flag ordinary talk about code and memory (en)', () => {
    for (const text of [
      'Results are cached in memory, so a second call is free.',
      'Keeps an in-memory map keyed by URL.',
      'The cache grows without bound and may use a lot of memory.',
      "The user's note of Tue 22 Sep says the team convention is 200ms.",
    ]) {
      expect(checkMemoryMechanism([text], '', 'en'), text).toEqual([]);
    }
  });

  it('accepts a phrase the diff itself contains', () => {
    const files: ProviderFile[] = [{ path: 'docs/memory.md', status: 'M', additions: 1, deletions: 0, patch: '+The memory slice is capped per prompt.\n', filteredReason: null }];
    expect(checkMemoryMechanism(['Caps the memory slice per prompt.'], memoryDateSources('', files), 'en')).toEqual([]);
    expect(checkMemoryMechanism(['Caps the memory slice per prompt.'], '', 'en')).toHaveLength(1);
  });

  it('flags the ko equivalents and English phrases in a ko reply', () => {
    for (const text of [
      '메모리에 따르면 팀 규칙은 200ms입니다.',
      '메모리에 있는 200ms 규칙은 적용되지 않았습니다.',
      '이 규칙은 메모리에 기록되어 있습니다.',
      '프로젝트 메모리의 스레드를 이어갑니다.',
      'The convention in memory says 200ms.',
    ]) {
      expect(checkMemoryMechanism([text], '', 'ko'), text).not.toEqual([]);
    }
  });

  it('does not flag ordinary ko talk about memory', () => {
    for (const text of [
      '결과를 메모리에 저장해 두 번째 호출은 바로 반환합니다.',
      '캐시가 계속 커져 메모리를 많이 쓸 수 있습니다.',
      '9월 22일 (화)의 사용자 메모에 따르면 팀 규칙은 200ms입니다.',
    ]) {
      expect(checkMemoryMechanism([text], '', 'ko'), text).toEqual([]);
    }
  });
});
