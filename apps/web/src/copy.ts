// All user-facing UI wording lives here (DIG-47), so it can be reviewed in one place and
// localised later. Rules: sentence case, no "(s)", no raw booleans or enum values, human dates,
// specific empty/loading/error states. Explanations themselves come from the LLM in the
// project's language; this file is only the UI chrome, which stays English for now.

/** "1 file" / "4 files". Pass the plural when it is not just singular + "s". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayMonth = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const dayMonthYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today, 17:05", "Yesterday, 09:12", "Sep 27, 17:05", "Dec 31, 2025, 08:00" (local time). */
export function humanDateTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const clock = time.format(t);
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);
  if (days === 0) return `Today, ${clock}`;
  if (days === 1) return `Yesterday, ${clock}`;
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return `${(sameYear ? dayMonth : dayMonthYear).format(t)}, ${clock}`;
}

/** "+7 −3" (a real minus sign). */
export function lineDelta(additions: number, deletions: number): string {
  return `+${additions.toLocaleString('en-US')} −${deletions.toLocaleString('en-US')}`;
}

/** Explanation languages as shown in the language setting (each in its own language). Kept as a
 * plain literal (not imported from `@digestit/core`'s `EXPLAIN_LANGUAGES`) so the browser bundle
 * never pulls in that package's Node-only `db.js` — see the note in v2Fixtures.ts. */
export const LANGUAGE_NAMES = { en: 'English', ko: '한국어' } as const;
export const EXPLAIN_LANGUAGE_LIST = Object.keys(LANGUAGE_NAMES) as (keyof typeof LANGUAGE_NAMES)[];

/** Level switcher labels (`L0 Summary · L1 Impact · L2 Structure · L3 Code`). */
export const LEVELS = [
  { key: 'L0', label: 'Summary' },
  { key: 'L1', label: 'Impact' },
  { key: 'L2', label: 'Structure' },
  { key: 'L3', label: 'Code' },
] as const;

// Each issue adds its own section below (header, digest picker, reader, walkthrough, graph,
// empty states, history). Keep strings as plain values or small functions of numbers/dates.

// ---- Header (DIG-49): project switcher, Explain button, calls-left badge, info popover ----

/** The primary Explain button's label: the pending count, or a plain "nothing to do" state
 * that must not look like a broken primary action. */
export function explainButtonLabel(pendingFiles: number): string {
  return pendingFiles === 0 ? 'No new changes' : `Explain ${plural(pendingFiles, 'change')}`;
}

/** "12s" under a minute, "1m 05s" at or past one. */
export function elapsedLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return m === 0 ? `${s}s` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** "Explaining… 12s" while an Explain is in flight, shown in place of the pending count. */
export function explainingLabel(elapsedSeconds: number): string {
  return `Explaining… ${elapsedLabel(elapsedSeconds)}`;
}

/** "35 calls left today" for the small budget badge; flags 0 as fully spent, not just "0 left". */
export function callsLeftLabel(remaining: number): string {
  return remaining === 0 ? 'No calls left today' : `${plural(remaining, 'call')} left today`;
}

/** The info popover's context line: "Built just now, from 42 files, with your notes" /
 * "Built 3 hours ago, from 12 files" / "No context built yet" / "Building context…". */
export function contextSummary(
  status: 'none' | 'ok' | 'pending' | 'error' | 'truncated',
  builtLabel: string | null,
  fromFiles: number | null,
  hasUserContext: boolean,
): string {
  if (status === 'none') return 'No context built yet';
  if (status === 'pending' || !builtLabel) return 'Building context…';
  const built = status === 'error' ? `Failed to build (last try ${builtLabel})` : `Built ${builtLabel}`;
  const from = fromFiles !== null ? `, from ${plural(fromFiles, 'file')}` : '';
  const notes = hasUserContext ? ', with your notes' : '';
  return `${built}${from}${notes}`;
}

/** Explain outcomes that land back on the header instead of a new digest. */
export function explainOutcomeMessage(
  outcome: 'error' | 'budget' | 'no_changes', detail: string | undefined, resetsLabel: string,
): string {
  if (outcome === 'no_changes') return 'Nothing changed since the last check.';
  if (outcome === 'budget') return `Daily budget used up. It resets ${resetsLabel}.`;
  return `Explain failed${detail ? `: ${detail}` : ''}. Try again.`;
}

// ---- Digest picker (DIG-49): one row per digest ----

/** "Today, 17:05 · 15 files · Adds retry to uploads" (or "Not explained yet" with no L0). */
export function digestRowLabel(atIso: string, files: number, l0Text: string | null): string {
  return `${humanDateTime(atIso)} · ${plural(files, 'file')} · ${l0Text ?? 'Not explained yet'}`;
}

export const DIGEST_STATUS_LABEL: Record<'pending' | 'error' | 'truncated', string> = {
  pending: 'Explaining…',
  error: 'Could not explain this digest',
  truncated: 'Only partly explained',
};

// ---- First-run empty states (DIG-49) ----

export const NO_PROJECTS_EMPTY_STATE = {
  heading: 'Start your first project',
  steps: [
    'Register a project folder below.',
    'Work in it with any tool — an editor, an agent, a script.',
    'Come back and press Explain to see what changed.',
  ],
};

export const NO_DIGESTS_EMPTY_STATE = {
  heading: 'No digests yet',
  body: 'Work in this project with any tool, then press Explain above to build the first digest.',
};

export const DIGEST_NO_CHANGES_EMPTY_STATE = 'This digest has nothing to show: every change was filtered out.';
