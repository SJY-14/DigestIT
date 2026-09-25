import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchMetrics, fetchUnits, fetchWindow,
  type Metrics, type WindowDigest, type WorkUnitSummary,
} from './api.js';
import { appendShown, mergePages, pendingChanges, snapshot, type Shown, visibleUnits } from './feed.js';
import { startLive, type Transport } from './liveClient.js';

/**
 * Work units, the last-hour digest and metrics for one repo, kept fresh through /api/stream
 * (30 s polling as fallback). Fresh data never reorders what is on screen: rows update in place,
 * and units that appeared or moved wait behind `newCount` until `showNew()`.
 */
export function useLive(repoId: number | null) {
  const [first, setFirst] = useState<WorkUnitSummary[] | null>(null);
  const [tail, setTail] = useState<WorkUnitSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [digest, setDigest] = useState<WindowDigest | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [shownUnits, setShownUnits] = useState<Shown | null>(null);
  const [shownDigest, setShownDigest] = useState<Shown | null>(null);
  const [transport, setTransport] = useState<Transport>('polling');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const gen = useRef(0);
  const cursorRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (repoId === null) return;
    const g = gen.current;
    try {
      const [page, win, m] = await Promise.all([fetchUnits(repoId, null), fetchWindow('1h'), fetchMetrics()]);
      if (g !== gen.current) return;
      const inRepo = win.workUnits.filter((w) => w.repoId === repoId);
      setFirst(page.workUnits);
      if (cursorRef.current === null) {
        cursorRef.current = page.nextCursor;
        setCursor(page.nextCursor);
      }
      setDigest({ ...win, workUnits: inRepo });
      setMetrics(m);
      setShownUnits((s) => s ?? snapshot(page.workUnits));
      setShownDigest((s) => s ?? snapshot(inRepo));
      setError(null);
    } catch (e) {
      if (g === gen.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [repoId]);

  useEffect(() => {
    gen.current++;
    cursorRef.current = null;
    setFirst(null);
    setTail([]);
    setCursor(null);
    setDigest(null);
    setShownUnits(null);
    setShownDigest(null);
    if (repoId === null) return;
    void refresh();
    return startLive({ onChange: () => void refresh(), onTransport: setTransport });
  }, [repoId, refresh]);

  const loadMore = useCallback(async () => {
    const c = cursorRef.current;
    if (repoId === null || c === null || loadingMore) return;
    const g = gen.current;
    setLoadingMore(true);
    try {
      const page = await fetchUnits(repoId, c);
      if (g !== gen.current) return;
      cursorRef.current = page.nextCursor;
      setCursor(page.nextCursor);
      setTail((t) => mergePages(t, page.workUnits));
      // Appending older units below what is shown does not move anything.
      setShownUnits((s) => s && appendShown(s, page.workUnits));
    } catch (e) {
      if (g === gen.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [repoId, loadingMore]);

  const all = first ? mergePages(first, tail) : [];
  const units = shownUnits ? visibleUnits(shownUnits, all) : [];
  const digestUnits = digest && shownDigest ? visibleUnits(shownDigest, digest.workUnits) : [];
  const newCount = Math.max(
    shownUnits ? pendingChanges(shownUnits, first ?? []) : 0,
    shownDigest && digest ? pendingChanges(shownDigest, digest.workUnits) : 0,
  );

  const showNew = useCallback(() => {
    setShownUnits(snapshot(mergePages(first ?? [], tail)));
    setShownDigest(snapshot(digest?.workUnits ?? []));
  }, [first, tail, digest]);

  return {
    units, digestUnits, rollup: digest?.rollup ?? null, metrics, newCount, showNew,
    hasMore: cursor !== null, loadMore, loadingMore, transport, error, loaded: first !== null, refresh,
  };
}
