// URL state for the v2 main screen (docs/direction-v2.md §5): ?project=&digest=&node=&area=
import { useCallback, useEffect, useState } from 'react';

export interface V2Url {
  project: number | null;
  digest: number | null;
  node: string | null;
  area: string | null;
}

const EMPTY: V2Url = { project: null, digest: null, node: null, area: null };

function parseIntOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export function parseV2Url(search: string): V2Url {
  const q = new URLSearchParams(search);
  return {
    project: parseIntOrNull(q.get('project')),
    digest: parseIntOrNull(q.get('digest')),
    node: q.get('node'),
    area: q.get('area'),
  };
}

export function buildV2Url(pathname: string, state: V2Url): string {
  const q = new URLSearchParams();
  if (state.project !== null) q.set('project', String(state.project));
  if (state.digest !== null) q.set('digest', String(state.digest));
  if (state.node !== null) q.set('node', state.node);
  if (state.area !== null) q.set('area', state.area);
  const s = q.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/** Reads/writes `?project=&digest=&node=&area=` on `pathname`, syncing with back/forward. */
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
