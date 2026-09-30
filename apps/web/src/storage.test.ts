// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLastSeen, getReviewed, setLastSeen, setReviewed } from './storage.js';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('last-seen digest (P6, +seq for UX cycle 2 P4)', () => {
  it('round-trips digest id, seq and time', () => {
    expect(getLastSeen(1)).toBeNull();
    setLastSeen(1, 41, 3, '2026-09-26T16:40:00Z');
    expect(getLastSeen(1)).toEqual({ digestId: 41, seq: 3, at: '2026-09-26T16:40:00Z' });
  });
  it('is keyed per project', () => {
    setLastSeen(1, 41, 3, '2026-09-26T16:40:00Z');
    setLastSeen(2, 7, 1, '2026-09-27T09:00:00Z');
    expect(getLastSeen(1)).toEqual({ digestId: 41, seq: 3, at: '2026-09-26T16:40:00Z' });
    expect(getLastSeen(2)).toEqual({ digestId: 7, seq: 1, at: '2026-09-27T09:00:00Z' });
  });
  it('defaults the timestamp to now when omitted', () => {
    const before = Date.now();
    setLastSeen(1, 41, 3);
    const after = Date.now();
    const seen = getLastSeen(1)!;
    expect(seen.digestId).toBe(41);
    expect(seen.seq).toBe(3);
    const t = new Date(seen.at).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
  it('reads an entry written before `seq` existed, with `seq` left undefined', () => {
    localStorage.setItem('digestit.lastSeen.1', JSON.stringify({ digestId: 41, at: '2026-09-26T16:40:00Z' }));
    expect(getLastSeen(1)).toEqual({ digestId: 41, at: '2026-09-26T16:40:00Z' });
    expect(getLastSeen(1)!.seq).toBeUndefined();
  });
  it('ignores a malformed stored value instead of throwing', () => {
    localStorage.setItem('digestit.lastSeen.1', '{"digestId":"not-a-number"}');
    expect(getLastSeen(1)).toBeNull();
    localStorage.setItem('digestit.lastSeen.1', 'not json at all');
    expect(getLastSeen(1)).toBeNull();
  });
  it('degrades to null/no-op when localStorage throws (private mode, quota, disabled)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked'); });
    expect(() => setLastSeen(1, 41, 3)).not.toThrow();
    expect(getLastSeen(1)).toBeNull();
  });
});

describe('reviewed mark (P5 option A)', () => {
  it('round-trips per project:digest:area and undoes', () => {
    expect(getReviewed(1, 41, 'graph-pane')).toBe(false);
    setReviewed(1, 41, 'graph-pane', true);
    expect(getReviewed(1, 41, 'graph-pane')).toBe(true);
    setReviewed(1, 41, 'graph-pane', false);
    expect(getReviewed(1, 41, 'graph-pane')).toBe(false);
  });
  it('does not mark other areas, digests or projects', () => {
    setReviewed(1, 41, 'graph-pane', true);
    expect(getReviewed(1, 41, 'area-view')).toBe(false);
    expect(getReviewed(1, 40, 'graph-pane')).toBe(false);
    expect(getReviewed(2, 41, 'graph-pane')).toBe(false);
  });
  it('degrades to false/no-op when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('blocked'); });
    expect(() => setReviewed(1, 41, 'graph-pane', true)).not.toThrow();
    expect(getReviewed(1, 41, 'graph-pane')).toBe(false);
    expect(() => setReviewed(1, 41, 'graph-pane', false)).not.toThrow();
  });
});
