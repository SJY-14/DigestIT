import type { AllLevels, ProviderFile } from './provider.js';
import { indexPatch, type FileLines } from './difflines.js';

/** Limits from docs/abstraction-levels.md. */
export const LIMITS = {
  l0Words: 20,
  l1Bullets: 3,
  l1Words: 60,
  l2Items: 8,
  l2Words: 25,
  l3Annotations: 10,
  l3Words: 30,
  digestItemsMax: 8,
  digestTitleWords: 8,
  digestAreaWords: 30,
  digestEffectWords: 20,
  digestIdMaxLen: 40,
  walkOverviewWords: 80,
  walkOverviewSentencesMin: 2,
  walkOverviewSentencesMax: 3,
  walkStepsMax: 12,
  walkTitleWords: 8,
  walkBodyWords: 70,
  walkBodySentencesMin: 2,
  walkBodySentencesMax: 4,
  walkCheckMin: 1,
  walkCheckMax: 5,
  walkCheckWords: 30,
  /** A single range's `changedCount` above this is rejected regardless of the file's total (DIG-96 rule 3). */
  walkRangeMaxChanged: 40,
  /** A file's total changed lines above this may not be covered by one single range (DIG-96 rule 3). */
  walkFileChangedMax: 30,
  /** A callout note, English: words (`wordCount`), like every other prose field. */
  walkCalloutNoteWords: 12,
  /** A callout note, Korean: characters (`charLength`), counted directly, not via the generic `charCap` formula. */
  walkCalloutNoteCharsKo: 25,
  walkCalloutsMax: 4,
} as const;

/** Required first L1 bullet of a *commit* (not a digest) with nothing user-visible. */
export const NO_CHANGE = 'No user-visible change';

export interface CheckResult {
  /** Sanitised copy that satisfies every limit (over-limit parts are cut at a sentence boundary). */
  levels: AllLevels;
  /** Empty when the provider output was valid as delivered. */
  violations: string[];
  /** Fields over their target but inside the tolerance band (DIG-94): never retried. */
  lengthNotes: string[];
}

export const wordCount = (s: string): number => (s.trim() === '' ? 0 : s.trim().split(/\s+/).length);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * Real HTML tags only: prose that names code keeps generics and JSX components such as
 * `Outcome<R>`, `Promise<void>` or `<Settings />` intact.
 */
const HTML = /<\/?(?:a|abbr|b|blockquote|br|button|code|div|em|embed|form|h[1-6]|hr|i|iframe|img|input|li|link|meta|object|ol|p|pre|s|script|small|span|strong|style|sub|sup|svg|table|td|th|tr|u|ul)(?=[\s/>])[^>]*>/gi;
const URL_RE = /\bhttps?:\/\/\S+/gi;
export const FILE_REF = /`|\b[\w-]+\.(?:tsx?|jsx?|json|md|ya?ml|py|sql|sh|css|html|toml|lock)\b|\b[\w-]+\/[\w./-]+/;

export function truncateWords(s: string, n: number): string {
  const parts = s.trim().split(/\s+/);
  return parts.length <= n ? s.trim() : `${parts.slice(0, n).join(' ')}…`;
}

/** Truncates to `max` characters on a character boundary, with an ellipsis. */
export function truncateChars(s: string, max: number): string {
  const chars = [...s.trim()];
  return chars.length <= max ? s.trim() : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

export const charLength = (s: string): number => [...s].length;

const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl)\./gi;

/** Sentences in `s`: ends at `.`, `!`, `?` (or `。`) followed by whitespace or the end; abbreviations and `a.b` identifiers do not end one. */
export function sentenceCount(s: string): number {
  const t = s.replace(ABBREVIATIONS, 'x').trim();
  if (t === '') return 0;
  return t.split(/(?<=[.!?。])\s+/).filter((p) => p.trim() !== '').length;
}

/** The first `max` sentences of `s` (split as in `sentenceCount`); `s` itself when it has no more. */
export function truncateSentences(s: string, max: number): string {
  const t = s.trim();
  const masked = t.replace(ABBREVIATIONS, (m) => 'x'.repeat(m.length));
  const boundary = /(?<=[.!?。])\s+/g;
  let seen = 0;
  for (let m = boundary.exec(masked); m; m = boundary.exec(masked)) {
    if (++seen === max) return t.slice(0, m.index);
  }
  return t;
}

/**
 * Word and character limits are targets, not cut-offs (DIG-94): the prompts state the exact limit,
 * and the validator accepts up to `ceil(limit * LENGTH_TOLERANCE)` without a retry (a length note
 * instead). Real output that names flags and numbers ("`--retries <n>`", "408, 429 and 5xx") runs a
 * few words past a hard 20/30-word cap even after the retry, and cutting it left fragments.
 */
export const LENGTH_TOLERANCE = 1.25;

/** The most words (or characters) a field may use before it is a hard violation. */
export const tolerated = (limit: number): number => Math.ceil(limit * LENGTH_TOLERANCE);

/** The longest run of whole sentences of `text` that fits `maxWords`/`maxChars`; `null` when not even the first does. */
function wholeSentences(text: string, maxWords: number, maxChars: number): string | null {
  const fits = (s: string): boolean => wordCount(s) <= maxWords && charLength(s) <= maxChars;
  if (fits(text)) return text;
  for (let keep = sentenceCount(text) - 1; keep >= 1; keep--) {
    const head = truncateSentences(text, keep);
    if (fits(head)) return head;
  }
  return null;
}

/**
 * Fits `text` into `maxWords`/`maxChars` without cutting a sentence (DIG-94): keeps the longest run
 * of whole sentences that fits, and falls back to a word/character cut with an ellipsis only when
 * even the first sentence is too long.
 */
export function fitProse(text: string, maxWords: number, maxChars: number): string {
  const t = text.trim();
  return wholeSentences(t, maxWords, maxChars) ?? truncateChars(truncateWords(t, maxWords), maxChars);
}

/**
 * Fits a bullet list into `maxWords` words in total (DIG-94): whole bullets first, then the first
 * bullet that does not fit is cut at a sentence boundary, or dropped when no sentence fits (cut
 * with an ellipsis only when it is the first bullet), and the rest go.
 */
export function fitBullets(bullets: readonly string[], maxWords: number): string[] {
  const out: string[] = [];
  let budget = maxWords;
  for (const b of bullets) {
    if (wordCount(b) <= budget) {
      out.push(b);
      budget -= wordCount(b);
      continue;
    }
    const head = budget > 0 ? wholeSentences(b.trim(), budget, Infinity) : null;
    if (head !== null) out.push(head);
    else if (out.length === 0) out.push(truncateWords(b, maxWords));
    break;
  }
  return out;
}

export function cleanText(s: string): string {
  return s.replace(HTML, '').replace(URL_RE, '').replace(/[ \t]+/g, ' ').trim();
}

export function hasUnsafeMarkup(s: string): boolean {
  HTML.lastIndex = 0;
  return HTML.test(s) || /\bhttps?:\/\//i.test(s);
}

export function stringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

export function lineIndex(files: readonly ProviderFile[]): Map<string, FileLines> {
  const m = new Map<string, FileLines>();
  for (const f of files) if (f.patch !== null && f.filteredReason === null) m.set(f.path, indexPatch(f.patch));
  return m;
}

export function notAnalysedList(files: readonly ProviderFile[]): string[] {
  return files.filter((f) => f.filteredReason !== null).map((f) => `${f.path} (${f.filteredReason})`);
}

/**
 * Validates provider output against the level limits and the diff. Returns
 * `null` when the shape is unusable (not repairable); otherwise the sanitised
 * levels plus the list of violations found. `notAnalysed` is always derived
 * from the input, never trusted from the model.
 */
export function checkLevels(raw: unknown, files: readonly ProviderFile[]): CheckResult | null {
  if (!isObj(raw) || !isObj(raw.l0) || !isObj(raw.l1) || !isObj(raw.l2) || !isObj(raw.l3)) return null;
  const { l0, l1, l2, l3 } = raw as { l0: Record<string, unknown>; l1: Record<string, unknown>; l2: Record<string, unknown>; l3: Record<string, unknown> };
  if (typeof l0.text !== 'string' || typeof l1.userVisible !== 'boolean') return null;
  const bulletsIn = stringArray(l1.bullets);
  if (!bulletsIn || !Array.isArray(l2.items) || !Array.isArray(l3.annotations)) return null;

  const v: string[] = [];
  const ln: string[] = [];
  /** Word limit with the DIG-94 tolerance band: a note up to `tolerated(limit)`, a violation beyond. */
  const overLimit = (label: string, n: number, limit: number): boolean => {
    if (n > tolerated(limit)) v.push(`${label} ${n} words, limit ${limit}`);
    else if (n > limit) ln.push(`${label} ${n} words, target ${limit}`);
    return n > tolerated(limit);
  };

  // L0: never cut (DIG-94) — a headline past the tolerance band is flagged so a retry can fix it,
  // but the delivered text stays whole rather than a fragment ending in "…".
  const text = cleanText(l0.text);
  if (hasUnsafeMarkup(l0.text)) v.push('l0: contains HTML or a link');
  if (text === '') v.push('l0: empty');
  overLimit('l0:', wordCount(text), LIMITS.l0Words);
  if (/[.!?]\s+[A-Z]/.test(text)) v.push('l0: more than one sentence');
  if (FILE_REF.test(text)) v.push('l0: mentions a file name or code identifier');

  // L1
  const userVisible = l1.userVisible;
  let bullets = bulletsIn.map(cleanText).filter((b) => b !== '');
  if (bulletsIn.some(hasUnsafeMarkup)) v.push('l1: contains HTML or a link');
  const maxBullets = userVisible ? LIMITS.l1Bullets : 2;
  if (bullets.length === 0) v.push('l1: no bullets');
  if (!userVisible && !(bullets[0] ?? '').startsWith(NO_CHANGE)) {
    v.push(`l1: userVisible=false requires the first bullet to start with "${NO_CHANGE}"`);
    bullets.unshift(NO_CHANGE);
  }
  if (userVisible && (bullets[0] ?? '').startsWith(NO_CHANGE)) v.push('l1: userVisible=true but says no user-visible change');
  if (bullets.length > maxBullets) {
    v.push(`l1: ${bullets.length} bullets, limit ${maxBullets}`);
    bullets = bullets.slice(0, maxBullets);
  }
  const total = bullets.reduce((n, b) => n + wordCount(b), 0);
  if (overLimit('l1:', total, LIMITS.l1Words)) bullets = fitBullets(bullets, tolerated(LIMITS.l1Words));

  // L2
  const items: AllLevels['l2']['items'] = [];
  l2.items.forEach((it: unknown, i: number) => {
    if (!isObj(it) || typeof it.path !== 'string' || typeof it.role !== 'string' || typeof it.change !== 'string') {
      v.push(`l2: item ${i} is malformed`);
      return;
    }
    if ([it.path, it.role, it.change].some(hasUnsafeMarkup)) v.push(`l2: item ${i} contains HTML or a link`);
    let role = cleanText(it.role);
    let change = cleanText(it.change);
    if (overLimit(`l2: item ${i} has`, wordCount(role) + wordCount(change), LIMITS.l2Words)) {
      role = fitProse(role, 10, Infinity);
      change = fitProse(change, tolerated(LIMITS.l2Words) - wordCount(role), Infinity);
    }
    items.push({ path: cleanText(it.path), role, change });
  });
  if (items.length > LIMITS.l2Items) {
    v.push(`l2: ${items.length} items, limit ${LIMITS.l2Items}`);
    items.length = LIMITS.l2Items;
  }

  // L3
  const index = lineIndex(files);
  const annotations: AllLevels['l3']['annotations'] = [];
  l3.annotations.forEach((a: unknown, i: number) => {
    if (!isObj(a) || typeof a.path !== 'string' || (a.side !== 'new' && a.side !== 'old') ||
        !Number.isInteger(a.startLine) || !Number.isInteger(a.endLine) || typeof a.note !== 'string') {
      v.push(`l3: annotation ${i} is malformed`);
      return;
    }
    const { path, side, note } = a as { path: string; side: 'new' | 'old'; note: string };
    const startLine = a.startLine as number;
    const endLine = a.endLine as number;
    const lines = index.get(path);
    const set = side === 'new' ? lines?.newLines : lines?.oldLines;
    if (!lines) v.push(`l3: annotation ${i} path "${path}" is not an analysed file in this diff`);
    else if (startLine > endLine || !set?.has(startLine) || !set.has(endLine)) {
      v.push(`l3: annotation ${i} ${path}:${startLine}-${endLine} (${side}) does not exist in the diff`);
    } else {
      if (hasUnsafeMarkup(note)) v.push(`l3: annotation ${i} contains HTML or a link`);
      let n = cleanText(note);
      if (overLimit(`l3: annotation ${i} has`, wordCount(n), LIMITS.l3Words)) n = fitProse(n, tolerated(LIMITS.l3Words), Infinity);
      annotations.push({ path, side, startLine, endLine, note: n });
    }
  });
  if (annotations.length > LIMITS.l3Annotations) {
    v.push(`l3: ${annotations.length} annotations, limit ${LIMITS.l3Annotations}`);
    annotations.length = LIMITS.l3Annotations;
  }

  return {
    levels: {
      l0: { text },
      l1: { userVisible, bullets },
      l2: { items, notAnalysed: notAnalysedList(files) },
      l3: { annotations },
    },
    violations: v,
    lengthNotes: ln,
  };
}
