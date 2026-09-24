import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// M8 (docs/milestone-2.md, Security): the only non-GET route. It appends viewer events to
// `unit_event` and does nothing else: no ingest, git, LLM, config or delete.

export const UI_EVENTS_PATH = '/api/ui-events';
export const UI_EVENT_KINDS = ['opened', 'level_viewed', 'reviewed'] as const;
export const UI_EVENTS_BODY_LIMIT = 4096;
const MAX_MS = 24 * 3_600_000;

export interface UiEventsOptions {
  /** Token bucket: sustained requests per second and burst size. */
  ratePerSec?: number;
  burst?: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

type Reject = { code: number; error: string };

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private rate: number, private burst: number, private now: () => number) {
    this.tokens = burst;
    this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** CSRF gate: same-origin browser fetch with our custom header. Returns a rejection or null. */
function checkSameOrigin(req: FastifyRequest): Reject | null {
  const origin = header(req, 'origin');
  const host = header(req, 'host');
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    /* malformed → rejected below */
  }
  if (!originHost || !host || originHost !== host) return { code: 403, error: 'bad_origin' };
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return { code: 403, error: 'cross_site' };
  if (header(req, 'x-digestit') !== '1') return { code: 403, error: 'missing_header' };
  return null;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function registerUiEvents(app: FastifyInstance, db: DatabaseSync, opts: UiEventsOptions = {}) {
  const bucket = new TokenBucket(opts.ratePerSec ?? 20, opts.burst ?? 50, opts.now ?? Date.now);
  const unitStmt = db.prepare('SELECT id, repo_id FROM work_unit WHERE id = ?');
  const changeStmt = db.prepare('SELECT repo_id FROM change_unit WHERE id = ?');
  const insert = db.prepare(
    'INSERT INTO unit_event (repo_id, work_unit_id, change_unit_id, kind, at, detail) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const fail = (reply: FastifyReply, r: Reject) => reply.code(r.code).send({ error: r.error });

  app.post(
    UI_EVENTS_PATH,
    {
      bodyLimit: UI_EVENTS_BODY_LIMIT,
      // Runs before the body is read: origin/CSRF, content type, then the rate limit, so that
      // cross-origin or malformed requests never spend tokens.
      onRequest: async (req, reply) => {
        const bad = checkSameOrigin(req);
        if (bad) return fail(reply, bad);
        const ct = (header(req, 'content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
        if (ct !== 'application/json') return fail(reply, { code: 415, error: 'unsupported_media_type' });
        if (!bucket.take()) return reply.code(429).header('retry-after', '1').send({ error: 'rate_limited' });
      },
    },
    async (req, reply) => {
      const b = req.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return fail(reply, { code: 400, error: 'bad_body' });
      const body = b as Record<string, unknown>;
      const allowed = ['workUnitId', 'changeId', 'kind', 'level', 'ms'];
      if (Object.keys(body).some((k) => !allowed.includes(k))) return fail(reply, { code: 400, error: 'unknown_field' });
      const kind = body.kind;
      if (typeof kind !== 'string' || !(UI_EVENT_KINDS as readonly string[]).includes(kind)) {
        return fail(reply, { code: 400, error: 'bad_kind' });
      }
      if (!isInt(body.workUnitId, 1, Number.MAX_SAFE_INTEGER)) return fail(reply, { code: 400, error: 'bad_work_unit_id' });
      if (body.changeId !== undefined && !isInt(body.changeId, 1, Number.MAX_SAFE_INTEGER)) {
        return fail(reply, { code: 400, error: 'bad_change_id' });
      }
      const detail: Record<string, number> = {};
      if (kind === 'level_viewed') {
        if (!isInt(body.level, 0, 3)) return fail(reply, { code: 400, error: 'bad_level' });
        detail.level = body.level;
        if (body.ms !== undefined) {
          if (!isInt(body.ms, 0, MAX_MS)) return fail(reply, { code: 400, error: 'bad_ms' });
          detail.ms = body.ms;
        }
      } else if (body.level !== undefined || body.ms !== undefined) {
        return fail(reply, { code: 400, error: 'unexpected_detail' });
      }

      const unit = unitStmt.get(body.workUnitId) as { id: number; repo_id: number } | undefined;
      if (!unit) return fail(reply, { code: 404, error: 'unknown_unit' });
      let changeId: number | null = null;
      if (body.changeId !== undefined) {
        const c = changeStmt.get(body.changeId) as { repo_id: number } | undefined;
        if (!c || c.repo_id !== unit.repo_id) return fail(reply, { code: 404, error: 'unknown_change' });
        changeId = body.changeId;
      }
      const r = insert.run(unit.repo_id, unit.id, changeId, kind, new Date().toISOString(), JSON.stringify(detail));
      return reply.code(201).send({ id: Number(r.lastInsertRowid) });
    },
  );
}
