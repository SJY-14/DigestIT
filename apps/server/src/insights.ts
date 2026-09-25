import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_DAILY_BUDGET, type ExplainReason } from '@digestit/ingest';
import { areaOf, loadWorkspacePrefixes } from './areas.js';
import { createWorkUnitSummarizer, WU_SELECT } from './live.js';

// M3-1 (docs/milestone-3.md, T2-a): read-only aggregates computed on read. Every query function
// here is pure (db in, plain object out) so it's testable without HTTP; `registerInsights` just
// wires them to GET routes and memoises on `PRAGMA data_version`.

type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;
const WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;
export type Window = keyof typeof WINDOW_DAYS;
const REASONS: ExplainReason[] = ['merged', 'handoff', 'rollup', 'backfill', 'manual'];
const ATTENTIONS = ['reviewed', 'deep', 'opened', 'notOpened'] as const;
export type Attention = (typeof ATTENTIONS)[number];
const DEEP_MS = 10_000;
const DEEP_LEVELS = new Set([2, 3]);

const json = (v: unknown, fallback: unknown = null) => {
  try { return JSON.parse(v as string); } catch { return fallback; }
};

export function isWindow(v: unknown): v is Window {
  return typeof v === 'string' && Object.hasOwn(WINDOW_DAYS, v);
}

const dayKey = (iso: string): string => iso.slice(0, 10);

/** Monday of the ISO week containing `iso` (UTC), as a day key. */
function weekKey(iso: string): string {
  const d = new Date(`${dayKey(iso)}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  return new Date(d.getTime() + mondayOffset * DAY_MS).toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

interface Span { sinceDay: string; untilDay: string; sinceMs: number; untilMs: number }

/** [now - windowDays, now], expressed as UTC day keys and ms bounds. */
function windowSpan(window: Window, now: Date): Span {
  const days = WINDOW_DAYS[window];
  const untilDay = dayKey(now.toISOString());
  const sinceDay = addDays(untilDay, -(days - 1));
  return {
    sinceDay, untilDay,
    sinceMs: Date.parse(`${sinceDay}T00:00:00.000Z`),
    untilMs: now.getTime(),
  };
}

function dayBuckets(span: Span): string[] {
  const out: string[] = [];
  for (let d = span.sinceDay; d <= span.untilDay; d = addDays(d, 1)) out.push(d);
  return out;
}

function weekBuckets(span: Span): string[] {
  const seen = new Set<string>();
  for (const d of dayBuckets(span)) seen.add(weekKey(`${d}T00:00:00Z`));
  return [...seen].sort();
}

/** Root validation: a repo-relative area path, no leading/trailing slash, no `.`/`..` segments. */
export function isValidRoot(s: string): boolean {
  if (s === '' || s.startsWith('/') || s.endsWith('/')) return false;
  return s.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

const prefixCache = new Map<number, string[]>();
function prefixesFor(db: DatabaseSync, repoId: number): string[] {
  let p = prefixCache.get(repoId);
  if (p) return p;
  const row = db.prepare('SELECT path FROM repo WHERE id = ?').get(repoId) as { path: string } | undefined;
  p = row ? loadWorkspacePrefixes(row.path) : [];
  prefixCache.set(repoId, p);
  return p;
}

// --- areas -----------------------------------------------------------------------------------

export interface AreasParams {
  window: Window;
  root?: string | null;
  measure?: 'units' | 'lines';
  includeFiltered?: boolean;
  repoId?: number;
  now?: Date;
}

interface FileChangeRow {
  path: string; additions: number; deletions: number; filtered_reason: string | null;
  repo_id: number; committed_at: string; work_unit_id: number | null; sha: string;
}

const FILE_CHANGE_QUERY = `
  SELECT fc.path, fc.additions, fc.deletions, fc.filtered_reason,
         c.repo_id, c.committed_at, c.sha, uc.work_unit_id
  FROM file_change fc
  JOIN change_unit cu ON cu.id = fc.change_unit_id AND cu.kind = 'commit'
  JOIN commit_ c ON c.sha = cu.head_sha AND c.is_merge = 0
  LEFT JOIN unit_commit uc ON uc.sha = c.sha
  WHERE c.committed_at >= ? AND c.committed_at <= ?`;

export function computeAreas(db: DatabaseSync, params: AreasParams) {
  const now = params.now ?? new Date();
  const measure = params.measure ?? 'units';
  const root = params.root ?? null;
  const span = windowSpan(params.window, now);
  const buckets = params.window === '90d' ? weekBuckets(span) : dayBuckets(span);
  const bucketOf = params.window === '90d' ? weekKey : dayKey;

  let sql = FILE_CHANGE_QUERY;
  const args: (string | number)[] = [`${span.sinceDay}T00:00:00.000Z`, now.toISOString()];
  if (params.repoId !== undefined) { sql += ' AND c.repo_id = ?'; args.push(params.repoId); }
  const rows = db.prepare(sql).all(...args) as unknown as FileChangeRow[];

  interface Cell { unitIds: Set<number | string>; lines: number }
  interface AreaAcc { cells: Map<string, Cell>; totalLines: number; unitLines: Map<number, number> }
  const areas = new Map<string, AreaAcc>();
  const cellOf = (acc: AreaAcc, bucket: string): Cell => {
    let c = acc.cells.get(bucket);
    if (!c) acc.cells.set(bucket, (c = { unitIds: new Set(), lines: 0 }));
    return c;
  };

  for (const r of rows) {
    if (r.filtered_reason && !params.includeFiltered) continue;
    const area = areaOf(r.path, prefixesFor(db, r.repo_id), root);
    if (area === null) continue;
    let acc = areas.get(area);
    if (!acc) areas.set(area, (acc = { cells: new Map(), totalLines: 0, unitLines: new Map() }));
    const lines = r.additions + r.deletions;
    const bucket = bucketOf(r.committed_at);
    const cell = cellOf(acc, bucket);
    cell.lines += lines;
    cell.unitIds.add(r.work_unit_id ?? `commit:${r.sha}`);
    acc.totalLines += lines;
    const attributionId = r.work_unit_id ?? -1; // orphan commits (no work unit) bucket as "not opened"
    acc.unitLines.set(attributionId, (acc.unitLines.get(attributionId) ?? 0) + lines);
  }

  const unitIds = [...new Set([...areas.values()].flatMap((a) => [...a.unitLines.keys()]).filter((id) => id > 0))];
  const attentionByUnit = attentionOf(db, unitIds);

  const result = [...areas.entries()].map(([area, acc]) => {
    const blindSpot: Record<Attention, number> = { reviewed: 0, deep: 0, opened: 0, notOpened: 0 };
    for (const [unitId, lines] of acc.unitLines) {
      const a = unitId > 0 ? attentionByUnit.get(unitId) ?? 'notOpened' : 'notOpened';
      blindSpot[a] += lines;
    }
    return {
      area,
      series: buckets.map((bucket) => {
        const cell = acc.cells.get(bucket);
        return { bucket, units: cell ? cell.unitIds.size : 0, lines: cell ? cell.lines : 0 };
      }),
      totalLines: acc.totalLines,
      unexaminedLines: blindSpot.opened + blindSpot.notOpened,
      blindSpot,
    };
  }).sort((a, b) => b.totalLines - a.totalLines);

  return { window: params.window, root, measure, bucketKind: params.window === '90d' ? 'week' : 'day', buckets, areas: result };
}

/** Attention classification per work unit (T5-b): reviewed > deep look (L2/L3, >=10s) > opened > not opened. */
function attentionOf(db: DatabaseSync, unitIds: number[]): Map<number, Attention> {
  const out = new Map<number, Attention>();
  if (unitIds.length === 0) return out;
  const placeholders = unitIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT work_unit_id, kind, detail FROM unit_event WHERE work_unit_id IN (${placeholders})`)
    .all(...unitIds) as { work_unit_id: number; kind: string; detail: string }[];
  const flags = new Map<number, { reviewed: boolean; deep: boolean; opened: boolean }>();
  for (const id of unitIds) flags.set(id, { reviewed: false, deep: false, opened: false });
  for (const e of rows) {
    const f = flags.get(e.work_unit_id);
    if (!f) continue;
    if (e.kind === 'reviewed') f.reviewed = true;
    else if (e.kind === 'opened') f.opened = true;
    else if (e.kind === 'level_viewed') {
      const d = json(e.detail, {}) as { level?: unknown; ms?: unknown };
      if (typeof d.level === 'number' && DEEP_LEVELS.has(d.level) && typeof d.ms === 'number' && d.ms >= DEEP_MS) f.deep = true;
    }
  }
  for (const [id, f] of flags) out.set(id, f.reviewed ? 'reviewed' : f.deep ? 'deep' : f.opened ? 'opened' : 'notOpened');
  return out;
}

// --- digest ----------------------------------------------------------------------------------

export interface DigestParams { window: Window; repoId?: number; now?: Date }

const percentile = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)]!;
};

interface UnitTimelineRow { id: number; key: string; landedAt: string | null }

export function computeDigest(db: DatabaseSync, params: DigestParams) {
  const now = params.now ?? new Date();
  const span = windowSpan(params.window, now);
  const buckets = dayBuckets(span);
  const days = WINDOW_DAYS[params.window];
  const prevSpan: Span = {
    sinceDay: addDays(span.sinceDay, -days), untilDay: addDays(span.sinceDay, -1),
    sinceMs: span.sinceMs - days * DAY_MS, untilMs: span.sinceMs - 1,
  };

  let unitsSql = `SELECT w.id, w.key FROM work_unit w`;
  const unitsArgs: number[] = [];
  if (params.repoId !== undefined) { unitsSql += ' WHERE w.repo_id = ?'; unitsArgs.push(params.repoId); }
  const units = db.prepare(unitsSql).all(...unitsArgs) as { id: number; key: string }[];
  const unitIds = new Set(units.map((u) => u.id));

  let eventsSql = `SELECT work_unit_id AS unit, kind, at, detail FROM unit_event WHERE work_unit_id IS NOT NULL`;
  if (params.repoId !== undefined) eventsSql += ' AND repo_id = ?';
  eventsSql += ' ORDER BY unixepoch(at), id';
  const events = db.prepare(eventsSql).all(...unitsArgs) as { unit: number; kind: string; at: string; detail: string }[];
  const byUnit = new Map<number, typeof events>();
  for (const e of events) {
    if (!unitIds.has(e.unit)) continue;
    const l = byUnit.get(e.unit) ?? [];
    l.push(e);
    byUnit.set(e.unit, l);
  }

  const perUnit = units.map((u) => {
    const ev = byUnit.get(u.id) ?? [];
    const landedAt = ev.find((e) => e.kind === 'landed')?.at ?? null;
    const openedAt = ev.find((e) => e.kind === 'opened')?.at ?? null;
    const decidedEv = ev.find((e) => e.kind === 'reviewed' || e.kind === 'merged');
    const decidedAt = decidedEv?.at ?? null;
    const cutoff = decidedAt ?? null;
    let deepestLevel: number | null = null;
    for (const e of ev) {
      if (e.kind !== 'level_viewed') continue;
      if (cutoff && Date.parse(e.at) > Date.parse(cutoff)) continue;
      const d = json(e.detail, {}) as { level?: unknown };
      if (typeof d.level === 'number' && (deepestLevel === null || d.level > deepestLevel)) deepestLevel = d.level;
    }
    return {
      id: u.id, key: u.key, landedAt, openedAt, decidedAt, decidedBy: decidedEv?.kind ?? null,
      landToOpenSec: secondsBetween(landedAt, openedAt),
      landToDecideSec: secondsBetween(landedAt, decidedAt),
      deepestLevelBeforeDeciding: deepestLevel,
    };
  });

  // landed / decided per day.
  const landedByDay = new Map<string, number>();
  const decidedByDay = new Map<string, number>();
  for (const u of perUnit) {
    if (u.landedAt && u.landedAt >= buckets[0]! && dayKey(u.landedAt) <= span.untilDay) {
      const d = dayKey(u.landedAt);
      landedByDay.set(d, (landedByDay.get(d) ?? 0) + 1);
    }
    if (u.decidedAt) {
      const d = dayKey(u.decidedAt);
      if (d >= span.sinceDay && d <= span.untilDay) decidedByDay.set(d, (decidedByDay.get(d) ?? 0) + 1);
    }
  }
  const perDay = buckets.map((day) => ({ day, landed: landedByDay.get(day) ?? 0, decided: decidedByDay.get(day) ?? 0 }));

  // Backlog per end of day, from the full unit_event history (no snapshot table, T2-a).
  const backlog = buckets.map((day) => {
    const endOfDay = Date.parse(`${day}T23:59:59.999Z`);
    let unread = 0, undecided = 0;
    for (const u of perUnit) {
      if (!u.landedAt || Date.parse(u.landedAt) > endOfDay) continue;
      if (!u.openedAt || Date.parse(u.openedAt) > endOfDay) unread++;
      if (!u.decidedAt || Date.parse(u.decidedAt) > endOfDay) undecided++;
    }
    return { day, unread, undecided };
  });

  const latencyFor = (from: string, to: string) => {
    const opens: number[] = [], decides: number[] = [];
    for (const u of perUnit) {
      if (!u.landedAt || u.landedAt < from || u.landedAt > `${to}T23:59:59.999Z`) continue;
      if (u.landToOpenSec !== null) opens.push(u.landToOpenSec);
      if (u.landToDecideSec !== null) decides.push(u.landToDecideSec);
    }
    return {
      landToOpenP50: percentile(opens, 50), landToOpenP90: percentile(opens, 90),
      landToDecideP50: percentile(decides, 50), landToDecideP90: percentile(decides, 90),
      n: opens.length,
    };
  };

  // explain_call per day by reason vs the daily cap.
  let callSql = `SELECT date(at) AS day, reason, outcome, count(*) AS n FROM explain_call
    WHERE at >= ? AND at <= ?`;
  const callArgs: (string | number)[] = [`${span.sinceDay}T00:00:00.000Z`, now.toISOString()];
  callSql += ' GROUP BY day, reason, outcome';
  const callRows = db.prepare(callSql).all(...callArgs) as { day: string; reason: string; outcome: string; n: number }[];
  const explainCalls = buckets.map((day) => {
    const reasons = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<ExplainReason, number>;
    let total = 0, hitBudget = false;
    for (const row of callRows) {
      if (row.day !== day) continue;
      if (row.outcome === 'budget') { hitBudget = true; continue; }
      reasons[row.reason as ExplainReason] = (reasons[row.reason as ExplainReason] ?? 0) + row.n;
      total += row.n;
    }
    return { day, reasons, total, cap: DEFAULT_DAILY_BUDGET, hitBudget };
  });

  const decidedUnits = perUnit.filter((u) => u.decidedAt && u.decidedAt >= span.sinceDay);
  const deepestLevelDistribution: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, none: 0 };
  for (const u of decidedUnits) {
    const key = u.deepestLevelBeforeDeciding === null ? 'none' : String(u.deepestLevelBeforeDeciding);
    deepestLevelDistribution[key] = (deepestLevelDistribution[key] ?? 0) + 1;
  }

  return {
    window: params.window,
    buckets,
    perDay,
    backlog,
    explainCalls,
    latency: { current: latencyFor(span.sinceDay, span.untilDay), previous: latencyFor(prevSpan.sinceDay, prevSpan.untilDay) },
    deepestLevelDistribution,
    units: perUnit.filter((u) => u.landedAt && u.landedAt >= span.sinceDay && u.landedAt <= `${span.untilDay}T23:59:59.999Z`),
  };
}

const secondsBetween = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const d = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isNaN(d) ? null : Math.max(0, d);
};

// --- drill -------------------------------------------------------------------------------------

export interface DrillParams {
  area?: string; day?: string; window?: Window; metric?: string; week?: string; bucket?: string;
  ids?: number[]; root?: string | null; repoId?: number; now?: Date;
}

const METRICS = ['landed', 'decided', 'unreadBacklog', 'undecidedBacklog'] as const;
type Metric = (typeof METRICS)[number];
export function isMetric(v: unknown): v is Metric { return typeof v === 'string' && (METRICS as readonly string[]).includes(v); }
export function isAttention(v: unknown): v is Attention { return typeof v === 'string' && (ATTENTIONS as readonly string[]).includes(v); }
export function isDayKey(v: unknown): v is string { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }

export class DrillValidationError extends Error {}

function unitIdsForAreaDay(db: DatabaseSync, area: string, day: string, root: string | null, repoId?: number): number[] {
  let sql = FILE_CHANGE_QUERY;
  const args: (string | number)[] = [`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`];
  if (repoId !== undefined) { sql += ' AND c.repo_id = ?'; args.push(repoId); }
  const rows = db.prepare(sql).all(...args) as unknown as FileChangeRow[];
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.work_unit_id === null) continue;
    if (areaOf(r.path, prefixesFor(db, r.repo_id), root) !== area) continue;
    ids.add(r.work_unit_id);
  }
  return [...ids];
}

function unitIdsForAreaWindow(db: DatabaseSync, area: string, window: Window, root: string | null, repoId: number | undefined, now: Date): number[] {
  const span = windowSpan(window, now);
  let sql = FILE_CHANGE_QUERY;
  const args: (string | number)[] = [`${span.sinceDay}T00:00:00.000Z`, now.toISOString()];
  if (repoId !== undefined) { sql += ' AND c.repo_id = ?'; args.push(repoId); }
  const rows = db.prepare(sql).all(...args) as unknown as FileChangeRow[];
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.work_unit_id === null) continue;
    if (areaOf(r.path, prefixesFor(db, r.repo_id), root) !== area) continue;
    ids.add(r.work_unit_id);
  }
  return [...ids];
}

function unitIdsForDayMetric(db: DatabaseSync, day: string, metric: Metric, repoId: number | undefined, now: Date): number[] {
  // Backlog metrics need the full unit_event history (as of end of `day`), not just the window
  // around `day` — reuse computeDigest's reconstruction with a window wide enough to cover it.
  const wideNow = new Date(Math.max(now.getTime(), Date.parse(`${day}T23:59:59.999Z`)));
  const digest = computeDigest(db, { window: '90d', repoId, now: wideNow });
  const endOfDay = Date.parse(`${day}T23:59:59.999Z`);
  if (metric === 'landed') return digest.units.filter((u) => u.landedAt && dayKey(u.landedAt) === day).map((u) => u.id);
  if (metric === 'decided') return digest.units.filter((u) => u.decidedAt && dayKey(u.decidedAt) === day).map((u) => u.id);
  if (metric === 'unreadBacklog') {
    return digest.units.filter((u) => u.landedAt && Date.parse(u.landedAt) <= endOfDay && (!u.openedAt || Date.parse(u.openedAt) > endOfDay)).map((u) => u.id);
  }
  return digest.units.filter((u) => u.landedAt && Date.parse(u.landedAt) <= endOfDay && (!u.decidedAt || Date.parse(u.decidedAt) > endOfDay)).map((u) => u.id);
}

function unitIdsForWeekBucket(db: DatabaseSync, week: string, bucket: Attention, repoId: number | undefined): number[] {
  const weekStart = `${week}T00:00:00.000Z`;
  const weekEnd = `${addDays(week, 7)}T00:00:00.000Z`;
  let sql = "SELECT DISTINCT work_unit_id AS id FROM unit_event WHERE kind = 'landed' AND at >= ? AND at < ? AND work_unit_id IS NOT NULL";
  const args: (string | number)[] = [weekStart, weekEnd];
  if (repoId !== undefined) { sql += ' AND repo_id = ?'; args.push(repoId); }
  const ids = (db.prepare(sql).all(...args) as { id: number }[]).map((r) => r.id);
  const attention = attentionOf(db, ids);
  return ids.filter((id) => (attention.get(id) ?? 'notOpened') === bucket);
}

/** Resolves the drill query to work-unit ids, in the `/api/work-units` row shape. */
export function computeDrill(db: DatabaseSync, params: DrillParams) {
  const now = params.now ?? new Date();
  const root = params.root ?? null;
  let ids: number[];
  if (params.ids !== undefined) {
    ids = params.ids;
  } else if (params.area !== undefined && params.day !== undefined) {
    ids = unitIdsForAreaDay(db, params.area, params.day, root, params.repoId);
  } else if (params.area !== undefined) {
    ids = unitIdsForAreaWindow(db, params.area, params.window ?? '30d', root, params.repoId, now);
  } else if (params.day !== undefined && params.metric !== undefined) {
    if (!isMetric(params.metric)) throw new DrillValidationError('bad_metric');
    ids = unitIdsForDayMetric(db, params.day, params.metric, params.repoId, now);
  } else if (params.week !== undefined && params.bucket !== undefined) {
    if (!isAttention(params.bucket)) throw new DrillValidationError('bad_bucket');
    ids = unitIdsForWeekBucket(db, params.week, params.bucket, params.repoId);
  } else {
    throw new DrillValidationError('bad_query');
  }

  const { summary, refreshPending } = createWorkUnitSummarizer(db);
  refreshPending();
  if (ids.length === 0) return { workUnits: [] };
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`${WU_SELECT} WHERE w.id IN (${placeholders}) ORDER BY epoch DESC, w.id DESC`).all(...ids) as Row[];
  return { workUnits: rows.map(summary) };
}

// --- HTTP --------------------------------------------------------------------------------------

const parseRepoId = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);
const parseIdList = (raw: string): number[] | null => {
  const parts = raw.split(',').filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const ids = parts.map(Number);
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : null;
};

/** Memoises the last response per route, invalidated whenever `PRAGMA data_version` changes. */
function memoizer(db: DatabaseSync) {
  let version = -1;
  let cache = new Map<string, unknown>();
  return (key: string, compute: () => unknown) => {
    const v = (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
    if (v !== version) { version = v; cache = new Map(); }
    if (cache.has(key)) return cache.get(key);
    const result = compute();
    cache.set(key, result);
    return result;
  };
}

export interface InsightsOptions { now?: () => Date }

export function registerInsights(app: FastifyInstance, db: DatabaseSync, opts: InsightsOptions = {}): void {
  const now = opts.now ?? (() => new Date());
  const memo = memoizer(db);

  app.get<{ Querystring: { window?: string; root?: string; measure?: string; includeFiltered?: string; repoId?: string } }>(
    '/api/insights/areas',
    async (req, reply) => {
      const q = req.query;
      const window = q.window;
      if (!isWindow(window)) return reply.code(400).send({ error: 'bad_window' });
      let repoId: number | undefined;
      if (q.repoId !== undefined) {
        const id = parseRepoId(q.repoId);
        if (id === null) return reply.code(400).send({ error: 'bad_repo' });
        repoId = id;
      }
      if (q.root !== undefined && !isValidRoot(q.root)) return reply.code(400).send({ error: 'bad_root' });
      if (q.measure !== undefined && q.measure !== 'units' && q.measure !== 'lines') {
        return reply.code(400).send({ error: 'bad_measure' });
      }
      if (q.includeFiltered !== undefined && q.includeFiltered !== '1') {
        return reply.code(400).send({ error: 'bad_include_filtered' });
      }
      return memo(`areas:${JSON.stringify(q)}`, () =>
        computeAreas(db, {
          window, root: q.root ?? null, measure: (q.measure as 'units' | 'lines' | undefined),
          includeFiltered: q.includeFiltered === '1', repoId, now: now(),
        }));
    },
  );

  app.get<{ Querystring: { window?: string; repoId?: string } }>('/api/insights/digest', async (req, reply) => {
    const q = req.query;
    const window = q.window;
    if (!isWindow(window)) return reply.code(400).send({ error: 'bad_window' });
    let repoId: number | undefined;
    if (q.repoId !== undefined) {
      const id = parseRepoId(q.repoId);
      if (id === null) return reply.code(400).send({ error: 'bad_repo' });
      repoId = id;
    }
    return memo(`digest:${JSON.stringify(q)}`, () => computeDigest(db, { window, repoId, now: now() }));
  });

  app.get<{
    Querystring: {
      area?: string; day?: string; window?: string; metric?: string; week?: string; bucket?: string;
      ids?: string; root?: string; repoId?: string;
    };
  }>('/api/insights/drill', async (req, reply) => {
    const q = req.query;
    let repoId: number | undefined;
    if (q.repoId !== undefined) {
      const id = parseRepoId(q.repoId);
      if (id === null) return reply.code(400).send({ error: 'bad_repo' });
      repoId = id;
    }
    if (q.root !== undefined && !isValidRoot(q.root)) return reply.code(400).send({ error: 'bad_root' });
    if (q.window !== undefined && !isWindow(q.window)) return reply.code(400).send({ error: 'bad_window' });
    if (q.day !== undefined && !isDayKey(q.day)) return reply.code(400).send({ error: 'bad_day' });
    if (q.week !== undefined && !isDayKey(q.week)) return reply.code(400).send({ error: 'bad_week' });
    let ids: number[] | undefined;
    if (q.ids !== undefined) {
      const parsed = parseIdList(q.ids);
      if (parsed === null) return reply.code(400).send({ error: 'bad_ids' });
      ids = parsed;
    }
    const hasMode =
      ids !== undefined ||
      (q.area !== undefined && q.day !== undefined) ||
      q.area !== undefined ||
      (q.day !== undefined && q.metric !== undefined) ||
      (q.week !== undefined && q.bucket !== undefined);
    if (!hasMode) return reply.code(400).send({ error: 'bad_query' });
    try {
      return memo(`drill:${JSON.stringify(q)}`, () =>
        computeDrill(db, {
          area: q.area, day: q.day, window: q.window as Window | undefined, metric: q.metric,
          week: q.week, bucket: q.bucket, ids, root: q.root ?? null, repoId, now: now(),
        }));
    } catch (e) {
      if (e instanceof DrillValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
}
