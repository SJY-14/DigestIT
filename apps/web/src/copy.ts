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

// --- Header (DIG-49): project switcher, digest picker, Explain, calls left, info popover --------

export const HEADER = {
  projectLabel: 'Project',
  loadingStatus: 'Loading…',
  statusError: (msg: string) => `Could not load the project status: ${msg}`,
  infoLabel: 'Project context and language',
  refreshContext: 'Refresh context',
  refreshingContext: 'Refreshing…',
  languageLabel: 'Explanation language',
  languageHint: 'New digests use this language. Older digests stay as they were written.',
  languageError: (msg: string) => `Could not change the language: ${msg}`,
  nothingPendingHint: 'Nothing has changed since the last check.',
  noCallsHint: 'No calls left today. Explain works again after the reset.',
  resets: (when: string) => `Resets ${when}`,
} as const;

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

/** When the daily budget comes back: just the clock ("00:00") within the next day, else a date. */
export function resetsLabel(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return t > now && t - now <= 86_400_000 ? time.format(t) : humanDateTime(iso, now);
}

/** The calls-left badge: "35 calls left today", or, when spent, what happens next
 * ("No calls left today · resets 00:00"). */
export function callsLeftLabel(remaining: number, resetsAt: string, now: number = Date.now()): string {
  return remaining === 0 ? `No calls left today · resets ${resetsLabel(resetsAt, now)}` : `${plural(remaining, 'call')} left today`;
}

/** The info popover's context line: "Built just now, from 42 files, with your notes" /
 * "Built 3 hours ago, from 12 files" / "No context built yet" / "Building context…". */
export function contextSummary(
  status: 'none' | 'ok' | 'pending' | 'error' | 'truncated',
  builtLabel: string | null,
  fromFiles: number | null,
  hasUserContext: boolean,
): string {
  if (status === 'none') return 'No context built yet. It is built on the first Explain.';
  if (status === 'pending' || !builtLabel) return 'Building context…';
  const built = status === 'error' ? `Failed to build (last try ${builtLabel})` : `Built ${builtLabel}`;
  const from = fromFiles !== null ? `, from ${plural(fromFiles, 'file')}` : '';
  const notes = hasUserContext ? ', with your notes' : '';
  return `${built}${from}${notes}`;
}

/** Explain outcomes that land back on the header instead of a new digest. `detail`, when given,
 * is already a user-facing sentence (see `apiErrorMessage` below), not a raw server code. */
export function explainOutcomeMessage(
  outcome: 'error' | 'budget' | 'no_changes', detail: string | undefined, resets: string,
): string {
  if (outcome === 'no_changes') return 'Nothing changed since the last check. Work in the project with any tool, then press Explain again.';
  if (outcome === 'budget') return `The daily budget ran out, so this digest is not explained yet. Retry it after the reset at ${resets}.`;
  return `Explain failed.${detail ? ` ${detail}` : ''} Try again, or check the server log if it keeps failing.`;
}

// --- Digest picker (DIG-49): an overlay list, one row per digest ---------------------------------

/** "Today, 17:05 · 15 files · Adds retry to uploads" (or "Not explained yet" with no L0). */
export function digestRowLabel(atIso: string, files: number, l0Text: string | null, now: number = Date.now()): string {
  return `${humanDateTime(atIso, now)} · ${plural(files, 'file')} · ${l0Text ?? 'Not explained yet'}`;
}

export const PICKER = {
  label: 'Digests',
  choose: 'Choose a digest',
  listLabel: 'Past digests, newest first',
  loading: 'Loading…',
  loadError: (msg: string) => `Could not load digests: ${msg}`,
  startOfHistory: 'Start of history',
  retry: 'Retry',
  retrying: 'Retrying…',
  retryNoBudget: 'No calls left today',
  status: {
    pending: 'Not explained yet',
    error: 'Explain failed',
    truncated: 'Partly explained',
  } as Record<'pending' | 'error' | 'truncated', string>,
} as const;

// --- First-run empty states (DIG-49): teach register → work → Explain ----------------------------

export const EMPTY = {
  noProjects: {
    heading: 'Start your first project',
    steps: [
      'Register a project folder below.',
      'Work in it with any tool: an editor, an AI agent, a script.',
      'Come back and press Explain to see what changed.',
    ],
  },
  noDigests: {
    heading: 'No digests yet',
    body: 'Work in this project with any tool, then press Explain above. Each Explain turns the changes since the last one into a digest.',
  },
  digestNoChanges: 'This digest has no file changes to explain. Keep working, then press Explain again.',
} as const;

// --- Server error codes -> sentences (DIG-49 copy sweep) ------------------------------------------
// The API returns a short machine code (`{error: 'bad_root_path'}`) so other code and tests can
// branch on it; this is the one place that turns it into something a person reads.

const API_ERROR_MESSAGE: Record<string, string> = {
  bad_root_path: 'Enter a project folder to register.',
  root_not_found: 'That folder does not exist.',
  root_not_allowed: 'That folder is outside the folders this server can register.',
  bad_context_path: 'Enter a valid context file path.',
  context_not_found: 'That context file does not exist.',
  context_not_allowed: 'The context file must be inside the project folder.',
  project_roots_not_configured: 'This server has no allowed project folders configured.',
  bad_language: 'That language is not supported.',
  bad_body: 'The request was missing required fields.',
  not_found: 'That project or digest no longer exists.',
  explain_running: 'An Explain is already running for this project.',
  no_provider: 'No explanation provider is configured on this server.',
  explain_failed: 'The explanation provider returned an error.',
  context_failed: 'Building the project context failed.',
  unauthorized: 'Your session expired. Reload the page and sign in again.',
};

/** A server error code (or an arbitrary message, for network/parse failures) as a sentence. */
export function apiErrorMessage(code: string): string {
  return API_ERROR_MESSAGE[code] ?? (/^[a-z][a-z0-9_]*$/.test(code) ? 'Something went wrong on the server.' : code);
}

// --- Reader (DIG-50): level switcher, breadcrumb, the L0–L3 views -------------------------------

export const READER = {
  switcherLabel: 'Explanation level',
  switcherHint: 'Press 0–3 to switch level',
  breadcrumbLabel: 'You are here',
  digestCrumb: (when: string) => `Digest · ${when}`,
  loadingDigest: 'Loading this digest…',
  digestLoadError: (msg: string) => `Couldn't load this digest: ${msg}`,
  // Digest-level status notices, shown above every level.
  digestPending: 'This digest is still being explained.',
  digestError: "This digest couldn't be explained. Try again, or pick another digest.",
  digestTruncated: 'Part of this digest was cut to fit the size limit, so some areas may be missing.',
  retry: 'Try again',
  retrying: 'Trying again…',
  retryNoBudget: 'No calls left today',
  // L0
  noHeadline: 'This digest has no summary yet.',
  period: (from: string, to: string) => `${from} → ${to}`,
  // L1
  noImpact: 'This digest has no impact summary yet.',
  internalOnly: 'Nothing a user would notice: these changes are internal.',
  // L2
  noAreas: 'This digest has no areas yet.',
  areaHow: 'What changed',
  areaWhy: 'Why',
  openArea: 'Walk through the code',
  filteredTo: (shown: number, total: number) => `${shown} of ${plural(total, 'area')} touch`,
  noAreaForNode: 'No area covers this part of the project.',
  clearFilter: 'Show all areas',
  filterAnnounce: (path: string) => `Showing the areas that touch ${path}`,
  filterCleared: 'Showing all areas',
  notAnalysed: 'Not analysed',
  // L3 without an area
  pickArea: 'Pick an area to walk through its code.',
  // "Next level" link at the bottom of L0–L2
  nextLevel: (key: string, label: string) => `Next: ${key} ${label}`,
} as const;

// --- L3 walkthrough (DIG-50) -------------------------------------------------------------------

export const WALKTHROUGH = {
  regionLabel: (title: string) => `Code walkthrough: ${title}`,
  loading: 'Loading this area…',
  loadError: (msg: string) => `Couldn't load this area: ${msg}`,
  generate: 'Explain this code',
  generateCost: (left: number) => `Uses 1 of ${plural(left, 'call')} left today`,
  noBudget: 'No calls left today. The walkthrough can be generated after the daily limit resets.',
  notGenerated: 'This area has no walkthrough yet. The diff is below.',
  generating: 'Writing the walkthrough…',
  generateError: "Couldn't write the walkthrough.",
  retry: 'Try again',
  truncated: 'The walkthrough was cut short; the parts it skipped are listed at the end.',
  overview: 'Overview',
  stepLabel: (n: number) => `Step ${n}`,
  stepOf: (n: number, total: number) => `Step ${n} of ${total}`,
  mechanical: 'Mechanical',
  stepsNav: 'Steps',
  previous: 'Previous',
  next: 'Next',
  stepKeysHint: 'Press n / p for the next or previous step',
  check: 'What to check',
  uncovered: 'Not covered by the walkthrough',
  uncoveredNote: 'These hunks did not fit in the explanation, so no step describes them.',
  fullDiff: 'The diff',
  missingHunk: (path: string, hunk: number) => `Hunk ${hunk} of ${path} is not in the stored diff.`,
  showAll: (n: number) => `Show all ${plural(n, 'line')}`,
  showLess: 'Show less',
  noTextChange: 'No text changes to show (binary or mode change).',
  notAnalysed: 'Not analysed',
} as const;

// --- Graph pane (DIG-50) -------------------------------------------------------------------------

export const GRAPH = {
  label: 'Project graph',
  legendChanged: 'Blue: changed in this digest',
  legendSelected: 'Outlined: selected area',
  fitChanges: 'Fit to changes',
  fitAll: 'Show everything',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  loading: 'Loading the graph…',
  loadError: (msg: string) => `Couldn't load the graph: ${msg}`,
  folded: 'Some unchanged folders are folded to keep the graph readable.',
  keysHint: 'Arrow keys move between nodes; Enter opens one.',
  show: 'Show graph',
  hide: 'Hide graph',
  nodeFiles: (n: number) => plural(n, 'file'),
  summaryNone: 'No files changed.',
  summary: (files: number, folders: number) =>
    folders > 0 ? `${plural(files, 'file')} changed in ${plural(folders, 'folder')}.` : `${plural(files, 'file')} changed.`,
  openHint: (areas: number) => (areas === 1 ? 'Opens its area at L3' : areas > 1 ? `Touches ${plural(areas, 'area')}; opens them at L2` : 'Not in any area'),
  expandHint: 'Folded; press to unfold',
} as const;
