import { describe, expect, it } from 'vitest';
import {
  apiErrorMessage, callsLeftLabel, contextSummary, digestRowLabel, elapsedLabel, emptyCopy, explainButtonLabel, explainingLabel,
  explainOutcomeMessage, graphCopy, headerCopy, humanDateTime, levelsCopy, lineDelta, navCopy, pickerCopy, plural, readerCopy,
  resetsLabel, walkthroughCopy, type Lang,
} from './copy.js';

describe('plural', () => {
  it('never writes "(s)"', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(4, 'file')).toBe('4 files');
    expect(plural(0, 'change')).toBe('0 changes');
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
    expect(plural(1200, 'line')).toBe('1,200 lines');
  });
});

describe('humanDateTime', () => {
  const now = new Date(2026, 8, 28, 18, 0).getTime();
  it('uses Today / Yesterday, then the date', () => {
    expect(humanDateTime(new Date(2026, 8, 28, 17, 5).toISOString(), now)).toBe('Today, 17:05');
    expect(humanDateTime(new Date(2026, 8, 27, 9, 12).toISOString(), now)).toBe('Yesterday, 09:12');
    expect(humanDateTime(new Date(2026, 8, 20, 0, 30).toISOString(), now)).toBe('Sep 20, 00:30');
    expect(humanDateTime(new Date(2025, 11, 31, 8, 0).toISOString(), now)).toBe('Dec 31, 2025, 08:00');
  });
  it('returns unparsable input unchanged', () => expect(humanDateTime('nope', now)).toBe('nope'));
});

describe('lineDelta', () => {
  it('uses a real minus sign', () => expect(lineDelta(7, 3)).toBe('+7 −3'));
});

describe('explainButtonLabel', () => {
  it('shows the pending count, and a plain no-op state at zero', () => {
    expect(explainButtonLabel(12)).toBe('Explain 12 changes');
    expect(explainButtonLabel(1)).toBe('Explain 1 change');
    expect(explainButtonLabel(0)).toBe('No new changes');
  });
});

describe('emptyCopy().noDigests (DIG-57)', () => {
  it('names the project and the pending count when something changed since registration', () => {
    const nd = emptyCopy('en').noDigests('my-project', 31);
    expect(nd.heading).toBe('No explanations yet for my-project');
    expect(nd.body).toBe('31 files changed since you registered it. Press Explain above to see what happened.');
  });
  it('falls back to the generic hint at zero pending files', () => {
    const nd = emptyCopy('en').noDigests('my-project', 0);
    expect(nd.body).toBe('Work in this project with any tool, then press Explain above. Each Explain turns the changes since the last one into a digest.');
  });
  it('translates to Korean, including the project name', () => {
    const nd = emptyCopy('ko').noDigests('my-project', 31);
    expect(nd.heading).toBe('my-project에 대한 설명이 아직 없습니다');
    expect(nd.body).toContain('31개');
  });
});

describe('elapsedLabel / explainingLabel', () => {
  it('formats seconds, then minutes and seconds', () => {
    expect(elapsedLabel(0)).toBe('0s');
    expect(elapsedLabel(12)).toBe('12s');
    expect(elapsedLabel(65)).toBe('1m 05s');
    expect(elapsedLabel(600)).toBe('10m 00s');
  });
  it('prefixes with "Explaining…"', () => expect(explainingLabel(12)).toBe('Explaining… 12s'));
});

describe('callsLeftLabel / resetsLabel', () => {
  const now = new Date(2026, 8, 28, 17, 5).getTime();
  const midnight = new Date(2026, 8, 29, 0, 0).toISOString();
  it('never writes "(s)"', () => {
    expect(callsLeftLabel(35, midnight, now)).toBe('35 calls left today');
    expect(callsLeftLabel(1, midnight, now)).toBe('1 call left today');
  });
  it('says when a spent budget comes back', () => {
    expect(callsLeftLabel(0, midnight, now)).toBe('No calls left today · resets 00:00');
  });
  it('uses just the clock within a day, a date after that', () => {
    expect(resetsLabel(midnight, now)).toBe('00:00');
    expect(resetsLabel(new Date(2026, 8, 30, 9, 0).toISOString(), now)).toBe('Sep 30, 09:00');
  });
});

describe('contextSummary', () => {
  it('covers none, building, ok and error, with no raw booleans', () => {
    expect(contextSummary('none', null, null, false)).toBe('No context built yet. It is built on the first Explain.');
    expect(contextSummary('pending', null, null, false)).toBe('Building context…');
    expect(contextSummary('ok', '3 hours ago', 42, true)).toBe('Built 3 hours ago, from 42 files, with your notes');
    expect(contextSummary('ok', '3 hours ago', 1, false)).toBe('Built 3 hours ago, from 1 file');
    expect(contextSummary('error', 'yesterday', null, false)).toBe('Failed to build (last try yesterday)');
  });
});

describe('explainOutcomeMessage', () => {
  it('says what happened and, for budget, when to try again', () => {
    expect(explainOutcomeMessage('no_changes', undefined, ''))
      .toBe('Nothing changed since the last check. Work in the project with any tool, then press Explain again.');
    expect(explainOutcomeMessage('budget', undefined, '00:00'))
      .toBe('The daily budget ran out, so this digest is not explained yet. Retry it after the reset at 00:00.');
    // `detail` is already a user-facing sentence (apiErrorMessage), passed through as-is.
    expect(explainOutcomeMessage('error', 'No explanation provider is configured on this server.', ''))
      .toBe('Explain failed. No explanation provider is configured on this server. Try again, or check the server log if it keeps failing.');
    expect(explainOutcomeMessage('error', undefined, '')).toBe('Explain failed. Try again, or check the server log if it keeps failing.');
  });
});

describe('apiErrorMessage', () => {
  it('maps known server error codes to sentences', () => {
    expect(apiErrorMessage('root_not_allowed')).toBe('That folder is outside the folders this server can register.');
    expect(apiErrorMessage('bad_language')).toBe('That language is not supported.');
  });
  it('falls back to a generic message for an unmapped code, and passes through a non-code message', () => {
    expect(apiErrorMessage('some_new_error_code')).toBe('Something went wrong on the server.');
    expect(apiErrorMessage('network request failed')).toBe('network request failed');
  });
});

describe('digestRowLabel', () => {
  it('reads "<when> · <n files> · <headline>"', () => {
    const now = new Date(2026, 8, 28, 18, 0).getTime();
    const at = new Date(2026, 8, 28, 17, 5).toISOString();
    expect(digestRowLabel(at, 15, 'Adds retry to uploads', now)).toBe('Today, 17:05 · 15 files · Adds retry to uploads');
    expect(digestRowLabel(at, 1, null, now)).toBe('Today, 17:05 · 1 file · Not explained yet');
    expect(humanDateTime(at, now)).toBe('Today, 17:05');
  });
});

// --- Korean (DIG-52) ------------------------------------------------------------------------------
// `lang` is always the last parameter (after `now`, where there is one), so every call above keeps
// working with the English default. These check the `ko` branch of the same functions.

describe('Korean formatters', () => {
  const now = new Date(2026, 8, 28, 18, 0).getTime();
  const at = new Date(2026, 8, 28, 17, 5).toISOString();
  const midnight = new Date(2026, 8, 29, 0, 0).toISOString();

  it('humanDateTime / digestRowLabel', () => {
    expect(humanDateTime(at, now, 'ko')).toBe('오늘, 17:05');
    expect(humanDateTime(new Date(2026, 8, 27, 9, 12).toISOString(), now, 'ko')).toBe('어제, 09:12');
    expect(digestRowLabel(at, 15, '업로드에 재시도 추가', now, 'ko')).toBe('오늘, 17:05 · 파일 15개 · 업로드에 재시도 추가');
    expect(digestRowLabel(at, 1, null, now, 'ko')).toBe('오늘, 17:05 · 파일 1개 · 아직 설명되지 않음');
  });

  it('explainButtonLabel / elapsedLabel / explainingLabel', () => {
    expect(explainButtonLabel(12, 'ko')).toBe('변경 사항 12개 설명하기');
    expect(explainButtonLabel(0, 'ko')).toBe('새 변경 사항 없음');
    expect(elapsedLabel(65, 'ko')).toBe('1분 05초');
    expect(explainingLabel(12, 'ko')).toBe('설명 작성 중… 12초');
  });

  it('callsLeftLabel / resetsLabel', () => {
    expect(callsLeftLabel(35, midnight, now, 'ko')).toBe('오늘 남은 호출 35회');
    expect(callsLeftLabel(0, midnight, now, 'ko')).toBe('오늘 남은 호출 없음 · 00:00 초기화');
    expect(resetsLabel(midnight, now, 'ko')).toBe('00:00');
  });

  it('contextSummary / explainOutcomeMessage / apiErrorMessage', () => {
    expect(contextSummary('none', null, null, false, 'ko')).toBe('아직 빌드된 컨텍스트가 없습니다. 첫 Explain 때 만들어집니다.');
    expect(contextSummary('ok', '3시간 전', 42, true, 'ko')).toBe('3시간 전 빌드됨, 파일 42개 기준, 사용자 노트 포함');
    expect(explainOutcomeMessage('no_changes', undefined, '', 'ko'))
      .toBe('마지막 확인 이후 변경된 내용이 없습니다. 어떤 도구로든 프로젝트에서 작업한 뒤 다시 Explain을 눌러주세요.');
    expect(apiErrorMessage('bad_language', 'ko')).toBe('지원하지 않는 언어입니다.');
    expect(apiErrorMessage('some_new_error_code', 'ko')).toBe('서버에 문제가 발생했습니다.');
  });
});

/** A value's shape with every leaf reduced to its type (functions become `'fn'`), so two tables
 * can be compared structurally regardless of their actual (language-specific) text. */
function shape(v: unknown): unknown {
  if (typeof v === 'function') return 'fn';
  if (Array.isArray(v)) return v.map(shape);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = shape((v as Record<string, unknown>)[k]);
    return out;
  }
  return typeof v;
}

/** Every string leaf of `en`/`ko` (dot-path -> value), for tables with the same shape. */
function stringLeaves(v: unknown, path = ''): [string, string][] {
  if (typeof v === 'string') return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((item, i) => stringLeaves(item, `${path}[${i}]`));
  if (v !== null && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, val]) => stringLeaves(val, path ? `${path}.${k}` : k));
  }
  return [];
}

describe('every English chrome table has a matching Korean entry (DIG-52)', () => {
  const tables: [string, (lang: Lang) => unknown][] = [
    ['headerCopy', headerCopy],
    ['pickerCopy', pickerCopy],
    ['emptyCopy', emptyCopy],
    ['readerCopy', readerCopy],
    ['walkthroughCopy', walkthroughCopy],
    ['graphCopy', graphCopy],
    ['levelsCopy', levelsCopy],
    ['navCopy', navCopy],
  ];

  it.each(tables)('%s: ko has the same keys as en, and every string leaf is actually translated', (_name, table) => {
    const en = table('en');
    const ko = table('ko');
    expect(shape(ko)).toEqual(shape(en));
    const enLeaves = new Map(stringLeaves(en));
    const koLeaves = new Map(stringLeaves(ko));
    expect([...koLeaves.keys()].sort()).toEqual([...enLeaves.keys()].sort());
    for (const [path, koText] of koLeaves) {
      expect(koText.length, `${String(_name)} ${path} is empty`).toBeGreaterThan(0);
      // `key` (levelsCopy's "L0".."L3") is a level identifier shown verbatim next to the
      // translated label, not prose, so it is deliberately the same in both languages.
      if (path.endsWith('.key')) continue;
      expect(koText, `${String(_name)} ${path} was not translated`).not.toBe(enLeaves.get(path));
    }
  });
});
