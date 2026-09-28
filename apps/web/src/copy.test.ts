import { describe, expect, it } from 'vitest';
import { humanDateTime, lineDelta, plural } from './copy.js';

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
