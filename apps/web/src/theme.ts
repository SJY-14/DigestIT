// Theme preference (DIG-113): System (default, follows `prefers-color-scheme`), Light or Dark.
// Client-only persistence, the same pattern as level.ts: wrapped in try/catch, degrading to
// 'system' (nothing written, nothing read) when storage is blocked rather than throwing. The
// `data-theme` attribute this sets on <html> is what styles.css's `:root[data-theme="light"|
// "dark"]` blocks override their values off; its absence (System) leaves `prefers-color-scheme`
// in charge. `public/theme-init.js` sets the same attribute from the same storage key before this
// module (or any CSS) loads, so there is no first-paint flash; `useTheme` below just takes over
// from there, so its first effect run is a no-op repaint, not a visible change.
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'digestit.theme';

export function parseTheme(v: unknown): Theme | null {
  return v === 'system' || v === 'light' || v === 'dark' ? v : null;
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadTheme(store: Pick<Storage, 'getItem'> | undefined = safeStorage()): Theme {
  try {
    return parseTheme(store?.getItem(KEY)) ?? 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(theme: Theme, store: Pick<Storage, 'setItem' | 'removeItem'> | undefined = safeStorage()): void {
  try {
    if (theme === 'system') store?.removeItem(KEY);
    else store?.setItem(KEY, theme);
  } catch {
    // storage unavailable: the choice still applies for this session via React state
  }
}

export function applyTheme(theme: Theme, root: Pick<HTMLElement, 'setAttribute' | 'removeAttribute'> = document.documentElement): void {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** Single source of truth for the chosen theme, meant to be called once (App.tsx) and threaded
 * down to every place the control is shown (the global header and the Settings panel mirror). */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    saveTheme(t);
  }, []);
  return [theme, setTheme];
}
