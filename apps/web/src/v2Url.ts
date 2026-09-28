// URL state for the main screen (docs/direction-v2.md §5, docs/ux-v3.md §1):
// ?project=&digest=&level=&area=&step=&node=
import { useCallback, useEffect, useState } from 'react';

/** Reading level: 0 Summary, 1 Impact, 2 Structure, 3 Code. */
export type ReadingLevel = 0 | 1 | 2 | 3;

export interface V2Url {
  project: number | null;
  digest: number | null;
  /** Null means the default (L0). */
  level: ReadingLevel | null;
  /** The L2 area opened at L3 (and highlighted in the graph). */
  area: string | null;
  /** 1-based walkthrough step of the open area. */
  step: number | null;
  /** Graph node the L2 cards are filtered to. */
  node: string | null;
}

const EMPTY: V2Url = { project: null, digest: null, level: null, area: null, step: null, node: null };

function parseIntOrNull(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function parseLevel(v: string | null): ReadingLevel | null {
  const n = parseIntOrNull(v);
  return n !== null && n >= 0 && n <= 3 ? (n as ReadingLevel) : null;
}

export function parseV2Url(search: string): V2Url {
  const q = new URLSearchParams(search);
  const step = parseIntOrNull(q.get('step'));
  return {
    project: parseIntOrNull(q.get('project')),
    digest: parseIntOrNull(q.get('digest')),
    level: parseLevel(q.get('level')),
    area: q.get('area'),
    step: step !== null && step >= 1 ? step : null,
    node: q.get('node'),
  };
}

export function buildV2Url(pathname: string, state: V2Url): string {
  const q = new URLSearchParams();
  if (state.project !== null) q.set('project', String(state.project));
  if (state.digest !== null) q.set('digest', String(state.digest));
  if (state.level !== null) q.set('level', String(state.level));
  if (state.area !== null) q.set('area', state.area);
  if (state.step !== null) q.set('step', String(state.step));
  if (state.node !== null) q.set('node', state.node);
  const s = q.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/** Reads/writes the main screen's query on `pathname`, syncing with back/forward. */
export function useV2Url(pathname: string): [V2Url, (patch: Partial<V2Url>) => void, (patch: Partial<V2Url>) => void] {
  const [state, setState] = useState<V2Url>(() => parseV2Url(location.search));
  useEffect(() => {
    const onPop = () => setState(parseV2Url(location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const apply = useCallback((patch: Partial<V2Url>, replace: boolean) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      const url = buildV2Url(pathname, next);
      if (url === `${location.pathname}${location.search}`) return next;
      if (replace) history.replaceState(null, '', url);
      else history.pushState(null, '', url);
      return next;
    });
  }, [pathname]);
  const push = useCallback((patch: Partial<V2Url>) => apply(patch, false), [apply]);
  const replace = useCallback((patch: Partial<V2Url>) => apply(patch, true), [apply]);
  return [state, push, replace];
}

export { EMPTY as EMPTY_V2_URL };
