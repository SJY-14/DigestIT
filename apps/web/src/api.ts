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
