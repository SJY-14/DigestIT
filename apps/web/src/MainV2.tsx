// Main screen v2 (DIG-40, docs/direction-v2.md §5): setup form, project bar (switcher, context
// status, budget, Explain button), and the two-pane digest view (change list + project graph).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type {
  AreaDetailDto, DigestDetailDto, DigestL2Item, DigestSummaryDto, GraphNode, ProjectDto, ProjectGraphDto, ProjectStatusDto,
} from '@digestit/core';
import {
  ApiError, createProject, explainArea, explainProject, fetchArea, fetchDigest, fetchGraph, fetchProjectStatus, fetchProjects, refreshContext,
} from './v2Api.js';
import { useDigests } from './useDigests.js';
import { startLive } from './liveClient.js';
import { formatDate, relativeTime } from './format.js';
import { ProjectGraph } from './ProjectGraph.js';
import { AreaView } from './AreaView.js';
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
      <span className="muted explain-pending">{pendingLabel(status)}</span>
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
  projects, currentProject, onSwitch, status, onRefreshContext, refreshing, explaining, onExplain,
}: {
  projects: ProjectDto[];
  currentProject: ProjectDto;
  onSwitch: (id: number) => void;
  status: ProjectStatusDto | null;
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
        <span className="context-status muted">
          {status ? contextLabel(status) : 'Loading context…'}
        </span>
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

function DigestRow({ d, current, onSelect, onRetry }: { d: DigestSummaryDto; current: boolean; onSelect: () => void; onRetry: () => void }) {
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
      {retryable && <button type="button" className="btn retry" onClick={onRetry}>Retry</button>}
    </li>
  );
}

function DigestPicker({
  digests, current, onSelect, onRetry,
}: {
  digests: ReturnType<typeof useDigests>;
  current: DigestSummaryDto | undefined;
  onSelect: (id: number) => void;
  onRetry: (id: number) => void;
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
          <DigestRow key={d.id} d={d} current={d.id === current?.id} onSelect={() => onSelect(d.id)} onRetry={() => onRetry(d.id)} />
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
      {items.length === 0 && <p className="empty">No areas to show yet.</p>}
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
    onChange(Math.min(70, Math.max(20, next)));
  };
  const onPointerUp = () => { dragging.current = false; };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') onChange(Math.max(20, pct - 2));
    else if (e.key === 'ArrowRight') onChange(Math.min(70, pct + 2));
  };
  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={20}
      aria-valuemax={70}
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
      (s) => setStatus(s),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [projectId]);
  useEffect(() => { setStatus(null); refresh(); }, [refresh]);
  useEffect(() => {
    if (projectId === null) return undefined;
    return startLive({ onChange: refresh, onTransport: () => undefined });
  }, [projectId, refresh]);
  return { status, error, refresh };
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
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState('');
  // Right pane (project graph or, per DIG-41, the AreaView code view) defaults to ~55% of the width.
  const [leftPct, setLeftPct] = useState(45);
  const narrow = useNarrow();
  const [graphSectionOpen, setGraphSectionOpen] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    fetchProjects(ac.signal).then(setProjects, (e: unknown) => setProjectsError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, []);

  const currentProjectId = url.project ?? projects?.[0]?.id ?? null;
  useEffect(() => {
    if (url.project === null && projects && projects.length > 0) replace({ project: projects[0]!.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, url.project]);

  const { status, refresh: refreshStatus } = useProjectStatus(currentProjectId);
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

  useEffect(() => { setExpand([]); }, [currentDigestId]);

  useEffect(() => {
    setGraph(null);
    setGraphError(null);
    if (currentDigestId === null) return;
    const ac = new AbortController();
    fetchGraph(currentDigestId, expand, ac.signal).then(setGraph, (e: unknown) => { if (!ac.signal.aborted) setGraphError(e instanceof Error ? e.message : String(e)); });
    return () => ac.abort();
  }, [currentDigestId, expand]);

  useEffect(() => {
    setAreaDetail(null);
    setAreaError(null);
    setAreaGenerating(false);
    if (currentDigestId === null || url.area === null) return;
    const ac = new AbortController();
    // Cheap GET: never spends the budget. Generating L3 is a separate, explicit user action
    // (docs/direction-v2.md §4: "clicks to request L3"), wired below as onGenerateArea.
    fetchArea(currentDigestId, url.area, ac.signal).then(setAreaDetail, (e: unknown) => { if (!ac.signal.aborted) setAreaError(e instanceof Error ? e.message : String(e)); });
    return () => ac.abort();
  }, [currentDigestId, url.area]);

  const onGenerateArea = useCallback(() => {
    if (currentDigestId === null || url.area === null) return;
    setAreaGenerating(true);
    explainArea(currentDigestId, url.area).then(
      (d) => { setAreaGenerating(false); setAreaDetail(d); },
      // Leave areaError alone: the area is already loaded, so AreaView shows its own
      // error + Retry rather than replacing the pane with the "could not load" message.
      () => { setAreaGenerating(false); setAreaDetail((prev) => (prev ? { ...prev, status: 'error' } : prev)); },
    );
  }, [currentDigestId, url.area]);

  const filter = useMemo(() => (url.node && digest ? computeFilter(url.node, graph, digest) : null), [url.node, graph, digest]);

  useEffect(() => {
    if (filter) setAnnounce(`Filtered to ${filter.path}`);
    else if (url.node === null) setAnnounce('Filter cleared');
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
    explainProject(currentProjectId)
      .then((r) => {
        if (r.digestId !== null) {
          digests.reload();
          replace({ digest: r.digestId, node: null, area: null });
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

  const onSwitchProject = useCallback((id: number) => push({ project: id, digest: null, node: null, area: null }), [push]);
  const onSelectNode = useCallback((node: GraphNode) => push({ node: node.id, area: null }), [push]);
  const onChipClick = useCallback((path: string) => push({ node: `f:${path}`, area: null }), [push]);
  const onClearFilter = useCallback(() => push({ node: null }), [push]);
  const onOpenCode = useCallback((item: DigestL2Item) => push({ area: item.id }), [push]);
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
      <ProjectBar
        projects={projects}
        currentProject={currentProject}
        onSwitch={onSwitchProject}
        status={status}
        onRefreshContext={onRefreshContext}
        refreshing={refreshing}
        explaining={explaining}
        onExplain={onExplain}
      />
      {explainError && <p role="alert" className="error">Could not explain: {explainError}</p>}
      {digestError && <p role="alert" className="error">Could not load the digest: {digestError}</p>}
      {!digest && !digestError && <p className="muted">Loading digest…</p>}
      {digest && (
        <div className={narrow ? 'split-v2 stacked' : 'split-v2'}>
          <div className="left-pane">
            <DigestPicker
              digests={digests}
              current={digests.items.find((d) => d.id === currentDigestId)}
              onSelect={(id) => push({ digest: id, node: null, area: null })}
              onRetry={(id) => push({ digest: id })}
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
              <div className="right-pane" style={narrow ? undefined : { flexBasis: `${100 - leftPct}%` }}>
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
