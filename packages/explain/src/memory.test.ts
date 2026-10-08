import { describe, expect, it } from 'vitest';
import type { AreaMemory, MemoryContent, MemoryItem, MemoryProvenance, NoteMemory, TermMemory, ThreadMemory } from '@digestit/core';
import {
  MEMORY_PROMPT_RULES, checkMemoryAgeClaims, checkMemoryClaims, checkMemoryDateClaims, checkMemoryMechanism, formatMemoryDate,
  identifiersInDiff, memoryCheckSources, memoryDateSources, relativeAge, relativeAgesIn, selectMemory, stripContinuity,
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
    expect(slice).toEqual({ items: [], text: '', tokens: 0, droppedForBudget: 0, ages: [] });
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
      'The cache keeps records in memory until the next flush.',
      'Keeps the undo history in memory.',
      'Stale entries in memory are evicted after a minute.',
      'If the key is found in memory, the request is skipped.',
      'Each request is recorded in memory and flushed on exit.',
      'Memory holds only the latest page now.',
      'Memory has to stay under 50MB.',
      'Heap memory shows a steady climb before this fix.',
      'The context in memory is rebuilt on every call.',
      'Evicts old memory entries when the cap is hit.',
      'Frees the memory block on close.',
      'Adds a cost per memory access.',
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
      '메모리에 있는 캐시 항목은 1분 뒤 지워집니다.',
      '메모리 상의 데이터를 디스크로 옮깁니다.',
      '기록은 메모리에 남고 종료 때 저장됩니다.',
      '메모리에 기록된 요청을 종료 시 내보냅니다.',
      '메모리상 캐시 크기를 제한합니다.',
      '닫을 때 메모리 블록을 해제합니다.',
    ]) {
      expect(checkMemoryMechanism([text], '', 'ko'), text).toEqual([]);
    }
  });
});

describe('MEMORY_PROMPT_RULES (DIG-118: a continuity mention fits the word limit)', () => {
  it('gives the short clause form and says it replaces part of the field rather than adding to it', () => {
    expect(MEMORY_PROMPT_RULES).toContain('continues <title> from <age>');
    expect(MEMORY_PROMPT_RULES).toMatch(/counts against the word limit/);
    expect(MEMORY_PROMPT_RULES).toMatch(/never add it on top as an extra sentence/);
  });

  it('rules out a vague continuity claim that does not name the earlier change and its age', () => {
    expect(MEMORY_PROMPT_RULES).toContain('"earlier work"');
    expect(MEMORY_PROMPT_RULES).toContain('"the previous days"');
    expect(MEMORY_PROMPT_RULES).toMatch(/if you cannot name both, do not claim continuity at all/);
  });

  it('still asks for the thread\'s own title and age, never a bare date, as in DIG-114', () => {
    expect(MEMORY_PROMPT_RULES).toContain('never a bare date');
    expect(MEMORY_PROMPT_RULES).toContain("that thread's own title and the age shown for that earlier change exactly as written there");
  });

  it('puts term names in l1 and below and keeps l0 free of identifiers (DIG-121)', () => {
    expect(MEMORY_PROMPT_RULES).toMatch(/A term in <memory> is a code identifier: it belongs in the detailed fields/);
    expect(MEMORY_PROMPT_RULES).toMatch(/never in l0, which still names no file, function or other identifier/);
  });

  it('allows no relative age but the one shown for an earlier change (DIG-121)', () => {
    expect(MEMORY_PROMPT_RULES).toContain('never any other age');
    expect(MEMORY_PROMPT_RULES).toMatch(/Name no other date, weekday or relative age/);
  });
});

// Round 3 of the memory A/B (DIG-120): the L0s the snapback story stored, which a later slice quoted
// as thread titles and entries, and the Version A sentences that copied their stale ages.
const EN_STALE = {
  backoff: 'Failed requests now retry with growing delays and surface a consistent error type, continuing the retry work from three days earlier.',
  rename: 'The retry helper is renamed and exported publicly, so developers can call retries directly, continuing the retry work from three days earlier.',
};
const KO_STALE = {
  backoff: 'HTTP 요청이 끝내 실패해도 오류 형식이 일정하고 재시도 간격이 늘어나, 3일 전 자동 재시도 작업을 이어 서버 부담을 줄입니다.',
  fourxx: '재시도 호출 옵션을 객체로 바꾸고 4xx 오류는 재시도하지 않아, 소용없는 요청 반복을 막고 3일 전 재시도 진입점 작업을 이어갑니다.',
};
const EN_10_A = 'The retry rules were only visible by reading the loop body. The comment records them at the function, continuing the retry work from three days earlier on backoff and a consistent error type.';
const KO_10_A = '`src/retry.js`의 `retryRequest` 선언 위에 JSDoc 한 줄을 추가했습니다. 로직은 건드리지 않았고, 3일 전 재시도 진입점 작업에서 넣은 4xx 규칙을 문서화합니다.';
const KO_10_A_OK = '재시도 호출 옵션을 객체로 바꾸고 4xx 오류를 재시도하지 않게 한 5일 전 작업을 이어, `maxAttempts`와 `HttpError` 규칙을 호출부가 알 수 있게 합니다.';

describe('stripContinuity (DIG-121)', () => {
  it('drops an en continuity clause and its stale age from a stored L0', () => {
    expect(stripContinuity(EN_STALE.backoff)).toBe('Failed requests now retry with growing delays and surface a consistent error type.');
    expect(stripContinuity(EN_STALE.rename)).toBe('The retry helper is renamed and exported publicly, so developers can call retries directly.');
    expect(stripContinuity("Callers can import retries from 'snapback' directly, and this continues the retry work from three days earlier."))
      .toBe("Callers can import retries from 'snapback' directly.");
    expect(stripContinuity('The comment records them at the function, continuing the retry work from three days earlier on backoff and a consistent error type.'))
      .toBe('The comment records them at the function.');
  });

  it('handles a leading clause, a sentence of its own, and a bare age (en)', () => {
    expect(stripContinuity('Continuing the retry work from 5 days earlier, failed requests now stop on client errors.'))
      .toBe('Failed requests now stop on client errors.');
    expect(stripContinuity('Retries now back off. This continues the retry work from three days earlier.')).toBe('Retries now back off.');
    expect(stripContinuity('Fixes the retry helper added two weeks earlier.')).toBe('Fixes the retry helper added.');
  });

  it('drops a ko continuity clause, mid-sentence or sentence-final', () => {
    expect(stripContinuity(KO_STALE.backoff)).toBe('HTTP 요청이 끝내 실패해도 오류 형식이 일정하고 재시도 간격이 늘어나, 서버 부담을 줄입니다.');
    expect(stripContinuity(KO_STALE.fourxx)).toBe('재시도 호출 옵션을 객체로 바꾸고 4xx 오류는 재시도하지 않아, 소용없는 요청 반복을 막습니다.');
    expect(stripContinuity('자동 재시도를 다루던 3일 전 작업을 이어, 즉시 재시도로 서버를 몰아붙이지 않게 합니다.'))
      .toBe('즉시 재시도로 서버를 몰아붙이지 않게 합니다.');
    expect(stripContinuity('실패한 요청을 줄이며 하루 전 작업을 이어갑니다.')).toBe('실패한 요청을 줄입니다.');
  });

  it('drops the age alone when a ko clause has no shape it can cut cleanly', () => {
    const out = stripContinuity('대기 시간을 없애려는 변경으로, 3일 전 재시도 진입점 작업을 이어갑니다.');
    expect(out).toBe('대기 시간을 없애려는 변경으로, 재시도 진입점 작업을 이어갑니다.');
    expect(relativeAgesIn(out)).toEqual([]);
  });

  it('leaves text with no relative age alone, including "earlier" with no count and a ko date', () => {
    const plain = 'Adds a small in-memory cache helper so repeated work with the same key can reuse its earlier result.';
    expect(stripContinuity(plain)).toBe(plain);
    expect(stripContinuity('요청마다 걸린 시간을 디버그 로그로 남겨, 느린 호출을 개발자가 바로 찾을 수 있게 합니다.'))
      .toBe('요청마다 걸린 시간을 디버그 로그로 남겨, 느린 호출을 개발자가 바로 찾을 수 있게 합니다.');
    expect(relativeAgesIn('9월 13일 전에 배포한 버전')).toEqual([]);
  });
});

describe('selectMemory: no stale ages in a thread line (DIG-121)', () => {
  const at = '2026-10-08T10:00:00.000Z';
  const enThreads = (): MemoryItem[] => [
    thread('d1', {
      title: 'The HTTP client can now automatically retry a failed request, so brief network errors no longer break a call.',
      areas: ['src'], terms: ['retryRequest'],
      digests: [
        { digestId: 1, seq: 1, at: '2026-09-24T10:00:00.000Z', l0: 'The HTTP client can now automatically retry a failed request, so brief network errors no longer break a call.' },
        { digestId: 4, seq: 2, at: '2026-09-30T10:00:00.000Z', l0: EN_STALE.rename },
      ],
    }),
    thread('d3', {
      title: EN_STALE.backoff, areas: ['src'], terms: ['HttpError'],
      digests: [{ digestId: 3, seq: 1, at: '2026-09-27T10:00:00.000Z', l0: EN_STALE.backoff }],
    }),
  ];

  it('strips the clause from the title and the latest entry, and returns the ages it computed (en)', () => {
    const slice = selectMemory(enThreads(), { ...KIND, touchedAreas: ['src'], identifiers: ['retryRequest', 'HttpError'], at }, 10_000);
    expect(slice.text).not.toMatch(/three days earlier|continuing/);
    expect(slice.text).toContain('latest "The retry helper is renamed and exported publicly, so developers can call retries directly." 8 days earlier');
    expect(slice.text).toContain('- Failed requests now retry with growing delays and surface a consistent error type. (thread; 1 earlier change; 11 days earlier)');
    expect(slice.ages).toEqual(['2 weeks earlier', '8 days earlier', '11 days earlier']);
  });

  it('does the same for ko, and for a stored summary', () => {
    const t = thread('d1', {
      title: KO_STALE.backoff, areas: ['src'], summary: '재시도 작업이 3일 전부터 이어집니다.',
      digests: [
        { digestId: 3, seq: 1, at: '2026-09-27T10:00:00.000Z', l0: KO_STALE.backoff },
        { digestId: 6, seq: 2, at: '2026-10-03T10:00:00.000Z', l0: KO_STALE.fourxx },
      ],
    }, { language: 'ko' });
    const slice = selectMemory([t], { ...KIND, language: 'ko', touchedAreas: ['src'], at }, 10_000);
    expect(relativeAgesIn(slice.text)).toEqual(['11일 전', '5일 전']);
    expect(slice.text).toContain('소용없는 요청 반복을 막습니다.');
    expect(slice.ages).toEqual(['11일 전', '5일 전']);
  });

  it('gives no ages for an empty slice', () => {
    expect(selectMemory([], { ...KIND, at }, 10_000).ages).toEqual([]);
  });
});

describe('checkMemoryAgeClaims (DIG-121)', () => {
  it('flags the round 3 en-10 Version A age, which the slice gave for no earlier change', () => {
    const v = checkMemoryAgeClaims([EN_10_A], ['2 weeks earlier', 'the day before', '11 days earlier'], '', 'en');
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('"three days earlier"');
    expect(v[0]).toContain('(date check)');
  });

  it('flags the round 3 ko-10 Version A age but accepts the one it got right', () => {
    const ages = ['2주 전', '5일 전', '8일 전', '하루 전'];
    const v = checkMemoryAgeClaims([KO_10_A, KO_10_A_OK], ages, '', 'ko');
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('"3일 전"');
  });

  it('accepts an age the slice gives, in words or digits, and the same-day and day-before forms', () => {
    expect(checkMemoryAgeClaims(['This continues the retry work from three days earlier.'], ['3 days earlier'], '', 'en')).toEqual([]);
    expect(checkMemoryAgeClaims(['It picks up the backoff work from the day before.'], ['the day before'], '', 'en')).toEqual([]);
    expect(checkMemoryAgeClaims(['같은 날 앞서 바꾼 재시도 규칙을 이어갑니다.'], ['같은 날 앞서'], '', 'ko')).toEqual([]);
    expect(checkMemoryAgeClaims(['하루 전 작업을 이어갑니다.'], ['하루 전'], '', 'ko')).toEqual([]);
  });

  it('flags a vague age and an en age in a ko reply', () => {
    expect(checkMemoryAgeClaims(['It continues the retry work from a few days earlier.'], ['3 days earlier'], '', 'en')).toHaveLength(1);
    expect(checkMemoryAgeClaims(['retry work from 2 weeks earlier를 이어갑니다.'], ['5일 전'], '', 'ko')).toHaveLength(1);
  });

  it('skips the age check when the slice gives no age, so a feature\'s own lead time is not flagged', () => {
    const slice = { items: [], text: '- `src` (area): uses none; used by `tests`', tokens: 1, droppedForBudget: 0, ages: [] };
    expect(checkMemoryClaims(['구독 만료 7일 전 알림을 보냅니다.'], memoryCheckSources(slice, []), 'ko')).toEqual([]);
    expect(checkMemoryClaims(['Users get a reminder a week before the plan expires.'], memoryCheckSources(slice, []), 'en')).toEqual([]);
  });

  it('accepts an age the diff itself contains', () => {
    const files: ProviderFile[] = [{ path: 'src/age.js', status: 'M', additions: 1, deletions: 0, patch: "+  return '3 days earlier';" }];
    const slice = { items: [], text: '- x (thread; 1 earlier change; 2 weeks earlier)', tokens: 1, droppedForBudget: 0, ages: ['2 weeks earlier'] };
    expect(checkMemoryClaims(['Ages now read "3 days earlier".'], memoryCheckSources(slice, files), 'en')).toEqual([]);
  });

  it('never takes an age from quoted text in the slice, only from the ages it gives', () => {
    const slice = {
      items: [], tokens: 1, droppedForBudget: 0, ages: ['2 weeks earlier'],
      text: `- Retry (thread; 2 earlier changes; first 2 weeks earlier; latest "${EN_STALE.rename}" 8 days earlier)`,
    };
    const v = checkMemoryClaims([EN_10_A], memoryCheckSources(slice, []), 'en');
    expect(v.some((m) => m.includes('"three days earlier"'))).toBe(true);
  });
});
