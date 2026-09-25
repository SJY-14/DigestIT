import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenedVia } from './api.js';
import { levelForKey, loadLevel, saveLevel, stepForKey } from './level.js';
import { Panel } from './Panel.js';
import { commitLabel, formatDate, relativeTime, shortSha } from './format.js';
import { Graph } from './Graph.js';
import { useTimeline } from './useTimeline.js';
import { useLive } from './useLive.js';
import { reviewStates } from './feed.js';
import { Insights } from './Insights.js';
import { NewPill, Rollup, UnitList, UnitPanel } from './Units.js';
import type { Level, WorkUnitMember, WorkUnitSummary } from './api.js';

const UNIT_HASH = '#unit=';
type Page = 'units' | 'timeline' | 'briefing' | 'insights';
const PATH_FOR: Record<Page, string> = { units: '/', timeline: '/timeline', briefing: '/briefing', insights: '/insights' };

function pageFor(path: string): Page {
  switch (path.replace(/\/+$/, '')) {
    case '/timeline': return 'timeline';
    case '/briefing': return 'briefing';
    case '/insights':
    case '/metrics': return 'insights';
    default: return 'units';
  }
}

function usePage(): [Page, (p: Page) => void] {
  const [page, setPageRaw] = useState<Page>(() => {
    const p = pageFor(location.pathname);
    // A bare commit-sha hash with no explicit path (an old-style deep link) opens the timeline.
    return p === 'units' && location.hash.length > 1 && !location.hash.startsWith(UNIT_HASH) ? 'timeline' : p;
  });
  useEffect(() => {
    // `/metrics` is kept working as a redirect target; the URL itself moves to `/insights`.
    if (location.pathname.replace(/\/+$/, '') === '/metrics') {
      history.replaceState(null, '', '/insights' + location.search);
    }
    const on = () => setPageRaw(pageFor(location.pathname));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return [page, (p) => {
    history.pushState(null, '', PATH_FOR[p]);
    setPageRaw(p);
  }];
}

export function App() {
  const { repos, repoId, setRepoId, rows, done, loading, error, loadMore } = useTimeline();
  const [page, setPage] = usePage();
  const live = useLive(repoId);
  const reviews = reviewStates(live.metrics);
  const [selectedUnitId, setSelectedUnitId] = useState<number | null>(null);
  const [member, setMember] = useState<WorkUnitMember | null>(null);
  const [via, setVia] = useState<OpenedVia | undefined>(undefined);
  const [selected, setSelectedRaw] = useState<string | null>(() => (location.hash.startsWith(UNIT_HASH) ? null : location.hash.slice(1) || null));
  const setSelected = useCallback((sha: string | null) => {
    setSelectedRaw(sha);
    if (sha) {
      setSelectedUnitId(null);
      setMember(null);
      setVia(undefined);
    }
  }, []);
  const closeAll = () => {
    setSelectedRaw(null);
    setSelectedUnitId(null);
    setMember(null);
    setVia(undefined);
  };
  const selectUnit = useCallback((u: WorkUnitSummary, v?: OpenedVia) => {
    setSelectedRaw(null);
    setMember(null);
    setSelectedUnitId(u.id);
    setVia(v);
  }, []);
  const openMember = useCallback((m: WorkUnitMember, v?: OpenedVia) => {
    setSelectedRaw(null);
    setSelectedUnitId(null);
    setMember(m);
    setVia(v);
  }, []);
  const selectedUnit = live.units.find((u) => u.id === selectedUnitId) ?? live.digestUnits.find((u) => u.id === selectedUnitId) ?? null;
  const initialHash = useRef(location.hash).current;
  const restored = useRef(!initialHash.startsWith(UNIT_HASH));
  const anySelected = Boolean(selected || selectedUnit || member);
  const showsPanel = page !== 'briefing';
  const [level, setLevelState] = useState<Level>(() => loadLevel());
  const setLevel = useCallback((l: Level) => {
    setLevelState(l);
    saveLevel(l);
  }, []);
  const sentinel = useRef<HTMLDivElement>(null);

  // Infinite scroll: fetch the next page of commits when the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMore(), {
      rootMargin: '600px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [done, error, loadMore, rows.length, page]);

  // Keep the URL hash on the open commit or unit so a view can be linked and survives reload.
  useEffect(() => {
    const hash = selected ? `#${selected}` : selectedUnit ? `${UNIT_HASH}${selectedUnit.key}` : '';
    if (showsPanel && (hash || restored.current)) {
      history.replaceState(null, '', hash || location.pathname + location.search);
    }
  }, [selected, selectedUnit?.key, showsPanel, live.loaded]);

  // Deep link to a work unit: restore it from the hash once the list has loaded.
  useEffect(() => {
    if (restored.current || !live.loaded) return;
    restored.current = true;
    if (!initialHash.startsWith(UNIT_HASH)) return;
    const key = decodeURIComponent(initialHash.slice(UNIT_HASH.length));
    const u = live.units.find((x) => x.key === key);
    if (u) setSelectedUnitId(u.id);
  }, [live.loaded, live.units]);

  const shas = rows.map((r) => r.commit.sha);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!showsPanel) return;
      if (e.key === 'Escape') return closeAll();
      const l = levelForKey(e);
      if (l !== null && anySelected) return setLevel(l);
      const step = stepForKey(e);
      if (step === null || shas.length === 0 || page !== 'timeline') return;
      const i = selected ? shas.indexOf(selected) : -1;
      const next = shas[Math.min(shas.length - 1, Math.max(0, i === -1 ? 0 : i + step))];
      if (next) {
        setSelected(next);
        document.querySelector(`[data-sha="${next}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, setLevel, shas.join(), page, showsPanel, anySelected]);

  const selectedRow = rows.find((r) => r.commit.sha === selected)?.commit;
  const gutter = rows.reduce((m, r) => Math.max(m, r.lanes.width), 1);

  return (
    <div className={anySelected && showsPanel ? 'app with-panel' : 'app'}>
      <header className="top">
        <h1>DigestIT</h1>
        {repos.length > 1 && (
          <select aria-label="Repository" value={repoId ?? ''} onChange={(e) => setRepoId(Number(e.target.value))}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        {repos.length === 1 && <span className="repo-name">{repos[0]?.name}</span>}
        <nav className="nav" aria-label="Pages">
          {(['units', 'timeline', 'briefing', 'insights'] as const).map((p) => (
            <a
              key={p}
              href={PATH_FOR[p]}
              aria-current={page === p ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); setPage(p); }}
            >
              {p === 'units' ? 'Units' : p === 'timeline' ? 'Timeline' : p === 'briefing' ? 'Briefing' : 'Insights'}
            </a>
          ))}
        </nav>
        <span className="conn muted" title={live.transport === 'live' ? 'Live updates' : 'Live stream unavailable; refreshing every 30 s'}>
          {live.transport === 'live' ? 'Live' : 'Polling'}
        </span>
      </header>
      {!showsPanel ? (
        <main>
          <p className="muted">Daily and weekly briefings aren't available yet.</p>
        </main>
      ) : (
      <div className="split">
      <main>
        {page === 'units' && (
          <>
            <section className="box digest" aria-labelledby="digest-h">
              <h2 id="digest-h" className="box-head">Last hour
                <span className="count">{live.digestUnits.length} {live.digestUnits.length === 1 ? 'unit' : 'units'} moved</span>
                {live.metrics && live.metrics.global.unreadBacklog > 0 && <span className="badge unread">{live.metrics.global.unreadBacklog} unread</span>}
              </h2>
              {live.rollup && <Rollup content={live.rollup.content} />}
              {live.loaded && live.digestUnits.length === 0 && <p className="empty">Nothing moved in the last hour.</p>}
              <UnitList label="Units that moved in the last hour" units={live.digestUnits} reviews={reviews} compact
                selectedId={selectedUnitId} onSelect={selectUnit} onOpenCommit={openMember} />
            </section>
            <div className="viewbar">
              <span className="muted">Work units{live.units.length > 0 && ` (${live.units.length}${live.hasMore ? '+' : ''})`}</span>
              <NewPill count={live.newCount} onClick={live.showNew} />
            </div>
            {live.error && <p role="alert" className="error">Could not refresh work units: {live.error}</p>}
            <div className="box">
              <h2 className="box-head">Work units</h2>
              {live.loaded && live.units.length === 0 && <p className="empty">No work units yet. Run <code>digest watch</code>.</p>}
              <UnitList label="Work units, most recently active first" units={live.units} reviews={reviews} selectedId={selectedUnitId}
                onSelect={selectUnit} onOpenCommit={openMember} />
              {live.hasMore && <div className="sentinel"><button type="button" onClick={() => void live.loadMore()}>Load more</button></div>}
            </div>
          </>
        )}
        {page === 'timeline' && (
          <>
            {error && (
              <p role="alert" className="error">
                Could not load the timeline: {error}{' '}
                <button type="button" onClick={() => void loadMore()}>
                  Retry
                </button>
              </p>
            )}
            <div className="box">
            <h2 className="box-head">Changes{rows.length > 0 && <span className="count">{rows.length}{done ? '' : '+'}</span>}</h2>
            {done && rows.length === 0 && !error && <p className="empty">No commits ingested yet. Run <code>digest ingest</code>.</p>}
            <ol className="timeline" aria-label="Commits, newest first">
              {rows.map(({ commit: c, lanes }) => {
                const label = commitLabel(c);
                return (
                  <li key={c.sha} className="row">
                    <Graph row={lanes} isMerge={c.isMerge} width={gutter} />
                    <button
                      type="button"
                      className="commit"
                      data-sha={c.sha}
                      aria-current={selected === c.sha ? 'true' : undefined}
                      onClick={() => setSelected(c.sha)}
                    >
                      <span className="label-line">
                        <span className={label.explained ? 'label' : 'label pending'}>{label.text}</span>
                        {c.branchRefs.map((r) => (
                          <span key={r} className="ref">
                            {r}
                          </span>
                        ))}
                      </span>
                      <span className="meta">
                        <span>{c.authorName}</span>
                        <time dateTime={c.committedAt} title={formatDate(c.committedAt)}>{relativeTime(c.committedAt)}</time>
                        {c.isMerge && <span>merge</span>}
                        {!label.explained && <span>not explained</span>}
                        <span className="stats">
                          {c.stats.files} {c.stats.files === 1 ? 'file' : 'files'}{' '}
                          <span className="add">+{c.stats.additions}</span> <span className="del">−{c.stats.deletions}</span>
                        </span>
                        <code className="sha">{shortSha(c.sha)}</code>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            </div>
            <div ref={sentinel} className="sentinel" aria-live="polite">
              {loading && <span className="muted">Loading…</span>}
              {!loading && !done && !error && (
                <button type="button" onClick={() => void loadMore()}>
                  Load more
                </button>
              )}
              {done && rows.length > 0 && <span>Start of history</span>}
            </div>
            <p className="hint"><kbd>j</kbd> <kbd>k</kbd> move · <kbd>0</kbd>–<kbd>3</kbd> level · <kbd>Esc</kbd> close</p>
          </>
        )}
        {page === 'insights' && (
          <Insights metrics={live.metrics} error={live.error} reviews={reviews} onSelectUnit={selectUnit} onOpenCommit={openMember} />
        )}
      </main>
      {selectedUnit && (
        <UnitPanel unit={selectedUnit} review={reviews.get(selectedUnit.id)} level={level} onLevel={setLevel}
          onClose={closeAll} onEvent={() => void live.refresh()} via={via} />
      )}
      {!selectedUnit && member && (
        <Panel changeId={member.changeId} sha={member.sha} title={member.title} level={level} onLevel={setLevel} onClose={closeAll} />
      )}
      {!selectedUnit && !member && selectedRow && (
        <Panel
          changeId={selectedRow.changeId}
          sha={selectedRow.sha}
          title={commitLabel(selectedRow).text}
          level={level}
          onLevel={setLevel}
          onClose={() => setSelected(null)}
        />
      )}
      </div>
      )}
    </div>
  );
}
