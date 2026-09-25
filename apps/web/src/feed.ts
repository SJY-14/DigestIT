import type { Metrics, WorkUnitSummary } from './api.js';

/** What the user is looking at: unit order plus the version of each unit when it was shown. */
export interface Shown {
  ids: number[];
  stamps: Map<number, string>;
}

const stamp = (u: WorkUnitSummary) => `${u.lastCommitAt}|${u.mergedAt ?? ''}|${u.state}`;

export function snapshot(units: WorkUnitSummary[]): Shown {
  return { ids: units.map((u) => u.id), stamps: new Map(units.map((u) => [u.id, stamp(u)])) };
}

/** Add older units below what is shown; nothing on screen moves. */
export function appendShown(shown: Shown, older: WorkUnitSummary[]): Shown {
  const fresh = older.filter((u) => !shown.stamps.has(u.id));
  return { ids: [...shown.ids, ...fresh.map((u) => u.id)], stamps: new Map([...shown.stamps, ...fresh.map((u) => [u.id, stamp(u)] as const)]) };
}

/**
 * Units that appeared or moved since `shown`. Their rows are not reordered until the user clicks
 * the "N new" pill; everything else in `shown` keeps its position and only its content refreshes.
 */
export function pendingChanges(shown: Shown, fresh: WorkUnitSummary[]): number {
  const known = new Set(shown.ids);
  return fresh.filter((u) => !known.has(u.id) || shown.stamps.get(u.id) !== stamp(u)).length;
}

/** The list to render: shown order, fresh data. Units that vanished server-side are dropped. */
export function visibleUnits(shown: Shown, fresh: WorkUnitSummary[]): WorkUnitSummary[] {
  const byId = new Map(fresh.map((u) => [u.id, u]));
  return shown.ids.flatMap((id) => {
    const u = byId.get(id);
    return u ? [u] : [];
  });
}

/** Older pages that were already loaded stay after a refresh of the first page. */
export function mergePages(first: WorkUnitSummary[], tail: WorkUnitSummary[]): WorkUnitSummary[] {
  const ids = new Set(first.map((u) => u.id));
  return [...first, ...tail.filter((u) => !ids.has(u.id))];
}

export interface ReviewState {
  unread: boolean;
  decidedBy: 'reviewed' | 'merged' | null;
}

/** Per-unit review state from /api/metrics. Units missing there (no `landed` event yet) count as read. */
export function reviewStates(m: Metrics | null): Map<number, ReviewState> {
  const out = new Map<number, ReviewState>();
  for (const u of m?.units ?? []) {
    out.set(u.id, { unread: u.landedAt !== null && u.timeToOpenSec === null, decidedBy: u.decidedBy });
  }
  return out;
}

export function formatDuration(sec: number | null): string {
  if (sec === null) return '–';
  if (sec < 90) return `${Math.round(sec)} s`;
  const m = sec / 60;
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

export function unitText(u: WorkUnitSummary): { text: string; explained: boolean } {
  const c = u.l0.content as { text?: unknown } | null;
  const text = u.l0.status === 'ok' && typeof c?.text === 'string' ? c.text.trim() : '';
  return text ? { text, explained: true } : { text: u.title, explained: false };
}
