import { useCallback, useEffect, useRef, useState } from 'react';
import type { DigestSummaryDto } from '@digestit/core';
import { fetchDigests } from './v2Api.js';

/** Paged digest list for the digest picker (newest first), mirroring useTimeline's cursor paging. */
export function useDigests(projectId: number | null) {
  const [items, setItems] = useState<DigestSummaryDto[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paging = useRef<{ cursor: string | null; busy: boolean; gen: number }>({ cursor: null, busy: false, gen: 0 });
  const [reloadKey, setReloadKey] = useState(0);

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
    if (projectId === null) return;
    const p = paging.current;
    p.gen++;
    p.cursor = null;
    p.busy = false;
    setItems([]);
    setDone(false);
    setError(null);
    // loadMore is recreated with the new projectId; call the fresh closure directly next tick.
  }, [projectId, reloadKey]);

  useEffect(() => {
    if (projectId !== null && items.length === 0 && !done && !error) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, items.length, done, error]);

  /** Discard the loaded pages and refetch from the start (a new digest was just created). */
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { items, done, loading, error, loadMore, reload };
}
