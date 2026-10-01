import { describe, expect, it } from 'vitest';
import { applyTheme, loadTheme, parseTheme, saveTheme } from './theme.js';

describe('theme', () => {
  it('parses only the three valid choices', () => {
    expect(parseTheme('system')).toBe('system');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('auto')).toBeNull();
    expect(parseTheme(undefined)).toBeNull();
  });

  it('round-trips through storage and tolerates junk, defaulting to system', () => {
    const m = new Map<string, string>();
    const s = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
    expect(loadTheme(s)).toBe('system');
    saveTheme('dark', s);
    expect(loadTheme(s)).toBe('dark');
    saveTheme('light', s);
    expect(loadTheme(s)).toBe('light');
    // Choosing "system" again clears the key rather than writing the literal string, so a later
    // OS-level prefers-color-scheme change is picked up with nothing left to override it.
    saveTheme('system', s);
    expect(m.has('digestit.theme')).toBe(false);
    expect(loadTheme(s)).toBe('system');
    m.set('digestit.theme', 'sepia');
    expect(loadTheme(s)).toBe('system');
  });

  it('never throws when storage access itself throws (private mode/quota)', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(loadTheme(throwing)).toBe('system');
    expect(() => saveTheme('dark', throwing)).not.toThrow();
  });

  it('sets or removes the data-theme attribute, "system" removing it so prefers-color-scheme decides', () => {
    const calls: string[] = [];
    const root = {
      setAttribute: (n: string, v: string) => calls.push(`set:${n}=${v}`),
      removeAttribute: (n: string) => calls.push(`remove:${n}`),
    };
    applyTheme('dark', root);
    applyTheme('light', root);
    applyTheme('system', root);
    expect(calls).toEqual(['set:data-theme=dark', 'set:data-theme=light', 'remove:data-theme']);
  });
});
