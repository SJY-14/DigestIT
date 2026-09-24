import type { Level } from './api.js';

export const LEVELS: { level: Level; name: string; hint: string }[] = [
  { level: 0, name: 'L0', hint: 'Why' },
  { level: 1, name: 'L1', hint: 'Behavior' },
  { level: 2, name: 'L2', hint: 'Structure' },
  { level: 3, name: 'L3', hint: 'Code' },
];

const KEY = 'digestit.level';

export function parseLevel(v: unknown): Level | null {
  return v === '0' || v === '1' || v === '2' || v === '3' ? (Number(v) as Level) : null;
}

export function loadLevel(store: Pick<Storage, 'getItem'> | undefined = safeStorage()): Level {
  try {
    return parseLevel(store?.getItem(KEY)) ?? 0;
  } catch {
    return 0;
  }
}

export function saveLevel(level: Level, store: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    store?.setItem(KEY, String(level));
  } catch {
    /* storage unavailable: level still persists for the session in state */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Level for a 0–3 key press, ignoring modified keys and typing in form fields. */
export function levelForKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown }): Level | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName ?? '')) return null;
  return parseLevel(e.key);
}
