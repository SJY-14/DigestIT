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
