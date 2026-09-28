// Main screen v2 (DIG-40, docs/direction-v2.md §5): setup form, project bar (switcher, context
// status, budget, Explain button), and the two-pane digest view (change list + project graph).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type {
  AreaDetailDto, DigestDetailDto, DigestSummaryDto, GraphNode, ProjectDto, ProjectGraphDto, ProjectStatusDto,
} from '@digestit/core';
import {
  ApiError, createProject, explainArea, explainProject, fetchArea, fetchDigest, fetchGraph, fetchProjectStatus, fetchProjects, refreshContext,
  retryDigest,
} from './v2Api.js';
import { useDigests } from './useDigests.js';
import { startLive } from './liveClient.js';
import { formatDate, relativeTime } from './format.js';
import { ProjectGraph } from './ProjectGraph.js';
import { WalkthroughView, walkthroughOf } from './Walkthrough.js';
import {
  AreaPicker, Breadcrumb, ImpactView, LEVEL_TAB_ID, LevelSwitcher, READING_PANE_ID, readerKey, StructureView, SummaryView,
} from './Reader.js';
import { GRAPH, LEVELS, READER, WALKTHROUGH } from './copy.js';
import { useV2Url, type ReadingLevel, type V2Url } from './v2Url.js';

// --- setup form (no project registered yet) -----------------------------------------------------

function SetupForm({ onCreated }: { onCreated: (p: ProjectDto) => void }) {
  const [rootPath, setRootPath] = useState('');
  const [contextPath, setContextPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject(rootPath.trim(), contextPath.trim() || null);
      onCreated(project);
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="box setup">
      <h2 className="box-head">Start a project</h2>
      <form className="setup-form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>Project folder</span>
          <input
            type="text"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            placeholder="/path/to/project"
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>Context file (optional)</span>
          <input
            type="text"
            value={contextPath}
            onChange={(e) => setContextPath(e.target.value)}
            placeholder="/path/to/context.md"
          />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="btn primary" disabled={submitting || rootPath.trim() === ''}>
          {submitting ? 'Starting…' : 'Start'}
        </button>
      </form>
    </div>
  );
}

// --- project bar: switcher, context status, budget, Explain ------------------------------------

function BudgetMeter({ status }: { status: ProjectStatusDto }) {
  const { limit, remaining } = status.budget;
  return (
    <span className="budget-meter" title={`Resets ${formatDate(status.budget.resetsAt)}`}>
      {remaining} of {limit} LLM calls left today
    </span>
  );
}

function pendingLabel(status: ProjectStatusDto): string {
  const { files, additions, deletions } = status.pending;
  if (files === 0) return 'Nothing pending since last check';
  return `${files} ${files === 1 ? 'file' : 'files'}, +${additions} −${deletions} since last check`;
}

function explainDisabledReason(status: ProjectStatusDto, explaining: boolean): string | null {
  if (explaining) return 'Explaining…';
  if (status.pending.files === 0) return 'Nothing pending since last check';
  if (status.budget.remaining === 0) return 'Daily budget used up';
  return null;
}

function ExplainButton({ status, explaining, onExplain }: { status: ProjectStatusDto; explaining: boolean; onExplain: () => void }) {
  const reason = explainDisabledReason(status, explaining);
  return (
    <button type="button" className="btn primary explain-btn" disabled={reason !== null} onClick={onExplain} title={reason ?? undefined}>
      {explaining ? 'Explaining…' : 'Explain changes since last check'}
      <span className="explain-pending">{pendingLabel(status)}</span>
    </button>
  );
}

function contextLabel(status: ProjectStatusDto): string {
  const c = status.project.context;
  if (c.status === 'none') return 'No context built yet';
  const built = c.builtAt ? `Built ${relativeTime(c.builtAt)}` : 'Building…';
  const from = c.fromFiles !== null ? `, from ${c.fromFiles} ${c.fromFiles === 1 ? 'file' : 'files'}` : '';
  const user = `, user context ${c.hasUserContext ? 'yes' : 'no'}`;
  return `${built}${from}${user}`;
}

function ProjectBar({
  projects, currentProject, onSwitch, status, statusError, onRefreshContext, refreshing, explaining, onExplain,
}: {
  projects: ProjectDto[];
  currentProject: ProjectDto;
  onSwitch: (id: number) => void;
  status: ProjectStatusDto | null;
  statusError: string | null;
  onRefreshContext: () => void;
  refreshing: boolean;
  explaining: boolean;
  onExplain: () => void;
}) {
  return (
    <div className="project-bar">
      <div className="project-bar-row">
        {projects.length > 1 ? (
          <select aria-label="Project" value={currentProject.id} onChange={(e) => onSwitch(Number(e.target.value))}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ) : (
          <span className="project-name">{currentProject.name}</span>
        )}
        <code className="project-path">{currentProject.rootPath}</code>
      </div>
      <div className="project-bar-row">
        {statusError ? (
          <span role="alert" className="context-status error">Could not load status: {statusError}</span>
        ) : (
          <span className="context-status muted">
            {status ? contextLabel(status) : 'Loading context…'}
          </span>
        )}
        <button type="button" className="btn" onClick={onRefreshContext} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        {status && <BudgetMeter status={status} />}
      </div>
      {status && (
        <div className="project-bar-row">
          <ExplainButton status={status} explaining={explaining} onExplain={onExplain} />
        </div>
      )}
    </div>
  );
}

// --- digest picker: past digests, newest first, infinite scroll --------------------------------

function statusChip(status: DigestSummaryDto['status']) {
  if (status === 'ok') return null;
  return <span className="badge digest-error">{status === 'error' ? 'error' : status === 'pending' ? 'pending' : 'truncated'}</span>;
}

function DigestRow({ d, current, onSelect, onRetry, retrying, retryDisabled }: {
  d: DigestSummaryDto;
  current: boolean;
  onSelect: () => void;
  onRetry: () => void;
  retrying: boolean;
  retryDisabled: boolean;
}) {
  const retryable = d.status === 'error' || d.status === 'truncated';
  return (
    <li className="digest-row">
      <button type="button" className="digest-row-main" aria-current={current ? 'true' : undefined} onClick={onSelect}>
        <span className="digest-l0">{d.l0?.text ?? '(not explained yet)'}</span>
        <span className="meta">
          <span>{formatDate(d.fromAt)} → {formatDate(d.toAt)}</span>
          <span className="stats">
            {d.stats.files} {d.stats.files === 1 ? 'file' : 'files'}{' '}
            <span className="add">+{d.stats.additions}</span> <span className="del">−{d.stats.deletions}</span>
          </span>
          {statusChip(d.status)}
        </span>
      </button>
      {retryable && (
        <button
          type="button"
          className="btn retry"
          onClick={onRetry}
          disabled={retrying || retryDisabled}
          title={retryDisabled ? 'Daily budget used up' : undefined}
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </li>
  );
}

function DigestPicker({
  digests, current, onSelect, onRetry, retryingId, retryDisabled,
}: {
  digests: ReturnType<typeof useDigests>;
  current: DigestSummaryDto | undefined;
  onSelect: (id: number) => void;
  onRetry: (id: number) => void;
  retryingId: number | null;
  retryDisabled: boolean;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || digests.done) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void digests.loadMore(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [digests.done, digests.loadMore]);

  return (
    <details className="digest-picker">
      <summary>
        {current ? (
          <span>Digest: {current.l0?.text ?? `#${current.seq}`} ({formatDate(current.fromAt)} → {formatDate(current.toAt)})</span>
        ) : (
          <span>Select a digest</span>
        )}
      </summary>
      <ol className="digest-list">
        {digests.items.map((d) => (
          <DigestRow
            key={d.id}
            d={d}
            current={d.id === current?.id}
            onSelect={() => onSelect(d.id)}
            onRetry={() => onRetry(d.id)}
            retrying={retryingId === d.id}
            retryDisabled={retryDisabled}
          />
        ))}
      </ol>
      {digests.error && <p role="alert" className="error">Could not load digests: {digests.error}</p>}
      <div ref={sentinel} className="sentinel">
        {digests.loading && <span className="muted">Loading…</span>}
        {digests.done && digests.items.length > 0 && <span className="muted">Start of history</span>}
      </div>
    </details>
  );
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
  const items = digest.l2?.items ?? [];
  const areaIds = new Set(items.filter((it) => it.paths.some(matches)).map((it) => it.id));
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

export function MainV2() {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsNotFound, setProjectsNotFound] = useState(false);
  const [url, push, replace] = useV2Url('/');
  const [explainingLocal, setExplainingLocal] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [digest, setDigest] = useState<DigestDetailDto | null>(null);
  const [digestError, setDigestError] = useState<string | null>(null);
  const [expand, setExpand] = useState<string[]>([]);
  const [graph, setGraph] = useState<ProjectGraphDto | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [areaDetail, setAreaDetail] = useState<AreaDetailDto | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);
  const [areaGenerating, setAreaGenerating] = useState(false);
  const [hoverAreaId, setHoverAreaId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  // The reading pane defaults to ~60% of the width; the graph pane fills the rest.
  const [leftPct, setLeftPct] = useState(60);
  const narrow = useNarrow();
  const [graphSectionOpen, setGraphSectionOpen] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const level: ReadingLevel = url.level ?? 0;

  useEffect(() => {
    const ac = new AbortController();
    fetchProjects(ac.signal).then(setProjects, (e: unknown) => {
      if (e instanceof ApiError && e.status === 404) setProjectsNotFound(true);
      else setProjectsError(e instanceof Error ? e.message : String(e));
    });
    return () => ac.abort();
  }, []);

  const fallbackProjectId = useMemo(() => (projects ? defaultProject(projects, loadLastProject())?.id ?? null : null), [projects]);
  const currentProjectId = url.project ?? fallbackProjectId;
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

  useEffect(() => {
    setDigest(null);
    setDigestError(null);
    if (currentDigestId === null) return;
    const ac = new AbortController();
    fetchDigest(currentDigestId, ac.signal).then(setDigest, (e: unknown) => { if (!ac.signal.aborted) setDigestError(e instanceof Error ? e.message : String(e)); });
    return () => ac.abort();
  }, [currentDigestId]);

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
    fetchArea(currentDigestId, url.area, ac.signal).then(setAreaDetail, (e: unknown) => { if (!ac.signal.aborted) setAreaError(e instanceof Error ? e.message : String(e)); });
    return () => ac.abort();
  }, [currentDigestId, url.area]);

  const onGenerateArea = useCallback(() => {
    if (currentDigestId === null || url.area === null) return;
    const ac = new AbortController();
    generateRef.current?.abort();
    generateRef.current = ac;
    setAreaGenerating(true);
    explainArea(currentDigestId, url.area, ac.signal).then(
      (d) => {
        if (ac.signal.aborted) return;
        setAreaGenerating(false);
        setAreaDetail(d);
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
    if (filter) setAnnounce(READER.filterAnnounce(filter.path));
    else if (url.node === null && prevNodeRef.current !== null) setAnnounce(READER.filterCleared);
    prevNodeRef.current = url.node;
  }, [filter, url.node]);

  const openAreaItem = digest?.l2?.items.find((it) => it.id === url.area) ?? null;
  const walkthrough = areaDetail && areaDetail.areaId === url.area ? walkthroughOf(areaDetail) : null;
  const stepCount = walkthrough?.steps.length ?? 0;

  // The graph outlines the hovered area's nodes, else (at L2/L3) the selected area's.
  const outlinedAreaId = hoverAreaId ?? (level >= 2 && openAreaItem ? openAreaItem.id : null);
  const highlightNodeIds = useMemo(() => {
    if (!outlinedAreaId || !graph) return undefined;
    return new Set(graph.nodes.filter((n) => n.areaIds.includes(outlinedAreaId)).map((n) => n.id));
  }, [outlinedAreaId, graph]);

  // The reading pane is the one long scroll: a new digest, level or area starts at its top. A
  // step in the URL scrolls itself into view (WalkthroughView), so it is left alone here.
  useEffect(() => {
    if (url.step !== null) return;
    paneRef.current?.scrollTo?.({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDigestId, level, url.area]);

  const explaining = Boolean(status?.explaining) || explainingLocal;

  const onExplain = useCallback(() => {
    if (currentProjectId === null) return;
    setExplainingLocal(true);
    setExplainError(null);
    explainProject(currentProjectId)
      .then((r) => {
        if (r.digestId !== null) {
          digests.reload();
          // A new digest after Explain lands at L0 (docs/ux-v3.md §1).
          replace({ digest: r.digestId, level: null, node: null, area: null, step: null });
        }
      })
      .catch((e: unknown) => setExplainError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setExplainingLocal(false);
        refreshStatus();
      });
  }, [currentProjectId, refreshStatus, replace, digests]);

  const onRefreshContext = useCallback(() => {
    if (currentProjectId === null) return;
    setRefreshing(true);
    refreshContext(currentProjectId).finally(() => { setRefreshing(false); refreshStatus(); });
  }, [currentProjectId, refreshStatus]);

  const onSwitchProject = useCallback((id: number) => push({ project: id, digest: null, node: null, area: null, step: null }), [push]);
  const onSelectDigest = useCallback((id: number) => push({ digest: id, node: null, area: null, step: null }), [push]);
  const onLevel = useCallback((l: ReadingLevel) => push({ level: l === 0 ? null : l, step: null }), [push]);
  const onOpenArea = useCallback((id: string) => push({ level: 3, area: id, step: null }), [push]);
  const onStep = useCallback((n: number) => replace({ step: n }), [replace]);
  const onSelectNode = useCallback((node: GraphNode) => {
    setGraphSectionOpen(false);
    push(nodeTarget(node));
  }, [push]);
  const onClearFilter = useCallback(() => push({ node: null }), [push]);
  const onExpandGraphNode = useCallback((path: string) => setExpand((prev) => (prev.includes(path) ? prev : [...prev, path])), []);
  const toTop = () => paneRef.current?.scrollTo?.({ top: 0 });

  // Global reading keys: 0–3 switch level, n/p move between walkthrough steps.
  const keyState = useRef({ level, step: url.step, stepCount, onLevel, onStep });
  keyState.current = { level, step: url.step, stepCount, onLevel, onStep };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const action = readerKey(e);
      if (!action) return;
      const k = keyState.current;
      if (action.kind === 'level') {
        e.preventDefault();
        k.onLevel(action.level);
        setAnnounce(`${LEVELS[action.level].key} ${LEVELS[action.level].label}`);
      } else if (k.level === 3 && k.stepCount > 0) {
        const next = Math.min(k.stepCount, Math.max(1, (k.step ?? 0) + action.delta));
        if (next !== k.step) {
          e.preventDefault();
          k.onStep(next);
          setAnnounce(WALKTHROUGH.stepOf(next, k.stepCount));
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

  if (projectsNotFound) {
    return (
      <div className="box setup">
        <p className="muted">
          This server doesn't have the v2 project API yet. Use <strong>History</strong> above for the existing commit timeline and insights.
        </p>
      </div>
    );
  }
  if (projectsError) return <p role="alert" className="error">Could not load projects: {projectsError}</p>;
  if (projects === null) return <p className="muted">Loading…</p>;
  if (projects.length === 0) {
    return <SetupForm onCreated={(p) => { setProjects([p]); replace({ project: p.id }); }} />;
  }
  const currentProject = projects.find((p) => p.id === currentProjectId) ?? projects[0]!;
  const noBudget = (status?.budget.remaining ?? 1) === 0;

  const digestNotice = digest && digest.status !== 'ok' && (
    <div className={digest.status === 'error' ? 'notice error' : 'notice muted'} role={digest.status === 'error' ? 'alert' : 'status'}>
      <span>{digest.status === 'pending' ? READER.digestPending : digest.status === 'error' ? READER.digestError : READER.digestTruncated}</span>
      {digest.status !== 'pending' && (
        <button type="button" className="btn" onClick={() => onRetryDigest(digest.id)} disabled={retryingId !== null || noBudget}>
          {noBudget ? READER.retryNoBudget : retryingId === digest.id ? READER.retrying : READER.retry}
        </button>
      )}
    </div>
  );

  const levelView = !digest ? null
    : level === 0 ? <SummaryView digest={digest} onLevel={onLevel} />
      : level === 1 ? <ImpactView digest={digest} onLevel={onLevel} />
        : level === 2 ? (
          <StructureView
            digest={digest}
            filter={filter}
            selectedAreaId={url.area}
            onOpenArea={onOpenArea}
            onClearFilter={onClearFilter}
            onHoverArea={setHoverAreaId}
            onLevel={onLevel}
          />
        ) : !openAreaItem ? (
          <AreaPicker digest={digest} onOpenArea={onOpenArea} onHoverArea={setHoverAreaId} />
        ) : areaError ? (
          <p role="alert" className="error">{WALKTHROUGH.loadError(areaError)}</p>
        ) : areaDetail ? (
          <WalkthroughView
            area={areaGenerating ? { ...areaDetail, status: 'pending' } : areaDetail}
            item={openAreaItem}
            step={url.step}
            onStep={onStep}
            onGenerate={onGenerateArea}
            callsRemaining={status?.budget.remaining ?? null}
          />
        ) : (
          <p className="muted">{WALKTHROUGH.loading}</p>
        );

  const graphPane = graphError ? (
    <p role="alert" className="error">{GRAPH.loadError(graphError)}</p>
  ) : graph ? (
    <ProjectGraph graph={graph} highlightNodeIds={highlightNodeIds} selectedNodeId={url.node} onSelectNode={onSelectNode} onExpand={onExpandGraphNode} />
  ) : (
    <p className="muted">{GRAPH.loading}</p>
  );

  return (
    <div className={narrow ? 'main-v2 narrow' : 'main-v2'}>
      <div aria-live="polite" className="visually-hidden">{announce}</div>
      <div className="reader-top">
        <ProjectBar
          projects={projects}
          currentProject={currentProject}
          onSwitch={onSwitchProject}
          status={status}
          statusError={statusError}
          onRefreshContext={onRefreshContext}
          refreshing={refreshing}
          explaining={explaining}
          onExplain={onExplain}
        />
        {explainError && <p role="alert" className="error">Could not explain: {explainError}</p>}
        {digestError && <p role="alert" className="error">{READER.digestLoadError(digestError)}</p>}
        {!digestError && currentDigestId === null && digests.done && (
          <p className="empty">No digests yet. Use <strong>Explain changes since last check</strong> above to create the first one.</p>
        )}
        {!digestError && currentDigestId === null && !digests.done && <p className="muted">Loading…</p>}
        {!digestError && currentDigestId !== null && !digest && <p className="muted">{READER.loadingDigest}</p>}
        {digest && (
          <>
            <DigestPicker
              digests={digests}
              current={digests.items.find((d) => d.id === currentDigestId)}
              onSelect={onSelectDigest}
              onRetry={onRetryDigest}
              retryingId={retryingId}
              retryDisabled={noBudget}
            />
            <div className="reader-nav">
              <Breadcrumb
                digest={digest}
                level={level}
                area={openAreaItem}
                onDigest={() => { push({ level: null, area: null, step: null, node: null }); toTop(); }}
                onArea={() => { replace({ step: null }); toTop(); }}
                onLevel={() => { if (url.step !== null) replace({ step: null }); toTop(); }}
              />
              <LevelSwitcher level={level} onLevel={onLevel} />
            </div>
          </>
        )}
      </div>
      {digest && (
        <div className="reader-split">
          <div
            id={READING_PANE_ID}
            ref={paneRef}
            role="tabpanel"
            aria-labelledby={LEVEL_TAB_ID(level)}
            tabIndex={0}
            className="reading-pane"
            style={narrow ? undefined : { flexBasis: `${leftPct}%` }}
          >
            {digestNotice}
            {levelView}
          </div>
          {!narrow && <Divider pct={leftPct} onChange={setLeftPct} />}
          <aside className="graph-pane" aria-label={GRAPH.label}>
            {narrow && (
              <button type="button" className="btn graph-toggle" aria-expanded={graphSectionOpen} onClick={() => setGraphSectionOpen((o) => !o)}>
                {graphSectionOpen ? GRAPH.hide : GRAPH.show}
              </button>
            )}
            {(!narrow || graphSectionOpen) && graphPane}
          </aside>
        </div>
      )}
    </div>
  );
}
