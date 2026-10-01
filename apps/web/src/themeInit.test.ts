// DIG-113: the no-flash bootstrap (public/theme-init.js) runs before React, before the
// stylesheet and before any bundling, so it can't import theme.ts or be exercised through a
// component render. This evaluates the file's actual source against a fake document/localStorage,
// and separately checks index.html's script order, which is what makes "runs before first paint"
// true in a real browser.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, '..', 'public', 'theme-init.js'), 'utf8');

function run(storage: { getItem(key: string): string | null }): string | null {
  let attr: string | null = null;
  const fakeWindow = {
    localStorage: storage,
    document: { documentElement: { setAttribute: (_n: string, v: string) => { attr = v; } } },
  };
  // eslint-disable-next-line no-new-func -- evaluating the actual shipped bootstrap, not a copy
  new Function('window', 'localStorage', 'document', script)(fakeWindow, fakeWindow.localStorage, fakeWindow.document);
  return attr;
}

describe('public/theme-init.js (no-flash bootstrap)', () => {
  it('sets data-theme from a saved "light" or "dark" choice', () => {
    expect(run({ getItem: () => 'dark' })).toBe('dark');
    expect(run({ getItem: () => 'light' })).toBe('light');
  });

  it('leaves the attribute unset for "system", missing, or junk storage values', () => {
    expect(run({ getItem: () => 'system' })).toBeNull();
    expect(run({ getItem: () => null })).toBeNull();
    expect(run({ getItem: () => 'sepia' })).toBeNull();
  });

  it('never throws when storage access itself throws (private mode/quota)', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); } };
    expect(() => run(throwing)).not.toThrow();
    expect(run(throwing)).toBeNull();
  });

  it('is a classic script, not a module (a module would be deferred past first paint)', () => {
    expect(script).not.toMatch(/\bexport\b|\bimport\b/);
  });
});

describe('index.html: no-flash script order', () => {
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

  it('loads theme-init.js, with no inline script (CSP has no script-src unsafe-inline)', () => {
    expect(html).toMatch(/<script src="\/theme-init\.js"><\/script>/);
  });

  it('places theme-init.js before the app module script and any stylesheet link, so it runs first', () => {
    const initAt = html.indexOf('theme-init.js');
    const appAt = html.indexOf('/src/main.tsx');
    expect(initAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(-1);
    expect(initAt).toBeLessThan(appAt);
    const linkAt = html.search(/<link[^>]*rel=["']stylesheet["']/);
    if (linkAt !== -1) expect(initAt).toBeLessThan(linkAt);
  });
});
