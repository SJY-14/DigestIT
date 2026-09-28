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

/** Explanation languages as shown in the language setting (each in its own language). */
export const LANGUAGE_NAMES = { en: 'English', ko: '한국어' } as const;

/** Level switcher labels (`L0 Summary · L1 Impact · L2 Structure · L3 Code`). */
export const LEVELS = [
  { key: 'L0', label: 'Summary' },
  { key: 'L1', label: 'Impact' },
  { key: 'L2', label: 'Structure' },
  { key: 'L3', label: 'Code' },
] as const;

// Each issue adds its own section below (header, digest picker, reader, walkthrough, graph,
// empty states, history). Keep strings as plain values or small functions of numbers/dates.

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
