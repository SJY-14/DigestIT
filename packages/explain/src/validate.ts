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
} as const;

export const NO_CHANGE = 'No user-visible change';

export interface CheckResult {
  /** Sanitised copy that satisfies every limit (over-limit parts are cut). */
  levels: AllLevels;
  /** Empty when the provider output was valid as delivered. */
  violations: string[];
}

export const wordCount = (s: string): number => (s.trim() === '' ? 0 : s.trim().split(/\s+/).length);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HTML = /<\/?[a-zA-Z][^>]*>/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const FILE_REF = /`|\b[\w-]+\.(?:tsx?|jsx?|json|md|ya?ml|py|sql|sh|css|html|toml|lock)\b|\b[\w-]+\/[\w./-]+/;

export function truncateWords(s: string, n: number): string {
  const parts = s.trim().split(/\s+/);
  return parts.length <= n ? s.trim() : `${parts.slice(0, n).join(' ')}…`;
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

function lineIndex(files: readonly ProviderFile[]): Map<string, FileLines> {
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

  // L0
  let text = cleanText(l0.text);
  if (hasUnsafeMarkup(l0.text)) v.push('l0: contains HTML or a link');
  if (text === '') v.push('l0: empty');
  if (wordCount(text) > LIMITS.l0Words) {
    v.push(`l0: ${wordCount(text)} words, limit ${LIMITS.l0Words}`);
    text = truncateWords(text, LIMITS.l0Words);
  }
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
  let budget: number = LIMITS.l1Words;
  const total = bullets.reduce((n, b) => n + wordCount(b), 0);
  if (total > LIMITS.l1Words) v.push(`l1: ${total} words, limit ${LIMITS.l1Words}`);
  bullets = bullets.flatMap((b) => {
    if (budget <= 0) return [];
    const cut = truncateWords(b, budget);
    budget -= Math.min(wordCount(b), budget);
    return [cut];
  });

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
    if (wordCount(role) + wordCount(change) > LIMITS.l2Words) {
      v.push(`l2: item ${i} has ${wordCount(role) + wordCount(change)} words, limit ${LIMITS.l2Words}`);
      role = truncateWords(role, 10);
      change = truncateWords(change, LIMITS.l2Words - Math.min(wordCount(role), 10));
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
      if (wordCount(n) > LIMITS.l3Words) {
        v.push(`l3: annotation ${i} has ${wordCount(n)} words, limit ${LIMITS.l3Words}`);
        n = truncateWords(n, LIMITS.l3Words);
      }
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
  };
}
