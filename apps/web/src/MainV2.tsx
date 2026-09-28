// Main screen v2 (DIG-40, docs/direction-v2.md §5): setup form, project bar (switcher, context
// status, budget, Explain button), and the two-pane digest view (change list + project graph).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type {
  AreaDetailDto, DigestDetailDto, DigestL2Item, DigestSummaryDto, ExplainLanguage, GraphNode, ProjectDto, ProjectGraphDto,
  ProjectStatusDto,
} from '@digestit/core';
import {
  ApiError, createProject, explainArea, explainProject, fetchArea, fetchDigest, fetchGraph, fetchProjectStatus, fetchProjects,
  refreshContext, retryDigest, setProjectLanguage,
} from './v2Api.js';
import { useDigests } from './useDigests.js';
import { startLive } from './liveClient.js';
import {
  digestRowLabel, DIGEST_NO_CHANGES_EMPTY_STATE, DIGEST_STATUS_LABEL, explainOutcomeMessage, humanDateTime,
  NO_DIGESTS_EMPTY_STATE, NO_PROJECTS_EMPTY_STATE,
} from './copy.js';
import { ProjectGraph } from './ProjectGraph.js';
import { AreaView } from './AreaView.js';
import { ProjectHeader } from './ProjectHeader.js';
import { useV2Url } from './v2Url.js';

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
      <h2 className="box-head">{NO_PROJECTS_EMPTY_STATE.heading}</h2>
      <ol className="empty-steps">
        {NO_PROJECTS_EMPTY_STATE.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
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

// --- digest picker: past digests, newest first, infinite scroll --------------------------------

function statusChip(status: DigestSummaryDto['status']) {
  if (status === 'ok') return null;
  return <span className="badge digest-error">{DIGEST_STATUS_LABEL[status]}</span>;
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
        <span className="digest-l0">{digestRowLabel(d.toAt, d.stats.files, d.l0?.text ?? null)}</span>
        <span className="meta">
          <span className="stats">
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
          <span>{digestRowLabel(current.toAt, current.stats.files, current.l0?.text ?? null)}</span>
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

// --- change list: L0/L1, then one row per L2 area -----------------------------------------------

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

function areaStats(item: DigestL2Item, digest: DigestDetailDto): { additions: number; deletions: number } {
  const files = digest.files.filter((f) => item.paths.includes(f.path));
  return { additions: files.reduce((s, f) => s + f.additions, 0), deletions: files.reduce((s, f) => s + f.deletions, 0) };
}

function AreaRow({
  item, digest, expanded, onToggle, onHover, onOpenCode, onChipClick,
}: {
  item: DigestL2Item;
  digest: DigestDetailDto;
  expanded: boolean;
  onToggle: () => void;
  onHover: (hovering: boolean) => void;
  onOpenCode: () => void;
  onChipClick: (path: string) => void;
}) {
  const stats = areaStats(item, digest);
  return (
    <li className="area-row" onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <button
        type="button"
        className="area-row-main"
        aria-expanded={expanded}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        onClick={onToggle}
      >
        <span className="area-title">{item.title}</span>
        <span className="area-effect">{item.effect}</span>
      </button>
      <span className="area-chips">
        {item.paths.map((p) => (
          <button key={p} type="button" className="chip" onClick={() => onChipClick(p)}>{p}</button>
        ))}
      </span>
      <span className="stats area-stats">
        <span className="add">+{stats.additions}</span> <span className="del">−{stats.deletions}</span>
      </span>
      {expanded && (
        <div className="area-detail">
          <p><strong>How:</strong> {item.how}</p>
          <p><strong>Why:</strong> {item.why}</p>
          <button type="button" className="btn" onClick={onOpenCode}>Code (L3)</button>
        </div>
      )}
    </li>
  );
}

function ChangeList({
  digest, filter, onClearFilter, expandedIds, onToggleRow, onHoverArea, onOpenCode, onChipClick,
}: {
  digest: DigestDetailDto;
  filter: ListFilter | null;
  onClearFilter: () => void;
  expandedIds: ReadonlySet<string>;
  onToggleRow: (id: string) => void;
  onHoverArea: (id: string | null) => void;
  onOpenCode: (item: DigestL2Item) => void;
  onChipClick: (path: string) => void;
}) {
  const items = digest.l2?.items ?? [];
  const visible = filter ? items.filter((it) => filter.areaIds.has(it.id)) : items;
  return (
    <div className="change-list">
      {filter ? (
        <div className="filter-header">
          <code>{filter.path}</code>
          <span className="stats"><span className="add">+{filter.additions}</span> <span className="del">−{filter.deletions}</span></span>
          <span className="muted">{visible.length} of {items.length} changes</span>
          <button type="button" className="btn chip clear-filter" onClick={onClearFilter}>Clear ×</button>
        </div>
      ) : (
        <div className="digest-overview">
          <h2 className="l0">{digest.l0?.text ?? 'Not explained yet'}</h2>
          {digest.l1 && <ul className="l1-bullets">{digest.l1.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
        </div>
      )}
      {digest.l2 !== null && items.length === 0 && <p className="empty">{DIGEST_NO_CHANGES_EMPTY_STATE}</p>}
      <ul className="area-rows">
        {visible.map((it) => (
          <AreaRow
            key={it.id}
            item={it}
            digest={digest}
            expanded={expandedIds.has(it.id)}
            onToggle={() => onToggleRow(it.id)}
            onHover={(h) => onHoverArea(h ? it.id : null)}
            onOpenCode={() => onOpenCode(it)}
            onChipClick={onChipClick}
          />
        ))}
      </ul>
    </div>
  );
}

// --- resizable divider ---------------------------------------------------------------------------

const MIN_LEFT_PCT = 20;
const MAX_LEFT_PCT = 70;

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
  const [explainNotice, setExplainNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settingLanguage, setSettingLanguage] = useState(false);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [digest, setDigest] = useState<DigestDetailDto | null>(null);
  const [digestError, setDigestError] = useState<string | null>(null);
  const [expand, setExpand] = useState<string[]>([]);
  const [graph, setGraph] = useState<ProjectGraphDto | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [areaDetail, setAreaDetail] = useState<AreaDetailDto | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);
  const [areaGenerating, setAreaGenerating] = useState(false);
  const [hoverAreaId, setHoverAreaId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  // Left pane (change list) defaults to ~40% of the width; the right pane fills the rest.
  const [leftPct, setLeftPct] = useState(40);
  const narrow = useNarrow();
  const [graphSectionOpen, setGraphSectionOpen] = useState(true);

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

  useEffect(() => { setExpand([]); setExpandedIds(new Set()); }, [currentDigestId]);

  useEffect(() => {
    setGraph(null);
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
    // Cheap GET: never spends the budget. Generating L3 is a separate, explicit user action
    // (docs/direction-v2.md §4: "clicks to request L3"), wired below as onGenerateArea.
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
      // Leave areaError alone: the area is already loaded, so AreaView shows its own
      // error + Retry rather than replacing the pane with the "could not load" message.
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
    if (filter) setAnnounce(`Filtered to ${filter.path}`);
    else if (url.node === null && prevNodeRef.current !== null) setAnnounce('Filter cleared');
    prevNodeRef.current = url.node;
  }, [filter, url.node]);

  const highlightNodeIds = useMemo(() => {
    if (!hoverAreaId || !graph) return undefined;
    return new Set(graph.nodes.filter((n) => n.areaIds.includes(hoverAreaId)).map((n) => n.id));
  }, [hoverAreaId, graph]);

  const explaining = Boolean(status?.explaining) || explainingLocal;

  const onExplain = useCallback(() => {
    if (currentProjectId === null) return;
    setExplainingLocal(true);
    setExplainError(null);
    setExplainNotice(null);
    explainProject(currentProjectId)
      .then((r) => {
        if (r.noChanges) {
          setExplainNotice(explainOutcomeMessage('no_changes', undefined, ''));
          return;
        }
        if (r.status === 'pending') setExplainNotice(explainOutcomeMessage('budget', undefined, humanDateTime(r.budget.resetsAt)));
        if (r.digestId !== null) {
          digests.reload();
          replace({ digest: r.digestId, node: null, area: null });
        }
      })
      .catch((e: unknown) => {
        const detail = e instanceof Error ? e.message : String(e);
        setExplainError(explainOutcomeMessage('error', detail, ''));
      })
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

  const onSetLanguage = useCallback((language: ExplainLanguage) => {
    if (currentProjectId === null) return;
    setSettingLanguage(true);
    setLanguageError(null);
    setProjectLanguage(currentProjectId, language)
      .then((updated) => setProjects((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? prev))
      .catch((e: unknown) => setLanguageError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSettingLanguage(false));
  }, [currentProjectId]);

  const onSwitchProject = useCallback((id: number) => push({ project: id, digest: null, node: null, area: null }), [push]);
  const onSelectNode = useCallback((node: GraphNode) => push({ node: node.id, area: null }), [push]);
  const onChipClick = useCallback((path: string) => push({ node: `f:${path}`, area: null }), [push]);
  const onClearFilter = useCallback(() => push({ node: null }), [push]);
  // On narrow screens the right pane sits in a collapsible section; open it so Code (L3) is visible.
  const onOpenCode = useCallback((item: DigestL2Item) => { setGraphSectionOpen(true); push({ area: item.id }); }, [push]);
  const onBackToGraph = useCallback(() => push({ area: null }), [push]);
  const onExpandGraphNode = useCallback((path: string) => setExpand((prev) => (prev.includes(path) ? prev : [...prev, path])), []);
  const onToggleRow = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onRetryDigest = useCallback((id: number) => {
    setRetryingId(id);
    retryDigest(id).then(
      (d) => {
        digests.reload();
        if (id === currentDigestId) setDigest(d);
        else push({ digest: id, node: null, area: null });
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

  const openAreaItem = digest?.l2?.items.find((it) => it.id === url.area) ?? null;
  // A file node was selected (not a folder): open the area's L3 scrolled to that file first.
  const focusPath = url.node?.startsWith('f:') ? url.node.slice(2) : null;

  return (
    <div className="main-v2">
      <div aria-live="polite" className="visually-hidden">{announce}</div>
      <ProjectHeader
        projects={projects}
        currentProject={currentProject}
        onSwitch={onSwitchProject}
        status={status}
        statusError={statusError}
        explaining={explaining}
        onExplain={onExplain}
        onRefreshContext={onRefreshContext}
        refreshingContext={refreshing}
        onSetLanguage={onSetLanguage}
        settingLanguage={settingLanguage}
        languageError={languageError}
      />
      {explainError && <p role="alert" className="error">{explainError}</p>}
      {explainNotice && <p role="status" className="muted">{explainNotice}</p>}
      {digestError && <p role="alert" className="error">Could not load the digest: {digestError}</p>}
      {!digestError && currentDigestId === null && digests.done && (
        <div className="empty">
          <p>{NO_DIGESTS_EMPTY_STATE.heading}</p>
          <p className="muted">{NO_DIGESTS_EMPTY_STATE.body}</p>
        </div>
      )}
      {!digestError && currentDigestId === null && !digests.done && <p className="muted">Loading…</p>}
      {!digestError && currentDigestId !== null && !digest && <p className="muted">Loading digest…</p>}
      {digest && (
        <div className={narrow ? 'split-v2 stacked' : 'split-v2'}>
          <div className="left-pane" style={narrow ? undefined : { flexBasis: `${leftPct}%` }}>
            <DigestPicker
              digests={digests}
              current={digests.items.find((d) => d.id === currentDigestId)}
              onSelect={(id) => push({ digest: id, node: null, area: null })}
              onRetry={onRetryDigest}
              retryingId={retryingId}
              retryDisabled={(status?.budget.remaining ?? 1) === 0}
            />
            <ChangeList
              digest={digest}
              filter={filter}
              onClearFilter={onClearFilter}
              expandedIds={expandedIds}
              onToggleRow={onToggleRow}
              onHoverArea={setHoverAreaId}
              onOpenCode={onOpenCode}
              onChipClick={onChipClick}
            />
          </div>
          {!narrow && <Divider pct={leftPct} onChange={setLeftPct} />}
          <div className="right-pane-wrap">
            {narrow && (
              <button type="button" className="btn graph-toggle" aria-expanded={graphSectionOpen} onClick={() => setGraphSectionOpen((o) => !o)}>
                {graphSectionOpen ? 'Hide graph' : 'Show graph'}
              </button>
            )}
            {(!narrow || graphSectionOpen) && (
              <div className="right-pane">
                {url.area && openAreaItem ? (
                  areaError ? (
                    <p role="alert" className="error">Could not load this area: {areaError}</p>
                  ) : areaDetail ? (
                    <AreaView
                      area={areaGenerating ? { ...areaDetail, status: 'pending' } : areaDetail}
                      title={openAreaItem.title}
                      onBack={onBackToGraph}
                      focusPath={focusPath}
                      onGenerate={onGenerateArea}
                      callsRemaining={status?.budget.remaining ?? null}
                    />
                  ) : (
                    <p className="muted">Loading…</p>
                  )
                ) : graphError ? (
                  <p role="alert" className="error">Could not load the graph: {graphError}</p>
                ) : graph ? (
                  <ProjectGraph graph={graph} highlightNodeIds={highlightNodeIds} selectedNodeId={url.node} onSelectNode={onSelectNode} onExpand={onExpandGraphNode} />
                ) : (
                  <p className="muted">Loading graph…</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
