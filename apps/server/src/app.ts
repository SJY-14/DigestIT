import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { SESSION_COOKIE, tokensMatch, type AuthOptions } from './auth.js';
import { CSP } from './csp.js';
import { registerInsights, type InsightsOptions } from './insights.js';
import { registerLive, type LiveOptions } from './live.js';
import { registerUiEvents, UI_EVENTS_PATH, type UiEventsOptions } from './uievents.js';

export { CSP };
export type { AuthOptions };

export interface AppOptions {
  db: DatabaseSync;
  /** Built apps/web bundle; served at / when the directory exists. */
  webDir?: string;
  live?: LiveOptions;
  uiEvents?: UiEventsOptions;
  insights?: InsightsOptions;
  /** Called for every registered route (used by the route-enumeration test). */
  onRoute?: (method: string, url: string) => void;
  /** Host header values allowed besides loopback (host[:port], compared case-insensitively). */
  allowedHosts?: Iterable<string>;
  /**
   * Access-token gate. Undefined leaves the server open to any loopback request (local dev/tests).
   * When set, EVERY request — including ones naming a loopback Host — needs the cookie or bearer
   * token: other local users on a shared host can also reach the loopback bind directly,
   * so once the server is reachable off-box (allowedHosts configured) loopback is not a boundary.
   */
  auth?: AuthOptions;
}

// Lazy: a bundled entry point (e.g. the SEA build, see docs/packaging.md) has no meaningful
// import.meta.dirname, and every real caller passes webDir explicitly anyway — evaluating this
// eagerly at module scope would crash bundled builds that never use the default. Returns
// undefined (skip static serving) rather than throwing when dirname isn't available, since a
// bundle can legitimately be run without ever building apps/web.
export function defaultWebDir(): string | undefined {
  const dir = import.meta.dirname;
  return dir ? resolve(dir, '../../web/dist') : undefined;
}
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when the Host header names this loopback server (any port). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** True when the Host header is loopback or explicitly allowlisted (exact host[:port] match). */
export function isAllowedHost(host: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  if (isLoopbackHost(host)) return true;
  if (!host) return false;
  return allowedHosts.has(host.trim().toLowerCase());
}

function bearerToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/** Hand-rolled `Cookie` header lookup: no request needs more than one cookie, so no library. */
function cookieValue(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Row = Record<string, unknown>;

// Cursor = [committed epoch seconds, sha]. committed_at keeps git's local offset
// (%cI), so ordering must use the UTC epoch, not the raw string.
function encodeCursor(epoch: number, sha: string): string {
  return Buffer.from(JSON.stringify([epoch, sha])).toString('base64url');
}

function decodeCursor(cursor: string): [number, string] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && Number.isInteger(v[0]) && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    /* fall through */
  }
  return null;
}

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/** Latest explanation row for a change unit + level (newest prompt version wins). */
const LATEST_EXPLANATION = `SELECT content, status, provider, model, prompt_version, created_at
  FROM explanation WHERE change_unit_id = ? AND level = ?
  ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`;

export function buildApp({ db, webDir = defaultWebDir(), live, uiEvents, insights, onRoute, allowedHosts, auth }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const latest = db.prepare(LATEST_EXPLANATION);
  const allowed = new Set([...(allowedHosts ?? [])].map((h) => h.trim().toLowerCase()));
  if (onRoute) app.addHook('onRoute', (r) => [r.method].flat().forEach((m) => onRoute(m, r.url)));

  // Loopback-or-allowlisted only (architecture §6): the listener is always 127.0.0.1, and
  // rejecting any other Host also closes DNS rebinding, where a foreign name resolves to us and
  // Origin == Host. Read-only surface: anything but GET/HEAD is rejected before routing, except
  // the single append-only viewer-event endpoint (M8).
  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host, allowed)) return reply.code(421).send({ error: 'bad_host' });
    const isUiEventsPost = req.method === 'POST' && req.url.split('?', 1)[0] === UI_EVENTS_PATH;
    if (!isUiEventsPost && req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(405).header('allow', 'GET, HEAD').send({ error: 'method_not_allowed' });
    }
    if (!auth) return;

    // Once DIGESTIT_ALLOWED_HOSTS is set (architecture §6), every route needs the token —
    // including loopback, since another local user on a shared host can also reach
    // 127.0.0.1 directly. Bootstrap: GET /?token=<t> sets the cookie and redirects to / with the
    // query string stripped, so the token never lands in a browser history entry for /.
    const urlPath = req.url.split('?', 1)[0];
    const qIndex = req.url.indexOf('?');
    if (req.method === 'GET' && urlPath === '/' && qIndex !== -1) {
      const params = new URLSearchParams(req.url.slice(qIndex + 1));
      const supplied = params.get('token');
      if (supplied !== null) {
        if (!tokensMatch(supplied, auth.token)) return reply.code(401).send({ error: 'unauthorized' });
        reply.header('set-cookie', `${SESSION_COOKIE}=${auth.token}; Path=/; HttpOnly; SameSite=Strict`);
        return reply.redirect('/');
      }
    }
    const credential = bearerToken(req) ?? cookieValue(req, SESSION_COOKIE);
    if (!credential || !tokensMatch(credential, auth.token)) return reply.code(401).send({ error: 'unauthorized' });
  });

  // Architecture §6: bundled assets only, no inline scripts, LLM output never rendered as HTML.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.get('/api/repos', async () => {
    const rows = db.prepare('SELECT id, name, path, head_sha, ingested_at FROM repo ORDER BY id').all() as Row[];
    return {
      repos: rows.map((r) => ({ id: r.id, name: r.name, headSha: r.head_sha, ingestedAt: r.ingested_at })),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/api/repos/:id/timeline',
    async (req, reply) => {
      const repoId = parseId(req.params.id);
      if (repoId === null || !db.prepare('SELECT 1 FROM repo WHERE id = ?').get(repoId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      let limit = DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1) return reply.code(400).send({ error: 'bad_limit' });
        limit = Math.min(limit, MAX_LIMIT);
      }
      const params: (string | number)[] = [repoId];
      let where = 'c.repo_id = ?';
      if (req.query.cursor !== undefined) {
        const cur = decodeCursor(req.query.cursor);
        if (!cur) return reply.code(400).send({ error: 'bad_cursor' });
        where += ' AND (unixepoch(c.committed_at) < ? OR (unixepoch(c.committed_at) = ? AND c.sha < ?))';
        params.push(cur[0], cur[0], cur[1]);
      }
      params.push(limit + 1);
      const rows = db
        .prepare(
          `SELECT c.*, unixepoch(c.committed_at) AS epoch, u.id AS change_id FROM commit_ c
           LEFT JOIN change_unit u ON u.repo_id = c.repo_id AND u.kind = 'commit' AND u.head_sha = c.sha
           WHERE ${where} ORDER BY epoch DESC, c.sha DESC LIMIT ?`,
        )
        .all(...params) as Row[];
      const page = rows.slice(0, limit);
      const commits = page.map((r) => {
        const l0 = r.change_id === null ? undefined : (latest.get(r.change_id as number, 0) as Row | undefined);
        return {
          sha: r.sha,
          changeId: r.change_id,
          parents: JSON.parse(r.parents as string),
          authorName: r.author_name,
          authoredAt: r.authored_at,
          committedAt: r.committed_at,
          title: (r.message as string).split('\n', 1)[0],
          branchRefs: JSON.parse(r.branch_refs as string),
          isMerge: r.is_merge === 1,
          stats: JSON.parse(r.stats as string),
          l0: l0 ? { status: l0.status, content: JSON.parse(l0.content as string) } : { status: 'pending', content: null },
        };
      });
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last ? encodeCursor(last.epoch as number, last.sha as string) : null;
      return { commits, nextCursor };
    },
  );

  app.get<{ Params: { id: string } }>('/api/changes/:id', async (req, reply) => {
    const id = parseId(req.params.id);
    const unit = id === null ? undefined : (db.prepare('SELECT * FROM change_unit WHERE id = ?').get(id) as Row | undefined);
    if (!unit) return reply.code(404).send({ error: 'not_found' });
    const commit = db.prepare('SELECT * FROM commit_ WHERE sha = ?').get(unit.head_sha as string) as Row | undefined;
    const files = db
      .prepare(
        `SELECT path, old_path, status, additions, deletions, filtered_reason
         FROM file_change WHERE change_unit_id = ? ORDER BY path`,
      )
      .all(id as number) as Row[];
    return {
      id: unit.id,
      repoId: unit.repo_id,
      kind: unit.kind,
      headSha: unit.head_sha,
      baseSha: unit.base_sha,
      title: unit.title,
      commit: commit && {
        authorName: commit.author_name,
        authoredAt: commit.authored_at,
        committedAt: commit.committed_at,
        message: commit.message,
        parents: JSON.parse(commit.parents as string),
        branchRefs: JSON.parse(commit.branch_refs as string),
        isMerge: commit.is_merge === 1,
        stats: JSON.parse(commit.stats as string),
      },
      files: files.map((f) => ({
        path: f.path,
        oldPath: f.old_path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        filteredReason: f.filtered_reason,
      })),
    };
  });

  app.get<{ Params: { id: string; level: string } }>(
    '/api/changes/:id/explanations/:level',
    async (req, reply) => {
      const id = parseId(req.params.id);
      const unit = id === null ? undefined : db.prepare('SELECT id FROM change_unit WHERE id = ?').get(id);
      if (!unit) return reply.code(404).send({ error: 'not_found' });
      if (!/^[0-3]$/.test(req.params.level)) return reply.code(404).send({ error: 'unknown_level' });
      const level = Number(req.params.level);
      const row = latest.get(id as number, level) as Row | undefined;
      const body: Row = row
        ? {
            changeId: id,
            level,
            status: row.status,
            content: JSON.parse(row.content as string),
            provider: row.provider,
            model: row.model,
            promptVersion: row.prompt_version,
            createdAt: row.created_at,
          }
        : { changeId: id, level, status: 'pending', content: null };
      if (level === 3) {
        const files = db
          .prepare(
            `SELECT path, old_path, status, additions, deletions, patch, filtered_reason
             FROM file_change WHERE change_unit_id = ? ORDER BY path`,
          )
          .all(id as number) as Row[];
        body.files = files.map((f) => ({
          path: f.path,
          oldPath: f.old_path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
          filteredReason: f.filtered_reason,
        }));
      }
      return body;
    },
  );

  registerLive(app, db, live);
  registerUiEvents(app, db, uiEvents);
  registerInsights(app, db, insights);

  app.get('/api/*', async (_req, reply) => reply.code(404).send({ error: 'not_found' }));

  if (webDir && existsSync(resolve(webDir, 'index.html'))) {
    app.register(fastifyStatic, { root: resolve(webDir) });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html'); // SPA fallback
    });
  }

  return app;
}
