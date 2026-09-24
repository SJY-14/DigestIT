import { describe, expect, it } from 'vitest';
import { relativeTime } from './format.js';

describe('relativeTime', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  it('picks the largest fitting unit', () => {
    expect(relativeTime('2026-09-25T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-09-25T09:00:00Z', now)).toMatch(/3 hours ago/);
    expect(relativeTime('2026-09-22T12:00:00Z', now)).toMatch(/3 days ago/);
  });
  it('returns unparsable input unchanged', () => expect(relativeTime('nope', now)).toBe('nope'));
});
