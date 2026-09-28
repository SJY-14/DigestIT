import { describe, expect, it } from 'vitest';
import {
  apiErrorMessage, callsLeftLabel, contextSummary, digestRowLabel, elapsedLabel, explainButtonLabel, explainingLabel,
  explainOutcomeMessage, humanDateTime, lineDelta, plural, resetsLabel,
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
