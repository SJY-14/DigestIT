// Main screen v2 (DIG-40, docs/direction-v2.md §5): setup form, the compact project header with
// the digest picker (DIG-49, ProjectHeader.tsx / DigestPicker.tsx), and the reading pane + graph.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type {
  AboutDto, AreaDetailDto, AreaProgressEvent, CreateProjectResponseDto, DigestDetailDto, DigestSummaryDto, ExplainLanguage,
  GraphNode, ProjectDto, ProjectGraphDto, ProjectStatusDto,
} from '@digestit/core';
import {
  ApiError, addIgnorePatterns, createProject, explainArea, explainProject, fetchAbout, fetchArea, fetchDigest, fetchGraph,
  fetchProjectGraph, fetchProjectStatus, fetchProjects, openDigestEvents, refreshContext, retryDigest, setProjectLanguage,
} from './v2Api.js';
import { useDigests } from './useDigests.js';
import { startLive } from './liveClient.js';
import { ProjectGraph } from './ProjectGraph.js';
import { ProjectHeader } from './ProjectHeader.js';
import { DigestPicker } from './DigestPicker.js';
import { WalkthroughView, walkthroughOf } from './Walkthrough.js';
import {
  AreaPicker, Breadcrumb, digestAreaRows, ImpactView, LEVEL_TAB_ID, LevelSwitcher, partsSettled, READING_PANE_ID, readerKey,
  StructureView, SummaryView,
} from './Reader.js';
import {
  apiErrorMessage, emptyCopy, explainOutcomeMessage, graphCopy, headerCopy, ignoreCopy, levelsCopy, readerCopy,
  setupCopy, trustCopy, walkthroughCopy, welcomeBackCopy, type Lang,
} from './copy.js';
import { relativeTime } from './format.js';
import { getLastSeen, getReviewed, setLastSeen, setReviewed, type LastSeen } from './storage.js';
import { useV2Url, type ReadingLevel, type V2Url } from './v2Url.js';

// --- setup form (no project registered yet) -----------------------------------------------------

/** The chrome language before any project exists: Korean when the browser prefers it, else English. */
function browserLang(): Lang {
  return typeof navigator !== 'undefined' && /^ko\b/i.test(navigator.language) ? 'ko' : 'en';
}

/** Shown after creation, only when the folder had no `.gitignore` of its own and DigestIT detected
 * likely output areas (DIG-56): one-click chips to add suggested ignore patterns. Never applied
 * automatically — this is the only place the operator confirms them before moving on. */
function IgnoreSuggestionsStep({ project, onContinue, lang }: { project: CreateProjectResponseDto; onContinue: () => void; lang: Lang }) {
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [addingPattern, setAddingPattern] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const T = emptyCopy(lang);
  const TI = ignoreCopy(lang);

  const onAdd = (pattern: string) => {
    setAddingPattern(pattern);
    setError(null);
    addIgnorePatterns(project.id, [pattern])
      .then(() => setAdded((prev) => new Set(prev).add(pattern)))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setAddingPattern(null));
  };

  return (
    <div className="box setup">
      <h2 className="box-head">{T.noProjects.heading}</h2>
      <div className="ignore-suggestions">
        <p>{TI.suggestionsHeading}</p>
        <p className="muted">{TI.suggestionsHint}</p>
        <div className="suggestion-chips">
          {project.suggestedIgnorePatterns.map((s) => (
            <button
              key={s.pattern}
              type="button"
              className="suggestion-chip"
              title={s.reason}
              disabled={addingPattern === s.pattern || added.has(s.pattern)}
              onClick={() => onAdd(s.pattern)}
            >
              {added.has(s.pattern) ? `✓ ${s.pattern}` : TI.suggestionAdd(s.pattern)}
            </button>
          ))}
        </div>
        {error && <p role="alert" className="error">{error}</p>}
        <button type="button" className="btn primary" onClick={onContinue}>{TI.continueLabel}</button>
      </div>
    </div>
  );
}

/** What Explain sends and what DigestIT never does (UX cycle 2 P2, decision-2.md "Changes to the
 * brief" 4): left column of the first-run screen, below the step list. `about` names the
 * configured provider (`GET /api/about`, packages/core/src/v2.ts) so the sentence is concrete
 * ("goes to Anthropic through Claude Code") rather than a vague "a provider" — null while it is
 * still loading, which drops only that one clause, not the rest of the box. */
function TrustBox({ about, lang }: { about: AboutDto | null; lang: Lang }) {
  const T = trustCopy(lang);
  const provider = !about ? null
    : about.provider === 'claude-code' ? T.providerClaudeCode
      : about.provider === 'stub' ? T.providerStub
        : T.providerOther(about.provider);
  return (
    <div className="fr-trust">
      <b className="fr-trust-label">{T.label}</b>
      <p>{T.local}</p>
      <p>{T.sent}{provider ? ` ${provider}` : ''}</p>
      <p>{T.readOnly}</p>
    </div>
  );
}

/** UX cycle 2 P3 (decision-2.md): two columns instead of one floated card, so the first-run screen
 * uses the width and height the empty `.app.with-panel.home` layout otherwise leaves blank. Left:
 * the step list plus the trust box (P2, above); right: the unchanged form fields, now in a card
 * that stretches to the left column's height instead of block-centering on its own. */
function SetupForm({ onCreated, about, lang }: { onCreated: (p: ProjectDto) => void; about: AboutDto | null; lang: Lang }) {
  const [rootPath, setRootPath] = useState('');
  const [contextPath, setContextPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateProjectResponseDto | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject(rootPath.trim(), contextPath.trim() || null);
      if (project.suggestedIgnorePatterns.length > 0) setCreated(project);
      else onCreated(project);
    } catch (e2) {
      setError(errorText(e2));
    } finally {
      setSubmitting(false);
    }
  };

  if (created) return <IgnoreSuggestionsStep project={created} lang={lang} onContinue={() => onCreated(created)} />;

  const T = emptyCopy(lang);
  const TS = setupCopy(lang);
  return (
    <div className="firstrun">
      <div className="fr-explain">
        <h2 className="fr-heading">{T.noProjects.heading}</h2>
        <ol className="fr-steps">
          {T.noProjects.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
        <TrustBox about={about} lang={lang} />
      </div>
      <div className="fr-form box">
        <h2 className="box-head">{TS.formHeading}</h2>
        <form className="setup-form" onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>{TS.projectFolderLabel}</span>
            <input
              type="text"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder={TS.projectFolderPlaceholder}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span>{TS.contextFileLabel}</span>
            <input
              type="text"
              value={contextPath}
              onChange={(e) => setContextPath(e.target.value)}
              placeholder={TS.contextFilePlaceholder}
            />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <button type="submit" className="btn primary" disabled={submitting || rootPath.trim() === ''}>
            {submitting ? TS.starting : TS.start}
          </button>
        </form>
      </div>
    </div>
  );
}

/** An API failure as a sentence: server error codes go through `apiErrorMessage`. */
function errorText(e: unknown, lang: ExplainLanguage = 'en'): string {
  return e instanceof ApiError ? apiErrorMessage(e.message, lang) : e instanceof Error ? e.message : String(e);
}

// --- L2 filter from a graph node ----------------------------------------------------------------

export interface ListFilter {
  path: string;
  areaIds: Set<string>;
  additions: number;
  deletions: number;
}

/** Resolve `?node=` to a filter, preferring the loaded graph's node (any kind) and falling back
 * to a plain path-prefix match over the digest's own data so filtering works before the graph loads. */
export function computeFilter(nodeId: string, graph: ProjectGraphDto | null, digest: DigestDetailDto): ListFilter {
  const found = graph?.nodes.find((n) => n.id === nodeId);
  if (found) return { path: found.path, areaIds: new Set(found.areaIds), additions: found.additions, deletions: found.deletions };
  const isFile = nodeId.startsWith('f:');
  const bare = nodeId.slice(2);
  const matches = (p: string) => (isFile ? p === bare : p === bare || p.startsWith(`${bare}/`));
  // digestAreaRows (not digest.l2?.items): the skeleton's paths are known before any area's text
  // lands, so filtering keeps working on a digest that just opened (DIG-76 scope 2).
  const rows = digestAreaRows(digest);
  const areaIds = new Set(rows.filter((row) => row.paths.some(matches)).map((row) => row.id));
  const files = digest.files.filter((f) => matches(f.path));
  return {
    path: bare || '(root)',
    areaIds,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
  };
}

/** Where a graph node click leads (docs/ux-v3.md §1): a node in exactly one area opens that area
 * at L3; a node touching several areas (or none) opens L2 filtered to it. */
export function nodeTarget(node: Pick<GraphNode, 'id' | 'areaIds'>): Partial<V2Url> {
  return node.areaIds.length === 1
    ? { level: 3, area: node.areaIds[0]!, step: null, node: null }
    : { level: 2, node: node.id, step: null };
}

// --- welcome-back strip (DIG-61 P6) --------------------------------------------------------------

/** Digests newer than the last-seen one, newest first. `items` is only ever the loaded page(s) of
 * the digest list; if `lastSeenId` isn't in it, the last-seen digest is further back (older) than
 * anything loaded, so every loaded digest counts as unseen — an undercount if even more digests
 * exist past the loaded page, which is an accepted v1 limitation (docs/ux/brief-1.md P6). */
export function unseenDigests(items: readonly DigestSummaryDto[], lastSeenId: number): DigestSummaryDto[] {
  const idx = items.findIndex((d) => d.id === lastSeenId);
  return idx === -1 ? items.slice() : items.slice(0, idx);
}

// --- resizable divider ---------------------------------------------------------------------------

const MIN_LEFT_PCT = 35;
const MAX_LEFT_PCT = 75;

function Divider({ pct, onChange }: { pct: number; onChange: (pct: number) => void }) {
  const dragging = useRef(false);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const wrap = e.currentTarget.parentElement;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const next = ((e.clientX - rect.left) / rect.width) * 100;
    onChange(Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, next)));
  };
  const onPointerUp = () => { dragging.current = false; };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') onChange(Math.max(MIN_LEFT_PCT, pct - 2));
    else if (e.key === 'ArrowRight') onChange(Math.min(MAX_LEFT_PCT, pct + 2));
    else if (e.key === 'Home') onChange(MIN_LEFT_PCT);
    else if (e.key === 'End') onChange(MAX_LEFT_PCT);
  };
  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={MIN_LEFT_PCT}
      aria-valuemax={MAX_LEFT_PCT}
      aria-valuenow={Math.round(pct)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}

// --- project status polling (SSE-driven refresh, no bespoke progress channel) -------------------

function useProjectStatus(projectId: number | null) {
  const [status, setStatus] = useState<ProjectStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (projectId === null) return;
    fetchProjectStatus(projectId).then(
      (s) => { setStatus(s); setError(null); },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [projectId]);
  useEffect(() => { setStatus(null); setError(null); refresh(); }, [refresh]);
  useEffect(() => {
    if (projectId === null) return undefined;
    return startLive({ onChange: refresh, onTransport: () => undefined });
  }, [projectId, refresh]);
  return { status, error, refresh };
}

// --- default project ---------------------------------------------------------------------------------

const LAST_PROJECT_KEY = 'digestit.lastProject';

function loadLastProject(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_PROJECT_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function saveLastProject(id: number): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, String(id));
  } catch {
    // storage unavailable (private mode, quota): the default below still applies
  }
}

/** The project to show when the URL names none: the one used last on this browser, else the most
 * recently checked project that has digests, else the first. Projects are listed oldest first, so
 * "the first" alone would open an old (often empty) project instead of the one being worked on. */
export function defaultProject(projects: readonly ProjectDto[], lastUsedId: number | null): ProjectDto | null {
  const last = projects.find((p) => p.id === lastUsedId);
  if (last) return last;
  const withDigests = projects.filter((p) => p.digestCount > 0);
  const newest = [...withDigests].sort((a, b) => (b.lastCheckpointAt ?? '').localeCompare(a.lastCheckpointAt ?? '') || b.id - a.id)[0];
  return newest ?? projects[0] ?? null;
}

// --- top level ------------------------------------------------------------------------------------

function useNarrow(breakpoint = 1000): boolean {
  const [narrow, setNarrow] = useState(() => (typeof matchMedia === 'function' ? matchMedia(`(max-width: ${breakpoint}px)`).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [breakpoint]);
  return narrow;
}

export function MainV2({ onLanguage }: { onLanguage?: (lang: ExplainLanguage) => void } = {}) {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsNotFound, setProjectsNotFound] = useState(false);
  // A 401 on the projects fetch gets its own message (decision-2.md P5), not the generic
  // `projectsError` one: this dashboard needs an access link, not a retry.
  const [projectsUnauthorized, setProjectsUnauthorized] = useState(false);
  // Global, project-independent info for the first-run trust box (P2) and the Settings panel (P5):
  // provider/model, the read-only flag and whether the legacy Insights link should show at all.
  // Fetched once, independent of whether any project exists yet — first run has none.
  const [about, setAbout] = useState<AboutDto | null>(null);
  const [url, push, replace] = useV2Url('/');
  const [explainingLocal, setExplainingLocal] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [explainNotice, setExplainNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settingLanguage, setSettingLanguage] = useState(false);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [digest, setDigest] = useState<DigestDetailDto | null>(null);
  const [digestError, setDigestError] = useState<string | null>(null);
  const [expand, setExpand] = useState<string[]>([]);
  const [graph, setGraph] = useState<ProjectGraphDto | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [firstRunExpand, setFirstRunExpand] = useState<string[]>([]);
  const [firstRunGraph, setFirstRunGraph] = useState<ProjectGraphDto | null>(null);
  const [firstRunGraphError, setFirstRunGraphError] = useState<string | null>(null);
  const [areaDetail, setAreaDetail] = useState<AreaDetailDto | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);
  const [areaGenerating, setAreaGenerating] = useState(false);
  // Fast Explain (DIG-73/76): `area-progress` events for the digest's currently open SSE stream,
  // keyed by area id, so a walkthrough being generated in the background keeps its place even if
  // the reader looks at a different area and comes back.
  const [areaProgress, setAreaProgress] = useState<Record<string, Pick<AreaProgressEvent, 'overview' | 'steps'>>>({});
  // Area ids with a walkthrough generation in flight server-side, independent of which area is
  // currently open (navigating away must not stop a background generation, and must not drop the
  // SSE connection carrying its `area-progress` events — see the events effect below).
  const [generatingAreaIds, setGeneratingAreaIds] = useState<Set<string>>(new Set());
  const [hoverAreaId, setHoverAreaId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  // P6 welcome-back strip: captured once per project landing (before this visit overwrites it),
  // so the strip's numbers stay stable for the session even once the newest digest is marked seen.
  const lastSeenOnLandingRef = useRef<LastSeen | null>(null);
  const [digestPickerOpenSignal, setDigestPickerOpenSignal] = useState(0);
  // P5-A per-area reviewed mark, keyed project:digest:area; hydrated from storage per digest.
  const [reviewedAreas, setReviewedAreas] = useState<Record<string, boolean>>({});
  // The reading pane defaults to ~60% of the width; the graph pane fills the rest.
  const [leftPct, setLeftPct] = useState(60);
  const narrow = useNarrow();
  const [graphSectionOpen, setGraphSectionOpen] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const level: ReadingLevel = url.level ?? 0;

  useEffect(() => {
    const ac = new AbortController();
    fetchProjects(ac.signal).then(setProjects, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setProjectsUnauthorized(true);
      else if (e instanceof ApiError && e.status === 404) setProjectsNotFound(true);
      else setProjectsError(e instanceof Error ? e.message : String(e));
    });
    return () => ac.abort();
  }, []);

  // First-run trust box (P2) and Settings panel (P5) both read this; fetched unconditionally since
  // first run has no project to hang it off of. A failure here is non-fatal: the boxes that use it
  // just render without the provider-specific sentence/rows until it loads.
  useEffect(() => {
    const ac = new AbortController();
    fetchAbout(ac.signal).then(setAbout, () => undefined);
    return () => ac.abort();
  }, []);

  const fallbackProjectId = useMemo(() => (projects ? defaultProject(projects, loadLastProject())?.id ?? null : null), [projects]);
  const currentProjectId = url.project ?? fallbackProjectId;
  // Snapshot the pre-visit last-seen marker before anything below updates it, so the strip's
  // numbers are fixed for this landing (must run before the "mark newest seen" effect further
  // down, hence declared here — effects fire in declaration order within one commit).
  useEffect(() => {
    lastSeenOnLandingRef.current = currentProjectId === null ? null : getLastSeen(currentProjectId);
  }, [currentProjectId]);
  // The UI chrome's language follows the current project's setting. Before any project is known
  // (first run, or while projects are still loading) it follows the browser's language instead.
  const lang: ExplainLanguage = projects?.find((p) => p.id === currentProjectId)?.language ?? browserLang();
  // App keeps the last-known project language for its own chrome (the nav),
  // since it stays mounted on pages this component doesn't (DIG-60).
  useEffect(() => { onLanguage?.(lang); }, [lang, onLanguage]);
  useEffect(() => {
    if (url.project === null && fallbackProjectId !== null) replace({ project: fallbackProjectId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackProjectId, url.project]);
  useEffect(() => {
    if (url.project !== null && projects?.some((p) => p.id === url.project)) saveLastProject(url.project);
  }, [url.project, projects]);

  const { status, error: statusError, refresh: refreshStatus } = useProjectStatus(currentProjectId);
  const digests = useDigests(currentProjectId);
  const currentDigestId = url.digest ?? digests.items[0]?.id ?? null;
  useEffect(() => {
    if (url.digest === null && digests.items.length > 0) replace({ digest: digests.items[0]!.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digests.items, url.digest]);
  // Marks the newest digest seen (P6) once it is actually the one open, not just loaded in the
  // list — a bookmark to an older digest must not silently clear a real unread strip.
  useEffect(() => {
    if (currentProjectId === null || digests.items.length === 0) return;
    const newestId = digests.items[0]!.id;
    if (currentDigestId === newestId) setLastSeen(currentProjectId, newestId);
  }, [currentProjectId, currentDigestId, digests.items]);

  useEffect(() => {
    setDigest(null);
    setDigestError(null);
    if (currentDigestId === null) return;
    const ac = new AbortController();
    fetchDigest(currentDigestId, ac.signal).then(setDigest, (e: unknown) => { if (!ac.signal.aborted) setDigestError(e instanceof Error ? e.message : String(e)); });
    return () => ac.abort();
  }, [currentDigestId]);

  // Fast Explain (DIG-73/76): live progress for the open digest. `onChange`/`onProgress` are read
  // through a ref so a state update elsewhere (e.g. the digest itself refetching) never tears the
  // connection down and reopens it — that would drop an area-progress stream mid-walkthrough. The
  // effect below re-subscribes only when the digest id changes or `digestUnsettled`/`anyAreaGenerating`
  // flips, not on every `parts` refetch in between; an old-contract digest (no `areas`/`parts`)
  // never had an events endpoint to poll. A digest whose own parts are all settled still needs the
  // stream open while an area's L3 is generating (the common case: L3 is generated on demand, long
  // after the digest itself landed) — `generatingAreaIds` tracks that independently of which area
  // is currently open, since navigating away must not stop a background generation.
  const digestUnsettled = digest?.parts ? !partsSettled(digest.parts) : false;
  const anyAreaGenerating = generatingAreaIds.size > 0;
  const digestEvents = useRef({
    onChange: () => undefined as void,
    onProgress: (_e: AreaProgressEvent) => undefined as void,
  });
  const dropGenerating = (areaId: string) =>
    setGeneratingAreaIds((prev) => { if (!prev.has(areaId)) return prev; const next = new Set(prev); next.delete(areaId); return next; });
  // Refetches one in-flight area. `onlyIfSettled`: a check after a reconnect, poll tick or `done`,
  // where the area may still be running (keep waiting) or may have finished while no stream was
  // listening (its `done` progress event is not replayed, so this is the only way to see it).
  const settleArea = (digestId: number, areaId: string, onlyIfSettled: boolean) => {
    fetchArea(digestId, areaId).then((d) => {
      if (onlyIfSettled && d.status === 'pending') return;
      dropGenerating(areaId);
      setAreaDetail((prev) => (prev && prev.digestId === digestId && prev.areaId === areaId ? d : prev));
      if (areaId === url.area) setAreaGenerating(false);
    }, (err: unknown) => {
      // A 404 means the area is gone for this digest: stop waiting on it. Anything else (a network
      // blip) stays in flight for the next check.
      if (onlyIfSettled && !(err instanceof ApiError && err.status === 404)) return;
      dropGenerating(areaId);
      if (areaId === url.area) setAreaGenerating(false);
    });
  };
  digestEvents.current.onChange = () => {
    if (currentDigestId === null) return;
    fetchDigest(currentDigestId).then(setDigest, () => undefined);
    for (const areaId of generatingAreaIds) settleArea(currentDigestId, areaId, true);
  };
  digestEvents.current.onProgress = (e: AreaProgressEvent) => {
    setAreaProgress((prev) => ({ ...prev, [e.areaId]: { overview: e.overview, steps: e.steps } }));
    if (e.done && currentDigestId !== null) settleArea(currentDigestId, e.areaId, false);
  };
  useEffect(() => {
    if (!digest || !(digestUnsettled || anyAreaGenerating)) return undefined;
    return openDigestEvents(digest.id, {
      onChange: () => digestEvents.current.onChange(),
      onProgress: (e) => digestEvents.current.onProgress(e),
      // The server closes the stream after `done`; one last refetch settles anything whose own
      // event this stream never carried. Also re-checks project status directly (belt and braces
      // alongside the /api/stream `changed` event, DIG-84): the Explain button must not wait on a
      // reload once the digest itself has visibly settled.
      onDone: () => { digestEvents.current.onChange(); refreshStatus(); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digest?.id, digestUnsettled, anyAreaGenerating]);

  // Hydrates the P5-A reviewed marks for this digest's areas from storage (cheap: a handful of
  // areas per digest, each one localStorage read).
  useEffect(() => {
    if (!digest || currentProjectId === null) {
      setReviewedAreas({});
      return;
    }
    const rows = digestAreaRows(digest);
    const next: Record<string, boolean> = {};
    for (const row of rows) next[row.id] = getReviewed(currentProjectId, digest.id, row.id);
    setReviewedAreas(next);
  }, [digest, currentProjectId]);

  // A new digest starts from its own graph, folded; unfolding a folder refetches but keeps the
  // current graph on screen (and its view) until the new one arrives.
  useEffect(() => { setExpand([]); setGraph(null); }, [currentDigestId]);
  useEffect(() => {
    setGraphError(null);
    if (currentDigestId === null) return;
    const ac = new AbortController();
    fetchGraph(currentDigestId, expand, ac.signal).then(setGraph, (e: unknown) => { if (!ac.signal.aborted) setGraphError(e instanceof Error ? e.message : String(e)); });
    return () => ac.abort();
  }, [currentDigestId, expand]);

  // A project with no digest yet (DIG-59): the gray structure graph from the latest checkpoint,
  // with no areas to click through. Switching projects must never leave the previous project's
  // tree on screen, so it resets on every project change, not just when it happens to be shown.
  const noDigestsYet = !digestError && currentDigestId === null && digests.done && !digests.error;
  useEffect(() => { setFirstRunExpand([]); setFirstRunGraph(null); setFirstRunGraphError(null); }, [currentProjectId]);
  useEffect(() => {
    if (!noDigestsYet || currentProjectId === null) return;
    const ac = new AbortController();
    fetchProjectGraph(currentProjectId, firstRunExpand, ac.signal).then(
      (g) => { if (!ac.signal.aborted) setFirstRunGraph(g); },
      (e: unknown) => { if (!ac.signal.aborted) setFirstRunGraphError(e instanceof Error ? e.message : String(e)); },
    );
    return () => ac.abort();
  }, [currentProjectId, noDigestsYet, firstRunExpand]);

  // Tracks a generate/retry POST in flight so a superseded request (the user opened a
  // different area before it settled) is aborted rather than landing on the wrong area.
  const generateRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setAreaDetail(null);
    setAreaError(null);
    setAreaGenerating(false);
    generateRef.current?.abort();
    generateRef.current = null;
    if (currentDigestId === null || url.area === null) return;
    const ac = new AbortController();
    // Cheap GET: never spends the budget. Generating L3 is a separate, explicit user action.
    const areaId = url.area;
    fetchArea(currentDigestId, areaId, ac.signal).then((d) => {
      setAreaDetail(d);
      // An L3 already running server-side (started before a reload, or from another tab): follow
      // it on the events stream like one started here.
      if (d.status === 'pending') setGeneratingAreaIds((prev) => (prev.has(areaId) ? prev : new Set(prev).add(areaId)));
    }, (e: unknown) => { if (!ac.signal.aborted) setAreaError(e instanceof Error ? e.message : String(e)); });
    return () => ac.abort();
  }, [currentDigestId, url.area]);

  const onGenerateArea = useCallback(() => {
    if (currentDigestId === null || url.area === null) return;
    const areaId = url.area;
    const ac = new AbortController();
    generateRef.current?.abort();
    generateRef.current = ac;
    setAreaGenerating(true);
    setAreaProgress((prev) => { const { [areaId]: _drop, ...rest } = prev; return rest; });
    explainArea(currentDigestId, areaId, ac.signal).then(
      (d) => {
        if (ac.signal.aborted) return;
        setAreaDetail(d);
        // Fast Explain (DIG-75+): the POST answers right away with a `pending` shell; the real
        // walkthrough streams in as `area-progress` and lands via that stream's `done` handler
        // above, which clears `areaGenerating` and `generatingAreaIds`. An old-contract server
        // already returns the final result here, so this is the only place that finishes in that
        // case — nothing was added to `generatingAreaIds`, so there is nothing to remove.
        if (d.status !== 'pending') setAreaGenerating(false);
        else setGeneratingAreaIds((prev) => new Set(prev).add(areaId));
        refreshStatus();
      },
      // The area is already loaded, so the walkthrough shows its own error + Try again rather
      // than replacing the pane with the "couldn't load" message.
      () => {
        if (ac.signal.aborted) return;
        setAreaGenerating(false);
        setAreaDetail((prev) => (prev ? { ...prev, status: 'error' } : prev));
        refreshStatus();
      },
    );
  }, [currentDigestId, url.area, refreshStatus]);

  const filter = useMemo(() => (url.node && digest ? computeFilter(url.node, graph, digest) : null), [url.node, graph, digest]);

  // Only announce "Filter cleared" on a real node -> no-node transition, not on first load
  // (when there was never a filter to clear).
  const prevNodeRef = useRef<string | null>(null);
  useEffect(() => {
    const T = readerCopy(lang);
    if (filter) setAnnounce(T.filterAnnounce(filter.path));
    else if (url.node === null && prevNodeRef.current !== null) setAnnounce(T.filterCleared);
    prevNodeRef.current = url.node;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, url.node]);

  const areaRows = useMemo(() => (digest ? digestAreaRows(digest) : []), [digest]);
  const openAreaItem = areaRows.find((row) => row.id === url.area) ?? null;
  const walkthrough = areaDetail && areaDetail.areaId === url.area ? walkthroughOf(areaDetail) : null;
  const stepCount = walkthrough?.steps.length ?? 0;

  // The graph outlines the hovered area's nodes, else (at L2/L3) the selected area's.
  const outlinedAreaId = hoverAreaId ?? (level >= 2 && openAreaItem ? openAreaItem.id : null);
  const highlightNodeIds = useMemo(() => {
    if (!outlinedAreaId || !graph) return undefined;
    return new Set(graph.nodes.filter((n) => n.areaIds.includes(outlinedAreaId)).map((n) => n.id));
  }, [outlinedAreaId, graph]);

  // The reading pane is the one long scroll: a new digest, level or area starts at its top. A
  // step in the URL scrolls itself into view (WalkthroughView), so it is left alone here. Landing
  // on L2 with an area pre-selected (a P2 card from L0) scrolls that card into view instead, so
  // the shortcut actually lands on the area rather than the top of the full list.
  useEffect(() => {
    if (url.step !== null) return;
    if (level === 2 && url.area !== null) {
      const cards = paneRef.current?.querySelectorAll<HTMLElement>('[data-area-id]');
      const card = cards && Array.from(cards).find((c) => c.dataset.areaId === url.area);
      if (card) {
        card.scrollIntoView({ block: 'start' });
        return;
      }
    }
    paneRef.current?.scrollTo?.({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDigestId, level, url.area]);

  const explaining = Boolean(status?.explaining) || explainingLocal;

  const onExplain = useCallback(() => {
    if (currentProjectId === null) return;
    setExplainingLocal(true);
    setExplainError(null);
    setExplainNotice(null);
    explainProject(currentProjectId)
      .then((r) => {
        if (r.noChanges) {
          setExplainNotice(explainOutcomeMessage('no_changes', undefined, '', lang));
          return;
        }
        // Fast Explain (DIG-75+): the POST always answers with `status: 'pending'` right away —
        // that is the normal immediate-return outcome now, not a budget signal. A part that
        // genuinely runs out of budget lands with its own `status: 'budget'` once the digest opens
        // (Reader.tsx's `PartRetry`), which is where that case is surfaced.
        if (r.digestId !== null) {
          digests.reload();
          // A new digest after Explain lands at L0 (docs/ux-v3.md §1).
          replace({ digest: r.digestId, level: null, node: null, area: null, step: null });
        }
      })
      .catch((e: unknown) => setExplainError(explainOutcomeMessage('error', errorText(e, lang), '', lang)))
      .finally(() => {
        setExplainingLocal(false);
        refreshStatus();
      });
  }, [currentProjectId, refreshStatus, replace, digests, lang]);

  const onRefreshContext = useCallback(() => {
    if (currentProjectId === null) return;
    setRefreshing(true);
    refreshContext(currentProjectId).finally(() => { setRefreshing(false); refreshStatus(); });
  }, [currentProjectId, refreshStatus]);

  const onSetLanguage = useCallback((language: ExplainLanguage) => {
    if (currentProjectId === null) return;
    setSettingLanguage(true);
    setLanguageError(null);
    setProjectLanguage(currentProjectId, language)
      .then((updated) => { setProjects((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? prev); refreshStatus(); })
      .catch((e: unknown) => setLanguageError(errorText(e, lang)))
      .finally(() => setSettingLanguage(false));
  }, [currentProjectId, refreshStatus, lang]);

  const onSwitchProject = useCallback(
    (id: number) => push({ project: id, digest: null, level: null, node: null, area: null, step: null }),
    [push],
  );
  const onSelectDigest = useCallback((id: number) => push({ digest: id, node: null, area: null, step: null }), [push]);
  const onLevel = useCallback((l: ReadingLevel) => push({ level: l === 0 ? null : l, step: null }), [push]);
  const onOpenArea = useCallback((id: string) => push({ level: 3, area: id, step: null }), [push]);
  // A P2 "Open area" card on L0 lands on L2 with the area selected, not L3 (docs/ux/brief-1.md
  // P2): jumping straight to L3 would skip the structural framing L3's callouts assume.
  const onOpenAreaAtL2 = useCallback((id: string) => push({ level: 2, area: id, step: null, node: null }), [push]);
  const onStep = useCallback((n: number) => replace({ step: n }), [replace]);
  const onSelectNode = useCallback((node: GraphNode) => {
    setGraphSectionOpen(false);
    push(nodeTarget(node));
  }, [push]);
  const onClearFilter = useCallback(() => push({ node: null }), [push]);
  const onExpandGraphNode = useCallback((path: string) => setExpand((prev) => (prev.includes(path) ? prev : [...prev, path])), []);
  const onExpandFirstRunGraphNode = useCallback(
    (path: string) => setFirstRunExpand((prev) => (prev.includes(path) ? prev : [...prev, path])),
    [],
  );
  // No areas exist before the first digest, so a first-run graph node never opens anything.
  const onSelectFirstRunGraphNode = useCallback(() => undefined, []);
  const toTop = () => paneRef.current?.scrollTo?.({ top: 0 });

  // P5-A: toggles the reviewed mark for one area of the current digest; undo is the same click.
  const onToggleReviewed = useCallback((areaId: string) => {
    if (currentProjectId === null || currentDigestId === null) return;
    setReviewedAreas((prev) => {
      const next = !prev[areaId];
      setReviewed(currentProjectId, currentDigestId, areaId, next);
      return { ...prev, [areaId]: next };
    });
  }, [currentProjectId, currentDigestId]);
  const reviewedAreaIds = useMemo(
    () => new Set(Object.keys(reviewedAreas).filter((id) => reviewedAreas[id])),
    [reviewedAreas],
  );
  // P6: opens the existing DigestPicker overlay from the welcome-back strip's CTA.
  const onOpenDigestList = useCallback(() => setDigestPickerOpenSignal((n) => n + 1), []);

  // Global reading keys: 0–3 switch level, n/p move between walkthrough steps.
  const keyState = useRef({ level, step: url.step, stepCount, onLevel, onStep, lang });
  keyState.current = { level, step: url.step, stepCount, onLevel, onStep, lang };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const action = readerKey(e);
      if (!action) return;
      const k = keyState.current;
      if (action.kind === 'level') {
        e.preventDefault();
        k.onLevel(action.level);
        const lv = levelsCopy(k.lang)[action.level];
        setAnnounce(`${lv.key} ${lv.label}`);
      } else if (k.level === 3 && k.stepCount > 0 && !(k.step === null && action.delta < 0)) {
        // At the overview (no step yet) only `n` moves: `p` has nowhere earlier to go.
        const next = Math.min(k.stepCount, Math.max(1, (k.step ?? 0) + action.delta));
        if (next !== k.step) {
          e.preventDefault();
          k.onStep(next);
          // WalkthroughView owns the step announcement now (docs/ux/dig71-step-code-mapping.md
          // §3): it fires the same way for n/p, the TOC and a ?step= reload, with the range.
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onRetryDigest = useCallback((id: number) => {
    setRetryingId(id);
    retryDigest(id).then(
      (d) => {
        digests.reload();
        if (id === currentDigestId) setDigest(d);
        else push({ digest: id, node: null, area: null, step: null });
      },
      () => digests.reload(),
    ).finally(() => {
      setRetryingId(null);
      refreshStatus();
    });
  }, [currentDigestId, digests, push, refreshStatus]);

  const TS = setupCopy(lang);
  if (projectsUnauthorized) {
    return (
      <div className="box setup">
        <p className="muted">
          {TS.accessLinkNeeded.before}<code>{TS.accessLinkNeeded.code}</code>{TS.accessLinkNeeded.after}
        </p>
      </div>
    );
  }
  if (projectsNotFound) {
    return (
      <div className="box setup">
        <p className="muted">{TS.noApiHint}</p>
      </div>
    );
  }
  if (projectsError) return <p role="alert" className="error">{TS.projectsLoadError(projectsError)}</p>;
  if (projects === null) return <p className="muted">{headerCopy(lang).loadingStatus}</p>;
  if (projects.length === 0) {
    return <SetupForm about={about} lang={lang} onCreated={(p) => { setProjects([p]); replace({ project: p.id }); }} />;
  }
  const currentProject = projects.find((p) => p.id === currentProjectId) ?? projects[0]!;
  const noBudget = (status?.budget.remaining ?? 1) === 0;
  const T = readerCopy(lang);
  const TW = walkthroughCopy(lang);
  const TG = graphCopy(lang);
  const TE = emptyCopy(lang);
  const TB = welcomeBackCopy(lang);

  // P6: only while actually viewing the newest digest (matches "you're viewing the newest" in the
  // mockup) and only once storage has been read for this project (a null landing snapshot means
  // either a first visit or a project with nothing seen yet — never show the strip then).
  const newestDigestId = digests.items[0]?.id ?? null;
  const lastSeenOnLanding = lastSeenOnLandingRef.current;
  const unseen = lastSeenOnLanding !== null ? unseenDigests(digests.items, lastSeenOnLanding.digestId) : [];
  const showWelcomeBack = level === 0 && currentDigestId !== null && currentDigestId === newestDigestId && unseen.length > 0;

  // P2/P6: L0 and the no-area L3 picker are short by nature and must not stretch to the graph
  // pane's height (docs/ux/brief-1.md P2); every other reading-pane view keeps the shared stretch.
  const shortView = level === 0 || (level === 3 && !openAreaItem);

  const digestNotice = digest && digest.status !== 'ok' && (
    <div className={digest.status === 'error' ? 'notice error' : 'notice muted'} role={digest.status === 'error' ? 'alert' : 'status'}>
      <span>{digest.status === 'pending' ? T.digestPending : digest.status === 'error' ? T.digestError : T.digestTruncated}</span>
      {digest.status !== 'pending' && (
        <button type="button" className="btn" onClick={() => onRetryDigest(digest.id)} disabled={retryingId !== null || noBudget}>
          {noBudget ? T.retryNoBudget : retryingId === digest.id ? T.retrying : T.retry}
        </button>
      )}
    </div>
  );

  const onRetryPart = () => { if (digest) onRetryDigest(digest.id); };
  const retryingPart = digest !== null && retryingId === digest.id;

  const levelView = !digest ? null
    : level === 0 ? (
      <SummaryView
        digest={digest} onLevel={onLevel} onOpenArea={onOpenAreaAtL2} onHoverArea={setHoverAreaId}
        onRetryPart={onRetryPart} retryingPart={retryingPart} retryDisabled={noBudget} lang={lang}
      />
    )
      : level === 1 ? (
        <ImpactView digest={digest} onLevel={onLevel} onRetryPart={onRetryPart} retryingPart={retryingPart} retryDisabled={noBudget} lang={lang} />
      )
        : level === 2 ? (
          <StructureView
            digest={digest}
            filter={filter}
            selectedAreaId={url.area}
            onOpenArea={onOpenArea}
            onClearFilter={onClearFilter}
            onHoverArea={setHoverAreaId}
            onLevel={onLevel}
            reviewedAreaIds={reviewedAreaIds}
            onRetryPart={onRetryPart}
            retryingPart={retryingPart}
            retryDisabled={noBudget}
            lang={lang}
          />
        ) : !openAreaItem ? (
          <AreaPicker digest={digest} onOpenArea={onOpenArea} onHoverArea={setHoverAreaId} reviewedAreaIds={reviewedAreaIds} lang={lang} />
        ) : areaError ? (
          <p role="alert" className="error">{TW.loadError(areaError)}</p>
        ) : areaDetail ? (
          <WalkthroughView
            area={areaGenerating ? { ...areaDetail, status: 'pending' } : areaDetail}
            item={openAreaItem}
            step={url.step}
            onStep={onStep}
            onGenerate={onGenerateArea}
            callsRemaining={status?.budget.remaining ?? null}
            reviewed={reviewedAreaIds.has(openAreaItem.id)}
            onToggleReviewed={() => onToggleReviewed(openAreaItem.id)}
            streaming={url.area ? areaProgress[url.area] ?? null : null}
            lang={lang}
          />
        ) : (
          <p className="muted">{TW.loading}</p>
        );

  const graphPane = graphError ? (
    <p role="alert" className="error">{TG.loadError(graphError)}</p>
  ) : graph ? (
    <ProjectGraph
      graph={graph} highlightNodeIds={highlightNodeIds} selectedNodeId={url.node} onSelectNode={onSelectNode} onExpand={onExpandGraphNode}
      lang={lang}
    />
  ) : (
    <p className="muted">{TG.loading}</p>
  );

  const firstRunGraphPane = firstRunGraphError ? (
    <p role="alert" className="error">{TG.loadError(firstRunGraphError)}</p>
  ) : firstRunGraph ? (
    <ProjectGraph graph={firstRunGraph} onSelectNode={onSelectFirstRunGraphNode} onExpand={onExpandFirstRunGraphNode} lang={lang} />
  ) : (
    <p className="muted">{TG.loading}</p>
  );

  return (
    <div className={narrow ? 'main-v2 narrow' : 'main-v2'}>
      <div aria-live="polite" className="visually-hidden">{announce}</div>
      <div className="reader-top">
        <ProjectHeader
          projects={projects}
          currentProject={currentProject}
          onSwitch={onSwitchProject}
          about={about}
          status={status}
          statusError={statusError}
          explaining={explaining}
          onExplain={onExplain}
          onRefreshContext={onRefreshContext}
          refreshingContext={refreshing}
          onSetLanguage={onSetLanguage}
          settingLanguage={settingLanguage}
          languageError={languageError}
          lang={lang}
          picker={digests.items.length > 0 && (
            <DigestPicker
              digests={digests}
              currentId={currentDigestId}
              onSelect={onSelectDigest}
              onRetry={onRetryDigest}
              retryingId={retryingId}
              retryDisabled={noBudget}
              openSignal={digestPickerOpenSignal}
              lang={lang}
            />
          )}
        />
        {explainError && <p role="alert" className="notice error">{explainError}</p>}
        {explainNotice && <p role="status" className="notice muted">{explainNotice}</p>}
        {digestError && <p role="alert" className="error">{T.digestLoadError(digestError)}</p>}
        {!digestError && currentDigestId === null && !digests.done && <p className="muted">{headerCopy(lang).loadingStatus}</p>}
        {!digestError && currentDigestId !== null && !digest && <p className="muted">{T.loadingDigest}</p>}
        {digest && (
          <>
            <div className="reader-nav">
              <Breadcrumb
                digest={digest}
                level={level}
                area={openAreaItem}
                onDigest={() => { push({ level: null, area: null, step: null, node: null }); toTop(); }}
                onArea={() => { replace({ step: null }); toTop(); }}
                onLevel={() => { if (url.step !== null) replace({ step: null }); toTop(); }}
                lang={lang}
              />
              <LevelSwitcher level={level} onLevel={onLevel} lang={lang} />
            </div>
          </>
        )}
      </div>
      {noDigestsYet && (() => {
        const nd = TE.noDigests(currentProject.name, status?.pending.files ?? 0);
        return (
          <div className="reader-split">
            <div className="reading-pane" style={narrow ? undefined : { flexBasis: `${leftPct}%` }}>
              <div className="box empty-state">
                <h2 className="box-head">{nd.heading}</h2>
                <p>{nd.body}</p>
              </div>
            </div>
            {!narrow && <Divider pct={leftPct} onChange={setLeftPct} />}
            <aside className="graph-pane" aria-label={TG.label}>
              {narrow && (
                <button type="button" className="btn graph-toggle" aria-expanded={graphSectionOpen} onClick={() => setGraphSectionOpen((o) => !o)}>
                  {graphSectionOpen ? TG.hide : TG.show}
                </button>
              )}
              {(!narrow || graphSectionOpen) && firstRunGraphPane}
            </aside>
          </div>
        );
      })()}
      {digest && (
        <div className="reader-split">
          <div
            id={READING_PANE_ID}
            ref={paneRef}
            role="tabpanel"
            aria-labelledby={LEVEL_TAB_ID(level)}
            tabIndex={0}
            className="reading-pane"
            data-short-view={shortView ? '' : undefined}
            style={narrow ? undefined : { flexBasis: `${leftPct}%` }}
          >
            {digestNotice}
            {digest.stats.files === 0 && <p className="notice muted" role="status">{TE.digestNoChanges}</p>}
            {showWelcomeBack && lastSeenOnLanding && (
              <div className="welcome-back" role="status">
                <span className="welcome-back-dot" aria-hidden="true" />
                <span className="welcome-back-text">
                  {TB.strip(unseen.length, relativeTime(lastSeenOnLanding.at, Date.now(), lang), unseen.reduce((s, d) => s + d.stats.files, 0))}
                </span>
                <button type="button" className="btn welcome-back-cta" onClick={onOpenDigestList}>
                  {TB.openDigestList} <span aria-hidden="true">▾</span>
                </button>
              </div>
            )}
            {levelView}
          </div>
          {!narrow && <Divider pct={leftPct} onChange={setLeftPct} />}
          <aside className="graph-pane" aria-label={TG.label}>
            {narrow && (
              <button type="button" className="btn graph-toggle" aria-expanded={graphSectionOpen} onClick={() => setGraphSectionOpen((o) => !o)}>
                {graphSectionOpen ? TG.hide : TG.show}
              </button>
            )}
            {(!narrow || graphSectionOpen) && graphPane}
          </aside>
        </div>
      )}
    </div>
  );
}
