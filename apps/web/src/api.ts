export interface Repo {
  id: number;
  name: string;
  headSha: string | null;
  ingestedAt: string | null;
}

export interface TimelineCommit {
  sha: string;
  changeId: number | null;
  parents: string[];
  authorName: string;
  authoredAt: string;
  committedAt: string;
  title: string;
  branchRefs: string[];
  isMerge: boolean;
  stats: { files: number; additions: number; deletions: number };
  l0: { status: 'ok' | 'pending' | 'error' | 'truncated'; content: { text?: string } | null };
}

export interface TimelinePage {
  commits: TimelineCommit[];
  nextCursor: string | null;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchRepos(signal?: AbortSignal): Promise<Repo[]> {
  return (await getJson<{ repos: Repo[] }>('/api/repos', signal)).repos;
}

export const PAGE_SIZE = 50;

export function fetchTimeline(repoId: number, cursor: string | null, signal?: AbortSignal): Promise<TimelinePage> {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) q.set('cursor', cursor);
  return getJson<TimelinePage>(`/api/repos/${repoId}/timeline?${q}`, signal);
}

export type Level = 0 | 1 | 2 | 3;
export type ExplanationStatus = 'ok' | 'pending' | 'error' | 'truncated';

export interface ChangeFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  filteredReason: string | null;
}

export interface ChangeDetail {
  id: number;
  title: string;
  headSha: string;
  commit: { authorName: string; committedAt: string; message: string } | null;
  files: ChangeFile[];
}

export interface Explanation {
  level: Level;
  status: ExplanationStatus;
  // Untrusted LLM output: fields are validated by the renderers before use.
  content: unknown;
  files?: (ChangeFile & { patch: string | null })[];
}

export function fetchChange(id: number, signal?: AbortSignal): Promise<ChangeDetail> {
  return getJson<ChangeDetail>(`/api/changes/${id}`, signal);
}

export function fetchExplanation(id: number, level: Level, signal?: AbortSignal): Promise<Explanation> {
  return getJson<Explanation>(`/api/changes/${id}/explanations/${level}`, signal);
}

// --- work units, window digest, metrics (M2) ---------------------------------------------------

export type UnitState = 'active' | 'handoff' | 'merged';

export interface Dirty {
  branch: string;
  files: number;
  additions: number;
  deletions: number;
  untracked: number;
  updatedAt: string;
}

export interface WorkUnitSummary {
  id: number;
  repoId: number;
  key: string;
  kind: 'issue' | 'branch';
  title: string;
  state: UnitState;
  tipSha: string | null;
  firstCommitAt: string;
  lastCommitAt: string;
  mergedAt: string | null;
  latestRangeUnitId: number | null;
  commitCount: number;
  // Untrusted LLM output inside content: validated by the renderers.
  l0: { status: ExplanationStatus; content: unknown };
  pendingBudget: boolean;
  dirty: Dirty[];
}

export interface WorkUnitMember {
  sha: string;
  changeId: number | null;
  authorName: string;
  committedAt: string;
  title: string;
  isMerge: boolean;
}

export interface WorkUnitDetail extends WorkUnitSummary {
  members: WorkUnitMember[];
  ranges: { id: number; headSha: string; isLatest: boolean }[];
  explanation: { changeUnitId: number; stale: boolean } | null;
}

export interface WindowDigest {
  since: string;
  until: string;
  workUnits: WorkUnitSummary[];
  rollup: { id: number; windowEnd: string; workUnitIds: number[]; content: unknown } | null;
}

export interface UnitMetrics {
  id: number;
  key: string;
  state: UnitState;
  landedAt: string | null;
  timeToLandSec: number | null;
  timeToExplainSec: number | null;
  timeToOpenSec: number | null;
  timeToDecideSec: number | null;
  decidedBy: 'reviewed' | 'merged' | null;
  levelsViewedBeforeDeciding: number[];
  reopens: number;
}

export interface Metrics {
  generatedAt: string;
  global: {
    unreadBacklog: number;
    undecidedBacklog: number;
    medianTimeToOpenSec: number | null;
    medianTimeToDecideSec: number | null;
    digestVsProduction: {
      windowDays: number;
      landed: number;
      decided: number;
      ratio: number | null;
      perDay: { day: string; landed: number; decided: number }[];
    };
  };
  units: UnitMetrics[];
}

export interface UnitsPage {
  workUnits: WorkUnitSummary[];
  nextCursor: string | null;
}

export function fetchUnits(repoId: number, cursor: string | null, signal?: AbortSignal): Promise<UnitsPage> {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE), repoId: String(repoId) });
  if (cursor) q.set('cursor', cursor);
  return getJson<UnitsPage>(`/api/work-units?${q}`, signal);
}

export function fetchUnit(key: string, repoId: number, signal?: AbortSignal): Promise<WorkUnitDetail> {
  return getJson<WorkUnitDetail>(`/api/work-units/${encodeURIComponent(key)}?repoId=${repoId}`, signal);
}

export function fetchWindow(since: string, signal?: AbortSignal): Promise<WindowDigest> {
  return getJson<WindowDigest>(`/api/window?since=${encodeURIComponent(since)}`, signal);
}

export function fetchMetrics(signal?: AbortSignal): Promise<Metrics> {
  return getJson<Metrics>('/api/metrics', signal);
}

export type OpenedVia = 'briefing' | 'map' | 'digest' | 'blindspots';

export interface UiEvent {
  kind: 'opened' | 'level_viewed' | 'reviewed';
  workUnitId: number;
  changeId?: number;
  level?: Level;
  ms?: number;
  /** Only meaningful on `opened`. If the server does not allowlist this field yet it fails the whole write, which `postUiEvent` swallows; callers should not rely on it being recorded. */
  via?: OpenedVia;
}

// --- insights (M3): drill-down from a chart mark to its work units -----------------------------

export interface DrillQuery {
  area?: string;
  day?: string;
  week?: string;
  metric?: string;
}

export interface DrillResult {
  workUnits: WorkUnitSummary[];
}

export function fetchInsightsDrill(query: DrillQuery, signal?: AbortSignal): Promise<DrillResult> {
  const q = new URLSearchParams();
  if (query.area) q.set('area', query.area);
  if (query.day) q.set('day', query.day);
  if (query.week) q.set('week', query.week);
  if (query.metric) q.set('metric', query.metric);
  return getJson<DrillResult>(`/api/insights/drill?${q}`, signal);
}

/** The only write the client does. The server requires same-origin plus this custom header (CSRF). */
export async function postUiEvent(ev: UiEvent): Promise<boolean> {
  try {
    const res = await fetch('/api/ui-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-digestit': '1' },
      body: JSON.stringify(ev),
    });
    return res.ok;
  } catch {
    return false;
  }
}
