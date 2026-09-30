import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenedVia } from './api.js';
import { levelForKey, loadLevel, saveLevel, stepForKey } from './level.js';
import { Panel } from './Panel.js';
import { commitLabel, formatDate, relativeTime, shortSha } from './format.js';
import { renderProse } from './prose.js';
import { navCopy, plural, type Lang } from './copy.js';
import { fetchProjects } from './v2Api.js';
import { Graph } from './Graph.js';
import { useTimeline } from './useTimeline.js';
import { useLive } from './useLive.js';
import { reviewStates } from './feed.js';
import { Insights } from './Insights.js';
import { MainV2 } from './MainV2.js';
import { NewPill, Rollup, UnitList, UnitPanel } from './Units.js';
import type { Level, WorkUnitMember, WorkUnitSummary } from './api.js';

const UNIT_HASH = '#unit=';
// 'main' is the v2 home screen (DIG-40); the pre-v2 commit timeline, work units, briefing and
// insights pages stay at their own paths, moved under the "History" menu (DIG-40 scope).
type Page = 'main' | 'units' | 'timeline' | 'briefing' | 'insights';
const PATH_FOR: Record<Page, string> = { main: '/', units: '/units', timeline: '/timeline', briefing: '/briefing', insights: '/insights' };
const HISTORY_PAGES = ['units', 'timeline', 'briefing', 'insights'] as const;
const HISTORY_DESC_KEY = {
  units: 'unitsDesc', timeline: 'timelineDesc', briefing: 'briefingDesc', insights: 'insightsDesc',
} as const satisfies Record<(typeof HISTORY_PAGES)[number], keyof ReturnType<typeof navCopy>>;

function pageFor(path: string): Page {
  switch (path.replace(/\/+$/, '')) {
    case '/units': return 'units';
    case '/timeline': return 'timeline';
    case '/briefing': return 'briefing';
    case '/insights':
    case '/metrics': return 'insights';
    default: return 'main';
  }
}

function usePage(): [Page, (p: Page) => void] {
  const [page, setPageRaw] = useState<Page>(() => {
    const p = pageFor(location.pathname);
    // A bare commit-sha hash with no explicit path (an old-style deep link) opens the timeline.
    return p === 'main' && location.hash.length > 1 && !location.hash.startsWith(UNIT_HASH) ? 'timeline' : p;
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
  // The v2 main screen keeps its state in the query (?project=&digest=&node=&area=). Remember it
  // when leaving so Home returns to the same project/digest instead of the first project.
  const mainSearch = useRef(page === 'main' ? location.search : '');
  return [page, (p) => {
    if (pageFor(location.pathname) === 'main') mainSearch.current = location.search;
    history.pushState(null, '', PATH_FOR[p] + (p === 'main' ? mainSearch.current : ''));
    // Unlike a full navigation, pushState doesn't reset scroll: without this, switching tabs
    // while scrolled down on one page (e.g. a tall main-screen digest) lands the new page's
    // viewport at the same offset, which can scroll straight past its list and look empty/hidden.
    window.scrollTo(0, 0);
    setPageRaw(p);
  }];
}

export function App() {
  const { repos, repoId, setRepoId, rows, done, loading, error, loadMore } = useTimeline();
  const [page, setPage] = usePage();
  // The chrome's language (DIG-60). On Home, MainV2 reports the current project's language via
  // `onLanguage`. A History page shows a repo of its own (`repoId`), which may be the first page
  // opened this session, so it looks that repo up in the existing v2 projects list: `repoId` and a
  // v2 project's id are the same underlying row (see `findProjectRow`, apps/server/src/v2.ts). If
  // that fetch fails, the last-known value (or the 'en' default) stays.
  const [lang, setLang] = useState<Lang>('en');
  const onLanguage = useCallback((l: Lang) => setLang(l), []);
  // The page's language follows the chrome's, so screen readers pronounce Korean as Korean and
  // the stylesheet's `:lang(ko)` rules (word-break: keep-all) apply.
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => {
    if (page === 'main' || repoId === null) return;
    const ac = new AbortController();
    fetchProjects(ac.signal).then(
      (projects) => {
        const p = projects.find((pr) => pr.id === repoId);
        if (p) setLang(p.language);
      },
      () => undefined,
    );
    return () => ac.abort();
  }, [page, repoId]);
  const live = useLive(repoId);
  const reviews = reviewStates(live.metrics);
  const [selectedUnitId, setSelectedUnitId] = useState<number | null>(null);
  // A unit drilled into from a chart may not be on the live list's first page; keep the summary
  // DrillList already fetched as a fallback so the panel still opens and `opened` still fires.
  const [fallbackUnit, setFallbackUnit] = useState<WorkUnitSummary | null>(null);
  const [member, setMember] = useState<WorkUnitMember | null>(null);
  const [via, setVia] = useState<OpenedVia | undefined>(undefined);
  const [selected, setSelectedRaw] = useState<string | null>(() => (location.hash.startsWith(UNIT_HASH) ? null : location.hash.slice(1) || null));
  const setSelected = useCallback((sha: string | null) => {
    setSelectedRaw(sha);
    if (sha) {
      setSelectedUnitId(null);
      setFallbackUnit(null);
      setMember(null);
      setVia(undefined);
    }
  }, []);
  const closeAll = () => {
    setSelectedRaw(null);
    setSelectedUnitId(null);
    setFallbackUnit(null);
    setMember(null);
    setVia(undefined);
  };
  const selectUnit = useCallback((u: WorkUnitSummary, v?: OpenedVia) => {
    setSelectedRaw(null);
    setMember(null);
    setSelectedUnitId(u.id);
    setFallbackUnit(u);
    setVia(v);
  }, []);
  const openMember = useCallback((m: WorkUnitMember, v?: OpenedVia) => {
    setSelectedRaw(null);
    setSelectedUnitId(null);
    setFallbackUnit(null);
    setMember(m);
    setVia(v);
  }, []);
  const selectedUnit =
    live.units.find((u) => u.id === selectedUnitId) ??
    live.digestUnits.find((u) => u.id === selectedUnitId) ??
    (fallbackUnit?.id === selectedUnitId ? fallbackUnit : null);
  const initialHash = useRef(location.hash).current;
  const restored = useRef(!initialHash.startsWith(UNIT_HASH));
  const anySelected = Boolean(selected || selectedUnit || member);
  const showsPanel = page !== 'briefing' && page !== 'main';
  const [level, setLevelState] = useState<Level>(() => loadLevel());
  const setLevel = useCallback((l: Level) => {
    setLevelState(l);
    saveLevel(l);
  }, []);
  const sentinel = useRef<HTMLDivElement>(null);
  const historyMenu = useRef<HTMLDetailsElement>(null);
  const closeHistoryMenu = useCallback(() => historyMenu.current?.removeAttribute('open'), []);

  // The History dropdown is a <details>: close it on an outside click or Escape, like a menu.
  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (historyMenu.current?.open && !historyMenu.current.contains(e.target as Node)) closeHistoryMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeHistoryMenu(); };
    document.addEventListener('click', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [closeHistoryMenu]);

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
  const T = navCopy(lang);

  return (
    <div className={page === 'main' ? 'app with-panel home' : anySelected && showsPanel ? 'app with-panel' : 'app'}>
      <header className="top">
        <h1>DigestIT</h1>
        {page !== 'main' && repos.length > 1 && (
          <select aria-label="Repository" value={repoId ?? ''} onChange={(e) => setRepoId(Number(e.target.value))}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        {page !== 'main' && repos.length === 1 && <span className="repo-name">{repos[0]?.name}</span>}
        <nav className="nav" aria-label={T.pagesLabel}>
          <a href={PATH_FOR.main} aria-current={page === 'main' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setPage('main'); }}>
            {T.home}
          </a>
          <details className="history-menu" ref={historyMenu}>
            <summary>{T.history}</summary>
            <div className="history-menu-list" role="menu" aria-label={T.otherViews}>
              <span className="history-menu-label" aria-hidden="true">{T.otherViews}</span>
              {HISTORY_PAGES.map((p) => (
                <a
                  key={p}
                  href={PATH_FOR[p]}
                  role="menuitem"
                  aria-current={page === p ? 'page' : undefined}
                  onClick={(e) => { e.preventDefault(); closeHistoryMenu(); setPage(p); }}
                >
                  <span className="menu-item-label">{T[p]}</span>
                  <span className="menu-item-desc">{T[HISTORY_DESC_KEY[p]]}</span>
                </a>
              ))}
            </div>
          </details>
        </nav>
        {page !== 'main' && (
          <span className="conn muted" title={live.transport === 'live' ? 'Live updates' : 'Live stream unavailable; refreshing every 30 s'}>
            {live.transport === 'live' ? 'Live' : 'Polling'}
          </span>
        )}
      </header>
      {page === 'main' ? (
        <MainV2 onLanguage={onLanguage} />
      ) : !showsPanel ? (
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
                <span className="count">{plural(live.digestUnits.length, 'unit')} moved</span>
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
                          {plural(c.stats.files, 'file')}{' '}
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
          title={renderProse(commitLabel(selectedRow).text)}
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
