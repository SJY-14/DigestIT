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
  type ChangeStatus, type DigestL2Content, type DigestFileDto, type ExplainLanguage, type ExplanationStatus,
  type ProjectDto, type ProjectGraphDto, type SkipReason,
} from '@digestit/core';
import {
  DEFAULT_DAILY_BUDGET, ProjectLockedError, budgetStatus, buildContext, ensureContext, explainProject, initProject,
  latestCheckpoint, latestContextText as sharedLatestContextText, listProjects, listTree, openShadow, projectDataDir,
  projectStatus, retryDigest, updateProjectLanguage, type ProjectRow,
} from '@digestit/ingest';
import {
  AREA_PROMPT_VERSION, createProvider, explainArea,
  type DigestOutcome, type ExplanationProvider,
} from '@digestit/explain';

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

function outcomeToStatus(outcome: DigestOutcome | null): ExplanationStatus | null {
  if (outcome === null) return null;
  if (outcome === 'cached' || outcome === 'ok') return 'ok';
  if (outcome === 'budget') return 'pending';
  return outcome; // 'truncated' | 'error'
}

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
  // In-process one-at-a-time guards (409 `explain_running`): a project's own explain/retry is
  // already serialized by ingest's file lock, but an area click or a context refresh has no such
  // lock, and `maybeAutoBuildContext` runs ahead of the explain lock too -- a double click or an
  // Explain racing a Refresh would otherwise spend two budget calls for one piece of work.
  const contextInFlight = new Set<number>();
  const areaInFlight = new Set<string>();
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

  const latestContextText = (repoId: number) => sharedLatestContextText(db, repoId);

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

  const buildContextFor = (row: ProjectRow, provider: ExplanationProvider) =>
    withContextGuard(row, () => buildContext(db, home, row, provider, { budget: budgetLimit, now }));

  /**
   * Explain-time context, called by `explainProject` after the new checkpoint is recorded: builds it
   * when missing, refreshes it on a structural change (at most daily), then returns the compact text.
   * Best-effort: Explain still proceeds without grounding, e.g. while a manual refresh holds the guard.
   */
  const explainTimeContext = (row: ProjectRow, provider: ExplanationProvider) => async () => {
    try {
      await withContextGuard(row, () => ensureContext(db, home, row, provider, { budget: budgetLimit, now }));
    } catch {
      /* see above */
    }
    return latestContextText(row.id);
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
      `SELECT d.repo_id AS repoId, d.created_at AS createdAt, d.stats AS stats, d.language AS language,
              fromCp.seq AS seq, fromCp.taken_at AS fromAt, toCp.taken_at AS toAt, toCp.skipped AS skipped
       FROM digest d
       JOIN checkpoint fromCp ON fromCp.id = d.from_checkpoint_id
       JOIN checkpoint toCp ON toCp.id = d.to_checkpoint_id
       WHERE d.change_unit_id = ?`,
    ).get(digestId) as {
      repoId: number; createdAt: string; stats: string; language: ExplainLanguage; seq: number; fromAt: string; toAt: string; skipped: string;
    } | undefined;
    if (!d) return null;
    const l0 = latestExplanation.get(digestId, 0) as { content: string; status: ExplanationStatus } | undefined;
    const l1 = latestExplanation.get(digestId, 1) as { content: string } | undefined;
    const l2 = latestExplanation.get(digestId, 2) as { content: string } | undefined;
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
      status: row?.status ?? 'none',
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

      const raw = req.query.expand;
      const expand = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]).map(String);
      if (expand.length > MAX_EXPAND) return reply.code(400).send({ error: 'too_many_expand' });

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

      const allPaths = new Set(paths.filter((p) => p !== ''));
      for (const f of files) allPaths.add(f.path);
      const validDirs = new Set<string>(['']);
      for (const p of allPaths) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) validDirs.add(parts.slice(0, i).join('/'));
      }
      if (expand.some((e) => !validDirs.has(e))) return reply.code(400).send({ error: 'bad_expand' });

      const l2 = loadDigestL2(id!);
      const areas = l2?.items.map((it) => ({ id: it.id, paths: it.paths }));
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
        return reply.code(201).send(projectRowToDto(findProjectRow(result.repoId)!));
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : 'init_failed' });
      }
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

  app.post<{ Params: { id: string } }>('/api/projects/:id/explain', { bodyLimit: V2_BODY_LIMIT }, async (req, reply) => {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : findProjectRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const provider = providerFactory([row.name]);
    if (!provider) return reply.code(500).send({ error: 'no_provider' });
    try {
      const r = await explainProject(db, home, row, provider, { context: explainTimeContext(row, provider), budget: budgetLimit, now });
      const budget = budgetStatus(db, now(), budgetLimit);
      if (r.noChanges) return { noChanges: true, digestId: null, status: null, budget };
      graphCache.deleteDigest(r.digestId!);
      return { noChanges: false, digestId: r.digestId, status: outcomeToStatus(r.outcome), budget };
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
      const context = latestContextText(project.id);
      await retryDigest(db, home, id!, provider, { context, budget: budgetLimit, now });
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
      const digestRow = id === null ? undefined : (db.prepare('SELECT repo_id AS repoId FROM digest WHERE change_unit_id = ?').get(id) as { repoId: number } | undefined);
      const l2 = id !== null && digestRow ? loadDigestL2(id) : null;
      const project = digestRow ? findProjectRow(digestRow.repoId) : undefined;
      if (!digestRow || !project || !l2 || !l2.items.some((it) => it.id === req.params.areaId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const provider = providerFactory([project.name]);
      if (!provider) return reply.code(500).send({ error: 'no_provider' });
      const key = `${id}:${req.params.areaId}`;
      if (areaInFlight.has(key)) return reply.code(409).send({ error: 'explain_running' });
      areaInFlight.add(key);
      try {
        const context = latestContextText(project.id);
        await explainArea(db, id!, req.params.areaId, provider, { context, budget: budgetLimit, now });
      } catch (e) {
        return reply.code(500).send({ error: e instanceof Error ? e.message : 'explain_failed' });
      } finally {
        areaInFlight.delete(key);
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
