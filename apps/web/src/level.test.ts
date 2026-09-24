import { describe, expect, it } from 'vitest';
import { levelForKey, loadLevel, parseLevel, saveLevel, stepForKey } from './level.js';

const ev = (key: string, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, target: { tagName: 'BODY' }, ...extra });

describe('level', () => {
  it('maps 0–3 keys only', () => {
    expect([...'01234a'].map((k) => levelForKey(ev(k)))).toEqual([0, 1, 2, 3, null, null]);
  });
  it('ignores modifiers and form fields', () => {
    expect(levelForKey(ev('1', { ctrlKey: true }))).toBeNull();
    expect(levelForKey(ev('1', { target: { tagName: 'SELECT' } }))).toBeNull();
  });
  it('round-trips through storage and tolerates junk', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(loadLevel(s)).toBe(0);
    saveLevel(3, s);
    expect(loadLevel(s)).toBe(3);
    m.set('digestit.level', '9');
    expect(loadLevel(s)).toBe(0);
    expect(parseLevel(undefined)).toBeNull();
  });
});

describe('stepForKey', () => {
  it('maps j/k and ignores modified keys and form fields', () => {
    expect(stepForKey(ev('j'))).toBe(1);
    expect(stepForKey(ev('k'))).toBe(-1);
    expect(stepForKey(ev('x'))).toBeNull();
    expect(stepForKey(ev('j', { ctrlKey: true }))).toBeNull();
    expect(stepForKey(ev('j', { target: { tagName: 'SELECT' } }))).toBeNull();
  });
});
