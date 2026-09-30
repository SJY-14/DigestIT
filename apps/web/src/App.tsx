import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMetrics, type Level, type Metrics, type OpenedVia, type WorkUnitMember, type WorkUnitSummary } from './api.js';
import { levelForKey, loadLevel, saveLevel } from './level.js';
import { Panel } from './Panel.js';
import { navCopy, type Lang } from './copy.js';
import { startLive } from './liveClient.js';
import { reviewStates } from './feed.js';
import { Insights } from './Insights.js';
import { MainV2 } from './MainV2.js';
import { UnitPanel } from './Units.js';

// 'main' is the v2 home screen (DIG-40); 'insights' is the pre-v2 chart dashboard, demoted by UX
// cycle 2's IA decision (decision-2.md §"IA decision") to a route with no primary nav entry — it
// is reachable only from the Settings panel's "Legacy insights" link, when a project has data in
// the legacy `unit_event` table. Units, Timeline and Briefing (and the History menu that held all
// four) are cut entirely; their old paths redirect to Home (see `usePage` below).
type Page = 'main' | 'insights';
const PATH_FOR: Record<Page, string> = { main: '/', insights: '/insights' };
// Deep links to the removed pages must not leave a dead entry for Back to land on, so this
// rewrites the URL with `history.replaceState`, not `pushState`.
const REDIRECT_TO_HOME = new Set(['/units', '/timeline', '/briefing']);

function pageFor(path: string): Page {
  const p = path.replace(/\/+$/, '');
  return p === '/insights' || p === '/metrics' ? 'insights' : 'main';
}

function usePage(): [Page, (p: Page) => void] {
  const [page, setPageRaw] = useState<Page>(() => pageFor(location.pathname));
  useEffect(() => {
    const path = location.pathname.replace(/\/+$/, '');
    if (REDIRECT_TO_HOME.has(path)) {
      history.replaceState(null, '', '/' + location.search);
    } else if (path === '/metrics') {
      // `/metrics` is kept working as a redirect target; the URL itself moves to `/insights`.
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
    // Unlike a full navigation, pushState doesn't reset scroll: without this, switching pages
    // while scrolled down on one (e.g. a tall main-screen digest) lands the new page's viewport
    // at the same offset, which can scroll straight past its list and look empty/hidden.
    window.scrollTo(0, 0);
    setPageRaw(p);
  }];
}

/** Metrics for the legacy Insights view, refreshed on the same live/polling channel the v2 home
 * uses for project status (`startLive`, `liveClient.ts`). Global, not per-repo: `GET /api/metrics`
 * takes no id, so unlike the removed Units/Timeline pages, Insights never needed a repo picker. */
function useInsightsMetrics(active: boolean) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    fetchMetrics().then(
      (m) => { setMetrics(m); setError(null); },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    refresh();
    return startLive({ onChange: refresh, onTransport: () => undefined });
  }, [active, refresh]);
  return { metrics, error, refresh };
}

export function App() {
  const [page, setPage] = usePage();
  // The chrome's language (DIG-60): MainV2 reports the current project's language via
  // `onLanguage` while Home is mounted. Insights has no per-project language of its own (it
  // predates DIG-52's localisation and stays English-only), so the chrome keeps whatever it last
  // learned from Home, or 'en' on a cold load straight into /insights.
  const [lang, setLang] = useState<Lang>('en');
  const onLanguage = useCallback((l: Lang) => setLang(l), []);
  // The page's language follows the chrome's, so screen readers pronounce Korean as Korean and
  // the stylesheet's `:lang(ko)` rules (word-break: keep-all) apply.
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const { metrics, error: metricsError, refresh: refreshMetrics } = useInsightsMetrics(page === 'insights');
  const reviews = reviewStates(metrics);
  // The unit or commit a chart drill opened, if any (Insights.tsx's DigestTab -> DrillList). There
  // is no full live unit list to look these up in any more (that lived in the removed useLive),
  // so the row/member DrillList already fetched is the only copy kept.
  const [openUnit, setOpenUnit] = useState<WorkUnitSummary | null>(null);
  const [member, setMember] = useState<WorkUnitMember | null>(null);
  const [via, setVia] = useState<OpenedVia | undefined>(undefined);
  const closeAll = useCallback(() => {
    setOpenUnit(null);
    setMember(null);
    setVia(undefined);
  }, []);
  const selectUnit = useCallback((u: WorkUnitSummary, v?: OpenedVia) => {
    setMember(null);
    setOpenUnit(u);
    setVia(v);
  }, []);
  const openMember = useCallback((m: WorkUnitMember, v?: OpenedVia) => {
    setOpenUnit(null);
    setMember(m);
    setVia(v);
  }, []);
  const anySelected = Boolean(openUnit || member);
  const [level, setLevelState] = useState<Level>(() => loadLevel());
  const setLevel = useCallback((l: Level) => {
    setLevelState(l);
    saveLevel(l);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (page !== 'insights') return;
      if (e.key === 'Escape') return closeAll();
      const l = levelForKey(e);
      if (l !== null && anySelected) setLevel(l);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, anySelected, closeAll, setLevel]);

  const T = navCopy(lang);

  return (
    <div className={page === 'main' ? 'app with-panel home' : anySelected ? 'app with-panel' : 'app'}>
      <header className="top">
        <h1>DigestIT</h1>
        <nav className="nav" aria-label={T.pagesLabel}>
          <a href={PATH_FOR.main} aria-current={page === 'main' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setPage('main'); }}>
            {T.home}
          </a>
        </nav>
      </header>
      {page === 'main' ? (
        <MainV2 onLanguage={onLanguage} />
      ) : (
        <div className="split">
          <main>
            <Insights metrics={metrics} error={metricsError} reviews={reviews} onSelectUnit={selectUnit} onOpenCommit={openMember} />
          </main>
          {openUnit && (
            <UnitPanel unit={openUnit} review={reviews.get(openUnit.id)} level={level} onLevel={setLevel}
              onClose={closeAll} onEvent={refreshMetrics} via={via} />
          )}
          {!openUnit && member && (
            <Panel changeId={member.changeId} sha={member.sha} title={member.title} level={level} onLevel={setLevel} onClose={closeAll} />
          )}
        </div>
      )}
    </div>
  );
}
