import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CSP } from './csp.js';

// M2-5 (docs/milestone-2.md, M3): read-only work-unit endpoints, the SSE change stream and metrics.

export interface LiveOptions {
  /** How often the stream polls PRAGMA data_version. */
  pollMs?: number;
  /** Comment line sent to idle streams so proxies keep the connection open. */
  heartbeatMs?: number;
  /** Concurrent SSE streams; extra clients get 503 + Retry-After. */
  maxStreams?: number;
}

type Row = Record<string, unknown>;

const DEFAULT_POLL_MS = 1000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_STREAMS = 16;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const STATES = ['active', 'handoff', 'merged'];

const parseId = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);
const json = (v: unknown, fallback: unknown = null) => {
  try { return JSON.parse(v as string); } catch { return fallback; }
};

function encodeCursor(epoch: number, id: number): string {
  return Buffer.from(JSON.stringify([epoch, id])).toString('base64url');
}
function decodeCursor(cursor: string): [number, number] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && Number.isInteger(v[0]) && Number.isInteger(v[1])) return [v[0], v[1]];
  } catch { /* fall through */ }
  return null;
}

/** `since` as ISO timestamp, epoch seconds, or a relative span such as 90m / 1h / 2d. */
export function parseSince(raw: string, now = Date.now()): number | null {
  const rel = /^(\d+)([smhd])$/.exec(raw);
  if (rel) return Math.floor(now / 1000) - Number(rel[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[rel[2] as 's']!;
  if (/^\d+$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

const LATEST_EXPLANATION = `SELECT content, status, provider, model, prompt_version, created_at
  FROM explanation WHERE change_unit_id = ? AND level = ?
  ORDER BY (status = 'ok') DESC, created_at DESC, rowid DESC LIMIT 1`;

const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

export function registerLive(app: FastifyInstance, db: DatabaseSync, opts: LiveOptions = {}): void {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxStreams = opts.maxStreams ?? DEFAULT_MAX_STREAMS;
  const latest = db.prepare(LATEST_EXPLANATION);

  const l0Of = (changeId: unknown) => {
    const r = changeId == null ? undefined : (latest.get(changeId as number, 0) as Row | undefined);
    return r ? { status: r.status, content: json(r.content) } : { status: 'pending', content: null };
  };

  /** Uncommitted work (M9): worktrees checked out on the unit's branch (exact key, or `DIG-n-*`). */
  const dirtyFor = (repoId: number, key: string, kind: string) => {
    const rows = db.prepare('SELECT branch, files, additions, deletions, untracked, updated_at FROM worktree_state WHERE repo_id = ?')
      .all(repoId) as Row[];
    return rows
      .filter((r) => typeof r.branch === 'string' &&
        (r.branch === key || (kind === 'issue' && (r.branch as string).startsWith(`${key}-`))))
      .map((r) => ({
        branch: r.branch, files: r.files, additions: r.additions, deletions: r.deletions,
        untracked: r.untracked, updatedAt: r.updated_at,
      }));
  };

  const summary = (w: Row) => ({
    id: w.id,
    repoId: w.repo_id,
    key: w.key,
    kind: w.kind,
    title: w.title,
    state: w.state,
    tipSha: w.tip_sha,
    baseSha: w.base_sha,
    firstCommitAt: w.first_commit_at,
    lastCommitAt: w.last_commit_at,
    mergedAt: w.merged_at,
    latestRangeUnitId: w.latest_range_unit_id,
    commitCount: w.commit_count,
    l0: l0Of(w.latest_range_unit_id),
    dirty: dirtyFor(w.repo_id as number, w.key as string, w.kind as string),
  });

  const WU_SELECT = `SELECT w.*, unixepoch(w.last_commit_at) AS epoch,
      (SELECT COUNT(*) FROM unit_commit m WHERE m.work_unit_id = w.id) AS commit_count FROM work_unit w`;

  app.get<{ Querystring: { cursor?: string; limit?: string; state?: string; repoId?: string } }>(
    '/api/work-units',
    async (req, reply) => {
      const q = req.query;
      let limit = DEFAULT_LIMIT;
      if (q.limit !== undefined) {
        limit = Number(q.limit);
        if (!Number.isInteger(limit) || limit < 1) return reply.code(400).send({ error: 'bad_limit' });
        limit = Math.min(limit, MAX_LIMIT);
      }
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (q.state !== undefined) {
        if (!STATES.includes(q.state)) return reply.code(400).send({ error: 'bad_state' });
        where.push('w.state = ?');
        params.push(q.state);
      }
      if (q.repoId !== undefined) {
        const id = parseId(q.repoId);
        if (id === null) return reply.code(400).send({ error: 'bad_repo' });
        where.push('w.repo_id = ?');
        params.push(id);
      }
      if (q.cursor !== undefined) {
        const cur = decodeCursor(q.cursor);
        if (!cur) return reply.code(400).send({ error: 'bad_cursor' });
        where.push('(unixepoch(w.last_commit_at) < ? OR (unixepoch(w.last_commit_at) = ? AND w.id < ?))');
        params.push(cur[0], cur[0], cur[1]);
      }
      params.push(limit + 1);
      const rows = db
        .prepare(`${WU_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY epoch DESC, w.id DESC LIMIT ?`)
        .all(...params) as Row[];
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        workUnits: page.map(summary),
        nextCursor: rows.length > limit && last ? encodeCursor(last.epoch as number, last.id as number) : null,
      };
    },
  );

  app.get<{ Params: { key: string }; Querystring: { repoId?: string } }>('/api/work-units/:key', async (req, reply) => {
    let repoFilter = '';
    const params: (string | number)[] = [req.params.key];
    if (req.query.repoId !== undefined) {
      const id = parseId(req.query.repoId);
      if (id === null) return reply.code(400).send({ error: 'bad_repo' });
      repoFilter = ' AND w.repo_id = ?';
      params.push(id);
    }
    const w = db.prepare(`${WU_SELECT} WHERE w.key = ?${repoFilter} ORDER BY epoch DESC, w.id DESC LIMIT 1`)
      .get(...params) as Row | undefined;
    if (!w) return reply.code(404).send({ error: 'not_found' });

    const members = db
      .prepare(
        `SELECT c.sha, c.author_name, c.committed_at, c.message, c.is_merge, c.stats, u.id AS change_id
         FROM unit_commit m JOIN commit_ c ON c.sha = m.sha
         LEFT JOIN change_unit u ON u.repo_id = c.repo_id AND u.kind = 'commit' AND u.head_sha = c.sha
         WHERE m.work_unit_id = ? ORDER BY unixepoch(c.committed_at) DESC, c.sha DESC`,
      )
      .all(w.id as number) as Row[];

    // Range snapshots are immutable and keyed by tip; a unit's tips are its own members
    // (or the latest snapshot after the tip moved on).
    const ranges = db
      .prepare(
        `SELECT u.id, u.head_sha, u.base_sha, u.title,
           (SELECT COUNT(*) FROM file_change f WHERE f.change_unit_id = u.id) AS files,
           (SELECT COALESCE(SUM(additions), 0) FROM file_change f WHERE f.change_unit_id = u.id) AS additions,
           (SELECT COALESCE(SUM(deletions), 0) FROM file_change f WHERE f.change_unit_id = u.id) AS deletions,
           (SELECT MAX(created_at) FROM explanation e WHERE e.change_unit_id = u.id) AS explained_at
         FROM change_unit u
         WHERE u.repo_id = ? AND u.kind = 'range'
           AND (u.id = ? OR u.head_sha IN (SELECT sha FROM unit_commit WHERE work_unit_id = ?))
         ORDER BY u.id DESC`,
      )
      .all(w.repo_id as number, (w.latest_range_unit_id as number | null) ?? -1, w.id as number) as Row[];

    // Latest explanation: newest snapshot that has one; `stale` when the tip has moved past it.
    let explanation: Row | null = null;
    for (const r of ranges) {
      const levels: Row = {};
      for (const level of [0, 1, 2, 3]) {
        const e = latest.get(r.id as number, level) as Row | undefined;
        if (e) {
          levels[`l${level}`] = {
            status: e.status, content: json(e.content), provider: e.provider, model: e.model,
            promptVersion: e.prompt_version, createdAt: e.created_at,
          };
        }
      }
      if (Object.keys(levels).length) {
        explanation = { changeUnitId: r.id, stale: r.id !== w.latest_range_unit_id, levels };
        break;
      }
    }

    return {
      ...summary(w),
      members: members.map((c) => ({
        sha: c.sha,
        changeId: c.change_id,
        authorName: c.author_name,
        committedAt: c.committed_at,
        title: (c.message as string).split('\n', 1)[0],
        isMerge: c.is_merge === 1,
        stats: json(c.stats),
      })),
      ranges: ranges.map((r) => ({
        id: r.id, headSha: r.head_sha, baseSha: r.base_sha, title: r.title,
        stats: { files: r.files, additions: r.additions, deletions: r.deletions },
        explainedAt: r.explained_at,
        isLatest: r.id === w.latest_range_unit_id,
      })),
      explanation,
    };
  });

  app.get<{ Querystring: { since?: string } }>('/api/window', async (req, reply) => {
    if (req.query.since === undefined) return reply.code(400).send({ error: 'since_required' });
    const since = parseSince(req.query.since);
    if (since === null) return reply.code(400).send({ error: 'bad_since' });
    const until = Math.floor(Date.now() / 1000);
    // "Moved" = a commit landed on it, or it changed state (handoff/resumed/merged) inside the window.
    const rows = db
      .prepare(
        `${WU_SELECT}
         WHERE unixepoch(w.last_commit_at) >= ? OR unixepoch(w.merged_at) >= ?
            OR EXISTS (SELECT 1 FROM unit_event e WHERE e.work_unit_id = w.id AND unixepoch(e.at) >= ?)
         ORDER BY MAX(unixepoch(w.last_commit_at), COALESCE(unixepoch(w.merged_at), 0)) DESC, w.id DESC`,
      )
      .all(since, since, since) as Row[];
    let rollup: unknown = null;
    // The rollup table arrives with the explain scheduler; absent until then.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rollup'").get()) {
      const r = db
        .prepare('SELECT * FROM rollup WHERE unixepoch(window_end) >= ? ORDER BY window_end DESC, id DESC LIMIT 1')
        .get(since) as Row | undefined;
      if (r) {
        rollup = {
          id: r.id, windowStart: r.window_start, windowEnd: r.window_end,
          workUnitIds: json(r.work_unit_ids, []), content: json(r.content),
        };
      }
    }
    return { since: iso(since), until: iso(until), workUnits: rows.map(summary), rollup };
  });

  app.get('/api/metrics', async () => computeMetrics(db));

  // --- SSE -----------------------------------------------------------------------------------
  const streams = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let seq = 0;
  let version = -1;
  let fingerprints = new Map<number, string>();

  const dataVersion = () => (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;

  /** Per-unit fingerprint over everything the dashboard shows for a unit. */
  const snapshot = () => {
    const m = new Map<number, string>();
    const rows = db
      .prepare(
        `SELECT w.id, w.repo_id, w.key, w.kind, w.state, w.tip_sha, w.last_commit_at, w.merged_at, w.latest_range_unit_id,
           (SELECT MAX(id) FROM unit_event e WHERE e.work_unit_id = w.id) AS ev,
           (SELECT COUNT(*) FROM unit_commit c WHERE c.work_unit_id = w.id) AS n,
           (SELECT COUNT(*) FROM explanation x WHERE x.change_unit_id = w.latest_range_unit_id) AS ex
         FROM work_unit w`,
      )
      .all() as Row[];
    for (const r of rows) {
      const dirty = dirtyFor(r.repo_id as number, r.key as string, r.kind as string);
      m.set(r.id as number, JSON.stringify([r.state, r.tip_sha, r.last_commit_at, r.merged_at, r.latest_range_unit_id, r.ev, r.n, r.ex, dirty]));
    }
    return m;
  };

  const send = (chunk: string) => {
    for (const s of streams) s.write(chunk);
  };

  const tick = () => {
    let v: number;
    try { v = dataVersion(); } catch { return; }
    if (v === version) return;
    version = v;
    const next = snapshot();
    const unitIds = [...next].filter(([id, f]) => fingerprints.get(id) !== f).map(([id]) => id);
    fingerprints = next;
    send(`id: ${++seq}\nevent: changed\ndata: ${JSON.stringify({ unitIds })}\n\n`);
  };

  const start = () => {
    if (timer) return;
    version = dataVersion();
    fingerprints = snapshot();
    timer = setInterval(tick, pollMs);
    heartbeat = setInterval(() => send(': heartbeat\n\n'), heartbeatMs);
    timer.unref();
    heartbeat.unref();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
    timer = heartbeat = null;
  };

  app.get('/api/stream', (req, reply: FastifyReply) => {
    if (streams.size >= maxStreams) {
      return reply.code(503).header('retry-after', '5').send({ error: 'too_many_streams' });
    }
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
    // `ready` on every (re)connect: events missed while disconnected are not replayed,
    // so the client refetches its views when it sees it.
    raw.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ dataVersion: dataVersion() })}\n\n`);
    streams.add(raw);
    start();
    const drop = () => {
      streams.delete(raw);
      if (streams.size === 0) stop();
    };
    req.raw.on('close', drop);
    raw.on('close', drop);
  });

  app.addHook('onClose', async () => {
    stop();
    for (const s of streams) s.end();
    streams.clear();
  });
}

// --- metrics -------------------------------------------------------------------------------

const secondsBetween = (a: string | undefined, b: string | undefined): number | null => {
  if (!a || !b) return null;
  const d = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isNaN(d) ? null : Math.max(0, d);
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const DAYS = 14;

/**
 * Digest-speed metrics (milestone-2 "Metrics"), derived only from `unit_event` + work_unit.
 * Until the writers exist (DIG-18), the viewer events are absent and the derived fields are null.
 */
export function computeMetrics(db: DatabaseSync, now = new Date()) {
  const units = db.prepare('SELECT id, key, title, state, first_commit_at FROM work_unit ORDER BY id').all() as Row[];
  const events = db
    .prepare(
      `SELECT work_unit_id AS unit, kind, at, detail FROM unit_event
       WHERE work_unit_id IS NOT NULL ORDER BY unixepoch(at), id`,
    )
    .all() as { unit: number; kind: string; at: string; detail: string }[];
  const byUnit = new Map<number, typeof events>();
  for (const e of events) {
    const l = byUnit.get(e.unit) ?? [];
    l.push(e);
    byUnit.set(e.unit, l);
  }

  const perUnit = units.map((u) => {
    const ev = byUnit.get(u.id as number) ?? [];
    const first = (k: string) => ev.find((e) => e.kind === k)?.at;
    const landed = first('landed');
    const decidedEv = ev.find((e) => e.kind === 'reviewed' || e.kind === 'merged');
    const decidedAt = decidedEv?.at;
    const viewed = ev.filter((e) => e.kind === 'level_viewed' && (!decidedAt || Date.parse(e.at) <= Date.parse(decidedAt)));
    const levels = new Set<number>();
    const timeAtLevel: Record<string, number> = {};
    for (const e of viewed) {
      const d = json(e.detail, {}) as { level?: unknown; ms?: unknown };
      if (typeof d.level === 'number') {
        levels.add(d.level);
        if (typeof d.ms === 'number') timeAtLevel[d.level] = (timeAtLevel[d.level] ?? 0) + d.ms / 1000;
      }
    }
    const opens = ev.filter((e) => e.kind === 'opened').length;
    return {
      id: u.id,
      key: u.key,
      state: u.state,
      landedAt: landed ?? null,
      timeToLandSec: secondsBetween(u.first_commit_at as string, landed),
      timeToExplainSec: secondsBetween(landed, first('explained')),
      timeToOpenSec: secondsBetween(landed, first('opened')),
      timeToDecideSec: secondsBetween(landed, decidedAt),
      decidedBy: decidedEv?.kind ?? null,
      levelsViewedBeforeDeciding: [...levels].sort(),
      timeAtLevelSec: timeAtLevel,
      reopens: Math.max(0, opens - 1),
    };
  });

  const landedUnits = perUnit.filter((u) => u.landedAt);
  // Day buckets are UTC so the series is stable across server time zones.
  const day = (at: string) => new Date(at).toISOString().slice(0, 10);
  const production = new Map<string, number>();
  const digested = new Map<string, number>();
  for (const u of landedUnits) production.set(day(u.landedAt!), (production.get(day(u.landedAt!)) ?? 0) + 1);
  for (const u of perUnit) {
    const at = byUnit.get(u.id as number)?.find((e) => e.kind === 'reviewed' || e.kind === 'merged')?.at;
    if (at) digested.set(day(at), (digested.get(day(at)) ?? 0) + 1);
  }
  const perDay = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    perDay.push({ day: d, landed: production.get(d) ?? 0, decided: digested.get(d) ?? 0 });
  }
  const landedTotal = perDay.reduce((n, p) => n + p.landed, 0);
  const decidedTotal = perDay.reduce((n, p) => n + p.decided, 0);

  return {
    generatedAt: now.toISOString(),
    global: {
      unreadBacklog: landedUnits.filter((u) => u.timeToOpenSec === null).length,
      undecidedBacklog: landedUnits.filter((u) => u.timeToDecideSec === null).length,
      medianTimeToOpenSec: median(perUnit.flatMap((u) => (u.timeToOpenSec === null ? [] : [u.timeToOpenSec]))),
      medianTimeToDecideSec: median(perUnit.flatMap((u) => (u.timeToDecideSec === null ? [] : [u.timeToDecideSec]))),
      digestVsProduction: {
        windowDays: DAYS,
        landed: landedTotal,
        decided: decidedTotal,
        // The hypothesis holds when digest >= production; null when nothing landed.
        ratio: landedTotal === 0 ? null : decidedTotal / landedTotal,
        perDay,
      },
    },
    units: perUnit,
  };
}
