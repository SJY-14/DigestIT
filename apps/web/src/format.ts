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
