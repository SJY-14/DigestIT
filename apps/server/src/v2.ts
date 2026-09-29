// v2 API (DIG-39, docs/direction-v2.md): projects, digests, areas and the project graph.
// DTOs are defined once in packages/core/src/v2.ts; this file only maps DB rows onto them and
// wires the ingest/explain packages together. Auth/CSRF for the POST routes here lives in app.ts's
// top-level onRequest hook (the write-token gate), not in this file.
import { realpathSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import {
  EXPLAIN_LANGUAGES,
  buildProjectGraph,
  type AreaProgressEvent, type ChangeStatus, type CreateProjectResponseDto, type DigestAreaSkeleton,
  type DigestL2Content, type DigestFileDto, type DigestPartsDto, type ExplainLanguage,
  type ExplanationStatus, type NotTrackedGroupDto, type ProjectDto, type ProjectGraphDto, type ProjectIgnoreDto,
  type SkipReason,
} from '@digestit/core';
import {
  AreaExplainRunningError, DEFAULT_DAILY_BUDGET, ExplainJobRunner, ProjectLockedError, addIgnorePatterns,
  budgetStatus, initProject, isValidIgnorePattern, latestCheckpoint,
  listProjects, listTree, openShadow, projectDataDir, projectStatus,
  readIgnorePatterns, refreshContext, removeIgnorePatterns, updateProjectLanguage, type ProjectRow,
} from '@digestit/ingest';
import {
  AREA_PROMPT_VERSION, createProvider,
  type ExplanationProvider,
} from '@digestit/explain';
import { CSP } from './csp.js';

export interface V2Options {
  /** DigestIT's data dir ($DIGESTIT_HOME), for shadow stores and project_data dirs. */
  home: string;
  /** Realpath'd roots a browser-initiated `POST /api/projects` may register under. Empty/unset: 403. */
  projectRoots?: string[];
  /** Daily LLM call budget, shared with the CLI (default `DEFAULT_DAILY_BUDGET`). */
  budgetLimit?: number;
  /** Builds a per-request provider scoped to a repo-name allowlist; null when misconfigured. */
  providerFactory?: (allow: string[]) => ExplanationProvider | null;
  /** Injected clock for tests. */
  now?: () => Date;
  /** Cap on the graph LRU (default 50); one entry per (digestId, sorted expand). */
  graphCacheSize?: number;
}

type Row = Record<string, unknown>;

const V2_BODY_LIMIT = 8192;
const MAX_EXPAND = 20;
const DIGEST_EVENTS_MAX_STREAMS = 16;
const DIGEST_EVENTS_HEARTBEAT_MS = 15_000;

/** The graph `expand` query (one or repeated `expand=<dir>`), or null if it asks for too many. */
function parseExpand(raw: unknown): string[] | null {
  const expand = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]).map(String);
  return expand.length > MAX_EXPAND ? null : expand;
}

/** Every folder (and the root, '') that appears in `paths`: the valid `expand` values. */
function dirsOf(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>(['']);
  for (const p of paths) {
    if (p === '') continue;
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}
const DEFAULT_DIGEST_LIMIT = 20;
const MAX_DIGEST_LIMIT = 100;

const parseId = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);
const parseJson = <T>(v: unknown, fallback: T): T => {
  try {
    return JSON.parse(v as string) as T;
  } catch {
    return fallback;
  }
};

function encodeCursor(epoch: number, id: number): string {
  return Buffer.from(JSON.stringify([epoch, id])).toString('base64url');
}
function decodeCursor(cursor: string): [number, number] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && Number.isInteger(v[0]) && Number.isInteger(v[1])) return [v[0], v[1]];
  } catch {
    /* fall through */
  }
  return null;
}

/** A small LRU keyed by an opaque string; used for the graph cache (one entry per digest+expand). */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
  /** Drops every entry for one digest (its L2 areas may have changed on retry). */
  deleteDigest(digestId: number): void {
    const prefix = `${digestId}|`;
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
}

/** Thrown by the in-flight guards below; always mapped to 409, never anything the caller retries on its own. */
class InFlightError extends Error {}

const fileDto = (f: Row): DigestFileDto => ({
  path: f.path as string,
  oldPath: (f.old_path as string | null) ?? null,
  status: f.status as ChangeStatus,
  additions: f.additions as number,
  deletions: f.deletions as number,
  filteredReason: (f.filtered_reason as DigestFileDto['filteredReason']) ?? null,
});

export function registerV2(app: FastifyInstance, db: DatabaseSync, opts: V2Options): void {
  const { home } = opts;
  const budgetLimit = opts.budgetLimit ?? DEFAULT_DAILY_BUDGET;
  const now = opts.now ?? (() => new Date());
  const graphCache = new Lru<ProjectGraphDto>(opts.graphCacheSize ?? 50);
  const projectRoots = opts.projectRoots ?? [];
  // In-process one-at-a-time guard (409 `explain_running`) for a context refresh: it has no file
  // lock of its own, and a manual refresh racing a first Explain's context part would otherwise
  // spend two budget calls for one piece of work.
  const contextInFlight = new Set<number>();
  const providerFactory =
    opts.providerFactory ??
    ((allow: string[]): ExplanationProvider | null => {
      const name = process.env.DIGESTIT_PROVIDER ?? 'stub';
      if (name !== 'stub' && name !== 'claude-code') return null;
      return createProvider({
        provider: name,
        repoAllowlist: allow,
        claudeBin: process.env.DIGESTIT_CLAUDE_BIN,
        claudeModel: process.env.DIGESTIT_CLAUDE_MODEL,
      });
    });
  // Fast Explain (DIG-75): the async job runner behind POST /explain, POST /digests/:id/explain
  // (retry) and POST .../areas/:areaId/explain. One instance per server process, holding the
  // in-memory "still running" state that GET /api/digests/:id and the SSE stream below read from.
  const jobRunner = new ExplainJobRunner(db, home, { budget: budgetLimit, now, contextBusy: (repoId) => contextInFlight.has(repoId) });

  const latestExplanation = db.prepare(
    `SELECT content, status, created_at FROM explanation WHERE change_unit_id = ? AND level = ?
     ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`,
  );
  const findProjectRow = (id: number): ProjectRow | undefined => {
    const r = db.prepare("SELECT id, name, path, language, context_path, created_at FROM repo WHERE id = ? AND mode = 'project'")
      .get(id) as { id: number; name: string; path: string; language: ExplainLanguage; context_path: string | null; created_at: string | null } | undefined;
    return r ? { id: r.id, name: r.name, path: r.path, language: r.language, contextPath: r.context_path, createdAt: r.created_at } : undefined;
  };

  function contextStatusOf(repoId: number, hasUserContext: boolean) {
    const row = db.prepare(
      `SELECT status, created_at AS createdAt, from_files AS fromFiles FROM project_context
       WHERE repo_id = ? ORDER BY (status = 'ok') DESC, created_at DESC, id DESC LIMIT 1`,
    ).get(repoId) as { status: ExplanationStatus; createdAt: string; fromFiles: number | null } | undefined;
    if (!row) return { status: 'none' as const, builtAt: null, fromFiles: null, hasUserContext };
    return { status: row.status, builtAt: row.createdAt, fromFiles: row.fromFiles, hasUserContext };
  }

  function projectRowToDto(row: ProjectRow): ProjectDto {
    const latest = latestCheckpoint(db, row.id);
    const digestCount = (db.prepare('SELECT count(*) AS n FROM digest WHERE repo_id = ?').get(row.id) as { n: number }).n;
    return {
      id: row.id,
      name: row.name,
      rootPath: row.path,
      language: row.language,
      context: contextStatusOf(row.id, row.contextPath !== null),
      lastCheckpointAt: latest?.takenAt ?? null,
      digestCount,
    };
  }

  const NOT_TRACKED_EXAMPLES = 5;
  const MAX_IGNORE_PATTERNS_PER_REQUEST = 100;
  /** Paths not stored in the shadow, from the latest checkpoint, grouped by why (DIG-56). */
  function notTrackedGroups(repoId: number): NotTrackedGroupDto[] {
    const latest = latestCheckpoint(db, repoId);
    if (!latest) return [];
    const groups = new Map<SkipReason, { count: number; examples: string[] }>();
    for (const s of latest.skipped) {
      const g = groups.get(s.reason) ?? { count: 0, examples: [] };
      g.count++;
      if (g.examples.length < NOT_TRACKED_EXAMPLES) g.examples.push(s.path);
      groups.set(s.reason, g);
    }
    return [...groups.entries()].map(([reason, g]) => ({ reason, count: g.count, examples: g.examples }));
  }

  /** Guarded by `contextInFlight`: throws `InFlightError` instead of racing a concurrent build for the same project. */
  async function withContextGuard<T>(row: ProjectRow, fn: () => Promise<T>): Promise<T> {
    if (contextInFlight.has(row.id)) throw new InFlightError();
    contextInFlight.add(row.id);
    try {
      return await fn();
    } finally {
      contextInFlight.delete(row.id);
    }
  }

  // Also refused while an Explain's own `context` part is building it (first Explain of a project).
  const buildContextFor = (row: ProjectRow, provider: ExplanationProvider) => {
    if (jobRunner.isContextRunning(row.id)) throw new InFlightError();
    return withContextGuard(row, () => refreshContext(db, home, row, provider, { budget: budgetLimit, now }));
  };

  function loadDigestL2(digestId: number): DigestL2Content | null {
    const row = latestExplanation.get(digestId, 2) as { content: string; status: string } | undefined;
    return row ? parseJson<DigestL2Content>(row.content, { items: [], notAnalysed: [] }) : null;
  }

  function loadFiles(digestId: number, paths?: readonly string[]): Row[] {
    if (paths && paths.length === 0) return [];
    const pathFilter = paths ? ` AND path IN (${paths.map(() => '?').join(',')})` : '';
    return db.prepare(
      `SELECT path, old_path, status, additions, deletions, patch, filtered_reason
       FROM file_change WHERE change_unit_id = ?${pathFilter} ORDER BY path`,
    ).all(digestId, ...(paths ?? [])) as Row[];
  }

  function loadDigestDetail(digestId: number): Row | null {
    const d = db.prepare(
      `SELECT d.repo_id AS repoId, d.created_at AS createdAt, d.stats AS stats, d.language AS language, d.areas AS areas,
              fromCp.seq AS seq, fromCp.taken_at AS fromAt, toCp.taken_at AS toAt, toCp.skipped AS skipped
       FROM digest d
       JOIN checkpoint fromCp ON fromCp.id = d.from_checkpoint_id
       JOIN checkpoint toCp ON toCp.id = d.to_checkpoint_id
       WHERE d.change_unit_id = ?`,
    ).get(digestId) as {
      repoId: number; createdAt: string; stats: string; language: ExplainLanguage; areas: string | null;
      seq: number; fromAt: string; toAt: string; skipped: string;
    } | undefined;
    if (!d) return null;
    const l0 = latestExplanation.get(digestId, 0) as { content: string; status: ExplanationStatus } | undefined;
    const l1 = latestExplanation.get(digestId, 1) as { content: string } | undefined;
    const l2 = latestExplanation.get(digestId, 2) as { content: string } | undefined;
    // Absent (not just null) for a digest created before DIG-75, which has no stored areas/parts.
    const areas: DigestAreaSkeleton[] | undefined = d.areas ? parseJson(d.areas, undefined) : undefined;
    const parts: DigestPartsDto | undefined = areas ? (jobRunner.getParts(digestId) ?? undefined) : undefined;
    return {
      id: digestId,
      projectId: d.repoId,
      seq: d.seq,
      fromAt: d.fromAt,
      toAt: d.toAt,
      stats: parseJson(d.stats, { files: 0, additions: 0, deletions: 0 }),
      status: l0?.status ?? 'pending',
      l0: l0 ? parseJson(l0.content, null) : null,
      l1: l1 ? parseJson(l1.content, null) : null,
      l2: l2 ? parseJson(l2.content, null) : null,
      files: loadFiles(digestId).map(fileDto),
      skipped: parseJson<{ path: string; reason: SkipReason }[]>(d.skipped, []),
      language: d.language,
      areas,
      parts,
    };
  }

  function loadAreaDetail(digestId: number, areaId: string, l2: DigestL2Content): Row | { error: 'not_found' } {
    const item = l2.items.find((it) => it.id === areaId);
    if (!item) return { error: 'not_found' };
    // Only the current walkthrough shape: rows from an older area prompt read as 'none' and are regenerated on request.
    const row = db.prepare(
      `SELECT content, status FROM area_explanation WHERE change_unit_id = ? AND area_id = ? AND prompt_version = ?
       ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`,
    ).get(digestId, areaId, AREA_PROMPT_VERSION) as { content: string; status: ExplanationStatus } | undefined;
    const files = loadFiles(digestId, item.paths).map((f) => ({ ...fileDto(f), patch: (f.patch as string | null) ?? null }));
    return {
      digestId,
      areaId,
      // While an L3 job runs (DIG-75) the walkthrough streams over GET /api/digests/:id/events.
      status: jobRunner.isAreaRunning(digestId, areaId) ? 'pending' : (row?.status ?? 'none'),
      l3: row ? parseJson(row.content, null) : null,
      files,
    };
  }

  // ---- GET (read-only, today's rules: no token unless DIGESTIT_ALLOWED_HOSTS is configured) ----

  app.get('/api/budget', async () => budgetStatus(db, now(), budgetLimit));

  app.get('/api/projects', async () => listProjects(db).map(projectRowToDto));

  app.get<{ Params: { id: string } }>('/api/projects/:id/status', async (req, reply) => {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : findProjectRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const s = await projectStatus(db, home, row, now(), budgetLimit);
    return {
      project: projectRowToDto(row), pending: s.pending, budget: s.budget,
      explaining: s.explaining, explainStartedAt: s.explainStartedAt,
    };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/api/projects/:id/graph', async (req, reply) => {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : findProjectRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const expand = parseExpand(req.query.expand);
    if (expand === null) return reply.code(400).send({ error: 'too_many_expand' });

    const latest = latestCheckpoint(db, row.id);
    if (!latest) return { digestId: null, nodes: [], edges: [], totalFiles: 0, truncated: false } satisfies ProjectGraphDto;

    const shadow = await openShadow(projectDataDir(home, row.id), row.path);
    const paths = await listTree(shadow, latest.treeSha);
    const validDirs = dirsOf(paths);
    if (expand.some((e) => !validDirs.has(e))) return reply.code(400).send({ error: 'bad_expand' });
    const result = buildProjectGraph({ paths, files: [], expand });
    return { digestId: null, ...result } satisfies ProjectGraphDto;
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/ignore', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null || !findProjectRow(id)) return reply.code(404).send({ error: 'not_found' });
    const dto: ProjectIgnoreDto = { patterns: readIgnorePatterns(projectDataDir(home, id)), notTracked: notTrackedGroups(id) };
    return dto;
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/api/projects/:id/digests',
    async (req, reply) => {
      const id = parseId(req.params.id);
      if (id === null || !findProjectRow(id)) return reply.code(404).send({ error: 'not_found' });
      let limit = DEFAULT_DIGEST_LIMIT;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1) return reply.code(400).send({ error: 'bad_limit' });
        limit = Math.min(limit, MAX_DIGEST_LIMIT);
      }
      let where = 'd.repo_id = ?';
      const params: (string | number)[] = [id];
      if (req.query.cursor !== undefined) {
        const cur = decodeCursor(req.query.cursor);
        if (!cur) return reply.code(400).send({ error: 'bad_cursor' });
        where += ' AND (unixepoch(d.created_at) < ? OR (unixepoch(d.created_at) = ? AND d.change_unit_id < ?))';
        params.push(cur[0], cur[0], cur[1]);
      }
      params.push(limit + 1);
      const rows = db.prepare(
        `SELECT d.change_unit_id AS id, d.created_at AS createdAt, unixepoch(d.created_at) AS epoch, d.stats AS stats,
                d.language AS language, fromCp.seq AS seq, fromCp.taken_at AS fromAt, toCp.taken_at AS toAt
         FROM digest d
         JOIN checkpoint fromCp ON fromCp.id = d.from_checkpoint_id
         JOIN checkpoint toCp ON toCp.id = d.to_checkpoint_id
         WHERE ${where} ORDER BY epoch DESC, d.change_unit_id DESC LIMIT ?`,
      ).all(...params) as Row[];
      const page = rows.slice(0, limit);
      const items = page.map((r) => {
        const l0 = latestExplanation.get(r.id as number, 0) as { content: string; status: ExplanationStatus } | undefined;
        return {
          id: r.id, seq: r.seq, fromAt: r.fromAt, toAt: r.toAt,
          stats: parseJson(r.stats, { files: 0, additions: 0, deletions: 0 }),
          status: l0?.status ?? 'pending',
          l0: l0 ? parseJson(l0.content, null) : null,
          language: r.language,
        };
      });
      const last = page[page.length - 1];
      const nextCursor = rows.length > limit && last ? encodeCursor(last.epoch as number, last.id as number) : null;
      return { items, nextCursor };
    },
  );

  app.get<{ Params: { id: string } }>('/api/digests/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    const detail = id === null ? null : loadDigestDetail(id);
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return detail;
  });

  // Fast Explain (DIG-75, docs/explain-speed.md §5): `event: parts` (DigestPartsDto) on connect and
  // on every part status change, `event: area-progress` while an L3 walkthrough streams under this
  // digest, `event: done` once nothing is running for it, then the server closes the stream. Events
  // are not replayed -- a reconnect gets the current `parts` and refetches. Bounded like /api/stream.
  let digestEventStreams = 0;
  app.get<{ Params: { id: string } }>('/api/digests/:id/events', (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null || !loadDigestDetail(id)) return reply.code(404).send({ error: 'not_found' });
    if (digestEventStreams >= DIGEST_EVENTS_MAX_STREAMS) {
      return reply.code(503).header('retry-after', '5').send({ error: 'too_many_streams' });
    }
    digestEventStreams++;
    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    let seq = 0;
    let closed = false;
    const send = (event: string, data: unknown) => {
      if (closed) return;
      raw.write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => { if (!closed) raw.write(': heartbeat\n\n'); }, DIGEST_EVENTS_HEARTBEAT_MS);
    heartbeat.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubParts();
      unsubArea();
      digestEventStreams--;
      req.raw.off('close', cleanup);
      raw.off('close', cleanup);
      raw.off('error', cleanup);
      raw.end();
    };
    const checkDone = () => {
      if (jobRunner.isDone(id)) {
        send('done', {});
        cleanup();
      }
    };
    const unsubParts = jobRunner.subscribeParts(id, (dto: DigestPartsDto) => {
      send('parts', dto);
      checkDone();
    });
    const unsubArea = jobRunner.subscribeAreaProgress(id, (e: AreaProgressEvent) => {
      send('area-progress', e);
      checkDone();
    });
    req.raw.on('close', cleanup);
    raw.on('close', cleanup);
    raw.on('error', cleanup);

    const initialParts = jobRunner.getParts(id);
    if (initialParts) send('parts', initialParts);
    checkDone();
  });

  app.get<{ Params: { id: string; areaId: string } }>('/api/digests/:id/areas/:areaId', async (req, reply) => {
    const id = parseId(req.params.id);
    const l2 = id === null ? null : loadDigestL2(id);
    if (id === null || !l2) return reply.code(404).send({ error: 'not_found' });
    const detail = loadAreaDetail(id, req.params.areaId, l2);
    if ('error' in detail) return reply.code(404).send({ error: detail.error });
    return detail;
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/api/digests/:id/graph',
    async (req, reply) => {
      const id = parseId(req.params.id);
      const digestRow = id === null ? undefined : db.prepare(
        `SELECT d.repo_id AS repoId, toCp.tree_sha AS treeSha, r.path AS projectPath
         FROM digest d JOIN checkpoint toCp ON toCp.id = d.to_checkpoint_id JOIN repo r ON r.id = d.repo_id
         WHERE d.change_unit_id = ?`,
      ).get(id) as { repoId: number; treeSha: string; projectPath: string } | undefined;
      if (!digestRow) return reply.code(404).send({ error: 'not_found' });

      const expand = parseExpand(req.query.expand);
      if (expand === null) return reply.code(400).send({ error: 'too_many_expand' });

      // JSON-encoded, not comma-joined: a folder name can itself contain a comma, which would
      // otherwise let e.g. expand=["a,b"] collide with expand=["a","b"].
      const cacheKey = `${id}|${JSON.stringify([...expand].sort())}`;
      const cached = graphCache.get(cacheKey);
      if (cached) return cached;

      const files = loadFiles(id!).map((f) => ({
        path: f.path as string, status: f.status as ChangeStatus,
        additions: f.additions as number, deletions: f.deletions as number,
      }));
      const shadow = await openShadow(projectDataDir(home, digestRow.repoId), digestRow.projectPath);
      const paths = await listTree(shadow, digestRow.treeSha);

      const validDirs = dirsOf([...paths, ...files.map((f) => f.path)]);
      if (expand.some((e) => !validDirs.has(e))) return reply.code(400).send({ error: 'bad_expand' });

      // The deterministic `digest.areas` (DIG-75) are final when the digest is created, so a graph
      // cached while its LLM parts still run stays right; older digests only have the level-2 row.
      const stored = db.prepare('SELECT areas FROM digest WHERE change_unit_id = ?').get(id) as { areas: string | null };
      const skeleton = stored.areas ? parseJson<DigestAreaSkeleton[] | null>(stored.areas, null) : null;
      const areas = skeleton
        ? skeleton.map((a) => ({ id: a.id, paths: a.paths }))
        : loadDigestL2(id!)?.items.map((it) => ({ id: it.id, paths: it.paths }));
      const result = buildProjectGraph({ paths, files, areas, expand });
      const dto: ProjectGraphDto = { digestId: id!, ...result };
      graphCache.set(cacheKey, dto);
      return dto;
    },
  );

  // ---- POST (writes; app.ts's onRequest hook enforces the token, CSRF and content-type here) ----

  app.post<{ Body: { rootPath?: unknown; contextPath?: unknown } }>(
    '/api/projects',
    { bodyLimit: V2_BODY_LIMIT },
    async (req, reply) => {
      if (projectRoots.length === 0) return reply.code(403).send({ error: 'project_roots_not_configured' });
      const body = req.body;
      if (typeof body !== 'object' || body === null) return reply.code(400).send({ error: 'bad_body' });
      const { rootPath, contextPath } = body as { rootPath?: unknown; contextPath?: unknown };
      if (typeof rootPath !== 'string' || rootPath.trim() === '') return reply.code(400).send({ error: 'bad_root_path' });
      if (contextPath !== undefined && contextPath !== null && typeof contextPath !== 'string') {
        return reply.code(400).send({ error: 'bad_context_path' });
      }
      let real: string;
      try {
        real = realpathSync(resolvePath(rootPath));
      } catch {
        return reply.code(400).send({ error: 'root_not_found' });
      }
      const allowed = projectRoots.some((root) => real === root || real.startsWith(root + sep));
      if (!allowed) return reply.code(403).send({ error: 'root_not_allowed' });

      let realContextPath: string | undefined;
      if (typeof contextPath === 'string') {
        let rc: string;
        try {
          rc = realpathSync(resolvePath(contextPath));
        } catch {
          return reply.code(400).send({ error: 'context_not_found' });
        }
        // Its content is sent to the LLM as project context: it must live inside the project root
        // just validated above, not anywhere else readable by the server (same symlink-escape rule).
        if (rc !== real && !rc.startsWith(real + sep)) return reply.code(403).send({ error: 'context_not_allowed' });
        realContextPath = rc;
      }
      try {
        const result = await initProject(db, home, real, { contextPath: realContextPath }, now);
        const dto: CreateProjectResponseDto = {
          ...projectRowToDto(findProjectRow(result.repoId)!),
          suggestedIgnorePatterns: result.suggestedIgnorePatterns,
        };
        return reply.code(201).send(dto);
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : 'init_failed' });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { action?: unknown; patterns?: unknown } }>(
    '/api/projects/:id/ignore',
    { bodyLimit: V2_BODY_LIMIT },
    async (req, reply) => {
      const id = parseId(req.params.id);
      if (id === null || !findProjectRow(id)) return reply.code(404).send({ error: 'not_found' });
      const body = req.body;
      if (typeof body !== 'object' || body === null) return reply.code(400).send({ error: 'bad_body' });
      const { action, patterns } = body as { action?: unknown; patterns?: unknown };
      if (action !== 'add' && action !== 'remove') return reply.code(400).send({ error: 'bad_action' });
      if (
        !Array.isArray(patterns) || patterns.length === 0 || patterns.length > MAX_IGNORE_PATTERNS_PER_REQUEST ||
        !patterns.every((p) => typeof p === 'string' && isValidIgnorePattern(p))
      ) {
        return reply.code(400).send({ error: 'bad_patterns' });
      }
      const dataDir = projectDataDir(home, id);
      const next = action === 'add' ? await addIgnorePatterns(dataDir, patterns) : await removeIgnorePatterns(dataDir, patterns);
      const dto: ProjectIgnoreDto = { patterns: next, notTracked: notTrackedGroups(id) };
      return dto;
    },
  );

  app.patch<{ Params: { id: string }; Body: { language?: unknown } }>(
    '/api/projects/:id',
    { bodyLimit: V2_BODY_LIMIT },
    async (req, reply) => {
      const id = parseId(req.params.id);
      const row = id === null ? undefined : findProjectRow(id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const body = req.body;
      if (typeof body !== 'object' || body === null) return reply.code(400).send({ error: 'bad_body' });
      const { language } = body as { language?: unknown };
      if (typeof language !== 'string' || !(EXPLAIN_LANGUAGES as readonly string[]).includes(language)) {
        return reply.code(400).send({ error: 'bad_language' });
      }
      updateProjectLanguage(db, id!, language as ExplainLanguage);
      return projectRowToDto(findProjectRow(id!)!);
    },
  );

  // Fast Explain (DIG-75): each of the next three routes returns as soon as its own no-LLM prep is
  // done and the LLM parts have started in the background -- it does not wait for them. Progress is
  // read from GET /api/digests/:id (parts/areas) or streamed from GET /api/digests/:id/events.
  app.post<{ Params: { id: string } }>('/api/projects/:id/explain', { bodyLimit: V2_BODY_LIMIT }, async (req, reply) => {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : findProjectRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const provider = providerFactory([row.name]);
    if (!provider) return reply.code(500).send({ error: 'no_provider' });
    try {
      const r = await jobRunner.start(row, provider);
      const budget = budgetStatus(db, now(), budgetLimit);
      if (r.noChanges) return { noChanges: true, digestId: null, status: null, budget };
      graphCache.deleteDigest(r.digestId!);
      return { noChanges: false, digestId: r.digestId, status: 'pending', budget };
    } catch (e) {
      if (e instanceof ProjectLockedError) return reply.code(409).send({ error: 'explain_running' });
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'explain_failed' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/digests/:id/explain', { bodyLimit: V2_BODY_LIMIT }, async (req, reply) => {
    const id = parseId(req.params.id);
    const digestRow = id === null ? undefined : (db.prepare('SELECT repo_id AS repoId FROM digest WHERE change_unit_id = ?').get(id) as { repoId: number } | undefined);
    const project = digestRow ? findProjectRow(digestRow.repoId) : undefined;
    if (!digestRow || !project) return reply.code(404).send({ error: 'not_found' });
    const provider = providerFactory([project.name]);
    if (!provider) return reply.code(500).send({ error: 'no_provider' });
    try {
      await jobRunner.retry(project, id!, provider);
      graphCache.deleteDigest(id!);
      const detail = loadDigestDetail(id!);
      if (!detail) return reply.code(404).send({ error: 'not_found' });
      return detail;
    } catch (e) {
      if (e instanceof ProjectLockedError) return reply.code(409).send({ error: 'explain_running' });
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'explain_failed' });
    }
  });

  app.post<{ Params: { id: string; areaId: string } }>(
    '/api/digests/:id/areas/:areaId/explain',
    { bodyLimit: V2_BODY_LIMIT },
    async (req, reply) => {
      const id = parseId(req.params.id);
      const digestRow = id === null ? undefined : (db.prepare('SELECT repo_id AS repoId, language FROM digest WHERE change_unit_id = ?')
        .get(id) as { repoId: number; language: ExplainLanguage } | undefined);
      const l2 = id !== null && digestRow ? loadDigestL2(id) : null;
      const project = digestRow ? findProjectRow(digestRow.repoId) : undefined;
      if (!digestRow || !project || !l2 || !l2.items.some((it) => it.id === req.params.areaId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const provider = providerFactory([project.name]);
      if (!provider) return reply.code(500).send({ error: 'no_provider' });
      try {
        await jobRunner.startArea(project, id!, req.params.areaId, provider);
      } catch (e) {
        if (e instanceof AreaExplainRunningError) return reply.code(409).send({ error: 'explain_running' });
        return reply.code(500).send({ error: e instanceof Error ? e.message : 'explain_failed' });
      }
      const detail = loadAreaDetail(id!, req.params.areaId, l2);
      return 'error' in detail ? reply.code(404).send({ error: detail.error }) : detail;
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/context/refresh', { bodyLimit: V2_BODY_LIMIT }, async (req, reply) => {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : findProjectRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const provider = providerFactory([row.name]);
    if (!provider) return reply.code(500).send({ error: 'no_provider' });
    try {
      await buildContextFor(row, provider);
    } catch (e) {
      if (e instanceof InFlightError) return reply.code(409).send({ error: 'explain_running' });
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'context_failed' });
    }
    return contextStatusOf(row.id, row.contextPath !== null);
  });
}

/** Write routes needing the always-on token/CSRF gate in app.ts, kept in sync with the routes above. */
export const V2_WRITE_PATTERNS: readonly RegExp[] = [
  /^\/api\/projects$/,
  /^\/api\/projects\/\d+\/explain$/,
  /^\/api\/projects\/\d+\/context\/refresh$/,
  /^\/api\/projects\/\d+\/ignore$/,
  /^\/api\/digests\/\d+\/explain$/,
  /^\/api\/digests\/\d+\/areas\/[^/]+\/explain$/,
];

/** PATCH write routes: kept separate from `V2_WRITE_PATTERNS` (all POST) since the method also gates them. */
export const V2_PATCH_WRITE_PATTERNS: readonly RegExp[] = [/^\/api\/projects\/\d+$/];

export function isV2WritePath(method: string, urlPath: string): boolean {
  if (method === 'POST') return V2_WRITE_PATTERNS.some((p) => p.test(urlPath));
  if (method === 'PATCH') return V2_PATCH_WRITE_PATTERNS.some((p) => p.test(urlPath));
  return false;
}
