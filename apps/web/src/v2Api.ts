// v2 API client (docs/direction-v2.md §5, DIG-39 contract in packages/core/src/v2.ts).
// DIG-39 has not landed yet: these calls 404 against today's server. Component tests use
// fixtures (v2Fixtures.ts) instead of a live fixture server.
import type {
  AreaDetailDto, ContextStatusDto, DigestDetailDto, DigestPageDto, ExplainResultDto,
  ProjectDto, ProjectGraphDto, ProjectStatusDto,
} from '@digestit/core';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function readError(res: Response): Promise<ApiError> {
  const message = await res.json().then(
    (b: unknown) => (b && typeof b === 'object' && typeof (b as { error?: unknown }).error === 'string' ? (b as { error: string }).error : null),
    () => null,
  );
  return new ApiError(message ?? `HTTP ${res.status}`, res.status);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-digestit': '1' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export function fetchProjects(signal?: AbortSignal): Promise<ProjectDto[]> {
  return getJson('/api/projects', signal);
}

export function createProject(rootPath: string, contextPath: string | null, signal?: AbortSignal): Promise<ProjectDto> {
  return postJson('/api/projects', { rootPath, contextPath }, signal);
}

export function fetchProjectStatus(id: number, signal?: AbortSignal): Promise<ProjectStatusDto> {
  return getJson(`/api/projects/${id}/status`, signal);
}

export function refreshContext(id: number, signal?: AbortSignal): Promise<ContextStatusDto> {
  return postJson(`/api/projects/${id}/context/refresh`, {}, signal);
}

export function explainProject(id: number, signal?: AbortSignal): Promise<ExplainResultDto> {
  return postJson(`/api/projects/${id}/explain`, {}, signal);
}

export const DIGEST_PAGE_SIZE = 20;

export function fetchDigests(projectId: number, cursor: string | null, signal?: AbortSignal): Promise<DigestPageDto> {
  const q = new URLSearchParams({ limit: String(DIGEST_PAGE_SIZE) });
  if (cursor) q.set('cursor', cursor);
  return getJson(`/api/projects/${projectId}/digests?${q}`, signal);
}

export function fetchDigest(id: number, signal?: AbortSignal): Promise<DigestDetailDto> {
  return getJson(`/api/digests/${id}`, signal);
}

export function fetchGraph(digestId: number, expand: string[], signal?: AbortSignal): Promise<ProjectGraphDto> {
  const q = new URLSearchParams();
  for (const e of expand) q.append('expand', e);
  const qs = q.toString();
  return getJson(`/api/digests/${digestId}/graph${qs ? `?${qs}` : ''}`, signal);
}

export function fetchArea(digestId: number, areaId: string, signal?: AbortSignal): Promise<AreaDetailDto> {
  return getJson(`/api/digests/${digestId}/areas/${encodeURIComponent(areaId)}`, signal);
}

export function explainArea(digestId: number, areaId: string, signal?: AbortSignal): Promise<AreaDetailDto> {
  return postJson(`/api/digests/${digestId}/areas/${encodeURIComponent(areaId)}/explain`, {}, signal);
}
