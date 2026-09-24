import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRepos, fetchTimeline, type Repo, type TimelineCommit } from './api.js';
import { computeLanes, EMPTY_LANES, type LaneRow, type LaneState } from './lanes.js';

export interface TimelineRow {
  commit: TimelineCommit;
  lanes: LaneRow;
}

export function useTimeline() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState<number | null>(null);
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mutable paging state lives in a ref so loadMore stays stable and never double-fetches.
  const paging = useRef<{ cursor: string | null; lanes: LaneState; busy: boolean; gen: number }>({
    cursor: null,
    lanes: EMPTY_LANES,
    busy: false,
    gen: 0,
  });

  useEffect(() => {
    const ac = new AbortController();
    fetchRepos(ac.signal)
      .then((r) => {
        setRepos(r);
        setRepoId((cur) => cur ?? r[0]?.id ?? null);
        if (r.length === 0) setDone(true);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(String(e instanceof Error ? e.message : e));
      });
    return () => ac.abort();
  }, []);

  const loadMore = useCallback(async () => {
    const p = paging.current;
    if (repoId === null || p.busy) return;
    p.busy = true;
    const gen = p.gen;
    setLoading(true);
    try {
      const page = await fetchTimeline(repoId, p.cursor);
      if (gen !== p.gen) return; // repo switched meanwhile
      const { rows: laneRows, state } = computeLanes(page.commits, p.lanes);
      p.lanes = state;
      p.cursor = page.nextCursor;
      setRows((prev) => [...prev, ...page.commits.map((commit, i) => ({ commit, lanes: laneRows[i]! }))]);
      setDone(page.nextCursor === null);
      setError(null);
    } catch (e) {
      if (gen === p.gen) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (gen === p.gen) {
        p.busy = false;
        setLoading(false);
      }
    }
  }, [repoId]);

  // (Re)start when the repo changes.
  useEffect(() => {
    if (repoId === null) return;
    const p = paging.current;
    p.gen++;
    p.cursor = null;
    p.lanes = EMPTY_LANES;
    p.busy = false;
    setRows([]);
    setDone(false);
    void loadMore();
  }, [repoId, loadMore]);

  return { repos, repoId, setRepoId, rows, done, loading, error, loadMore };
}
