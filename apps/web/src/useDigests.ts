import { useCallback, useEffect, useRef, useState } from 'react';
import type { DigestSummaryDto } from '@digestit/core';
import { fetchDigests } from './v2Api.js';

/** Paged digest list for the digest picker (newest first): a cursor-paged list, newest page first. */
export function useDigests(projectId: number | null) {
  const [items, setItems] = useState<DigestSummaryDto[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paging = useRef<{ cursor: string | null; busy: boolean; gen: number }>({ cursor: null, busy: false, gen: 0 });
  const [reloadKey, setReloadKey] = useState(0);

  // Reset synchronously during render (not in an effect) when `projectId`/`reloadKey` changes, so
  // no consumer ever reads a stale item list left over from the previous project. An effect-based
  // reset lands one render too late: a caller that derives state from `items` during that extra
  // render (e.g. MainV2 picking a "current digest" from `items[0]`) can latch onto a leftover
  // digest id from the old project before the reset is applied (DIG-57).
  const owner = useRef({ projectId, reloadKey });
  if (owner.current.projectId !== projectId || owner.current.reloadKey !== reloadKey) {
    owner.current = { projectId, reloadKey };
    paging.current.gen++;
    paging.current.cursor = null;
    paging.current.busy = false;
    if (items.length > 0) setItems([]);
    if (done) setDone(false);
    if (error !== null) setError(null);
  }

  const loadMore = useCallback(async () => {
    const p = paging.current;
    if (projectId === null || p.busy || done) return;
    p.busy = true;
    const gen = p.gen;
    setLoading(true);
    try {
      const page = await fetchDigests(projectId, p.cursor);
      if (gen !== p.gen) return;
      p.cursor = page.nextCursor;
      setItems((prev) => [...prev, ...page.items]);
      setDone(page.nextCursor === null);
      setError(null);
    } catch (e) {
      if (gen === p.gen) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === p.gen) {
        p.busy = false;
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, done]);

  useEffect(() => {
    if (projectId !== null && items.length === 0 && !done && !error) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, items.length, done, error]);

  /** Discard the loaded pages and refetch from the start (a new digest was just created). */
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { items, done, loading, error, loadMore, reload };
}
