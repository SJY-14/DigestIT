import type { TimelineCommit } from './api.js';

/** L0 text when generated, otherwise the commit subject (marked pending by the caller). */
export function commitLabel(c: TimelineCommit): { text: string; explained: boolean } {
  const text = c.l0.status === 'ok' ? c.l0.content?.text?.trim() : undefined;
  return text ? { text, explained: true } : { text: c.title, explained: false };
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60],
];

/** "3 days ago" style time; falls back to the absolute date for unparsable input. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((t - now) / 1000);
  for (const [unit, secs] of UNITS) if (Math.abs(s) >= secs) return rtf.format(Math.trunc(s / secs), unit);
  return 'just now';
}
