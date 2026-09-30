import type {
  AreaMemory, ExplainLanguage, MemoryItem, MemorySlice, NoteMemory, TermMemory, ThreadDigestRef, ThreadMemory,
} from '@digestit/core';
import { MEMORY_LIMITS } from '@digestit/core';
import { estimateTokens } from './prepare.js';
import type { ProviderFile } from './provider.js';
import { redact } from './redact.js';

/** The three prompts memory can ground (docs/milestone-4-memory.md §3); each has its own token budget. */
export type MemoryPromptKind = keyof typeof MEMORY_LIMITS.sliceTokens;

/** Rules shared by every prompt that may carry a `<memory>` block (docs/milestone-4-memory.md §3). */
export const MEMORY_PROMPT_RULES = 'Use the project\'s own area, term and thread names exactly as given in <memory>; invent none. You may say a change "continues" earlier work only when a thread in <memory> covers it, naming that thread\'s date exactly as shown there. Name no other date or weekday unless the diff itself shows it. A `note` in <memory> is a correction from the user: it outranks every other fact in <memory>, but never outranks what the diff itself shows.';

/** What retrieval is grounded on: the change's own touched areas, the diff's known identifiers, and the target prompt. */
export interface MemoryRequest {
  /** Area keys (folder/package paths) whose files this change touches. */
  touchedAreas: string[];
  /** Identifiers found in the prepared diff that match a known term or export (see `identifiersInDiff`). */
  identifiers: string[];
  kind: MemoryPromptKind;
  /** Language the rendered slice (thread dates) is written in; the prompt is written in the same language. */
  language: ExplainLanguage;
}

const key = (kind: string, k: string): string => `${kind}\u0000${k}`;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Words in `files`' patches that are also one of `knownTerms` (an exact, case-sensitive match): the
 * "identifiers found in the prepared diff" half of a `MemoryRequest` (docs/milestone-4-memory.md §3).
 */
export function identifiersInDiff(files: readonly ProviderFile[], knownTerms: readonly string[]): string[] {
  const known = new Set(knownTerms);
  const found = new Set<string>();
  const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
  for (const f of files) {
    if (f.patch === null) continue;
    for (const m of f.patch.matchAll(WORD)) if (known.has(m[0])) found.add(m[0]);
  }
  return [...found].sort(cmp);
}

/** "Tue 29 Sep" (en) or the ko equivalent (docs/milestone-4-memory.md §3). */
export function formatMemoryDate(iso: string, language: ExplainLanguage): string {
  const d = new Date(iso);
  if (language === 'ko') {
    return new Intl.DateTimeFormat('ko-KR', { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  }
  const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

const joinNames = (names: readonly string[]): string => (names.length === 0 ? 'none' : names.join(', '));

/** An area rendered as only its relationships (docs/milestone-4-memory.md §3: "with their uses/usedBy names only"). */
function renderAreaLinks(path: string, c: AreaMemory): string {
  return `- ${path} (area): uses ${joinNames(c.uses)}; used by ${joinNames(c.usedBy)}`;
}

/** A pinned area: full detail, since the user singled it out. */
function renderAreaFull(path: string, c: AreaMemory): string {
  const exportNames = c.exports.slice(0, 8).map((e) => e.name);
  const doc = c.doc ? redact(c.doc) : null;
  const summary = c.summary ? redact(c.summary) : null;
  const parts = [
    doc ?? summary ?? null,
    exportNames.length > 0 ? `exports ${joinNames(exportNames)}` : null,
    `uses ${joinNames(c.uses)}; used by ${joinNames(c.usedBy)}`,
  ].filter((p): p is string => p !== null);
  return `- ${path} (area, pinned): ${parts.join('; ')}`;
}

function renderTerm(c: TermMemory, override: string | null): string {
  const meaning = override ?? (c.meaning ? redact(c.meaning) : null);
  return meaning ? `- ${c.term} (term): ${meaning}` : `- ${c.term} (term)`;
}

function latestDigest(c: ThreadMemory): ThreadDigestRef | null {
  if (c.digests.length === 0) return null;
  return c.digests.reduce((latest, d) => (d.at > latest.at ? d : latest), c.digests[0]!);
}

function renderThread(c: ThreadMemory, override: string | null, language: ExplainLanguage): string {
  const latest = latestDigest(c);
  const body = override ?? (c.summary ? redact(c.summary) : latest?.l0 ?? c.title);
  const dateNote = latest ? ` (continues ${formatMemoryDate(latest.at, language)})` : '';
  return `- ${c.title}${dateNote} (thread): ${body}`;
}

function renderNote(c: NoteMemory): string {
  const text = redact(c.text);
  return c.target ? `- ${c.target.key} (note): ${text}` : `- (note): ${text}`;
}

/**
 * Items whose prose is in `language` or that have none (`language: null`). An item's identity is
 * (kind, key, language), so the same key can exist once per language: the `language` copy wins over
 * the language-less one, and a copy in another language is never sent.
 */
function inLanguage(items: readonly MemoryItem[], language: ExplainLanguage): MemoryItem[] {
  const matched = new Set(items.filter((it) => it.language === language).map((it) => key(it.kind, it.key)));
  return items.filter((it) => it.language === language || (it.language === null && !matched.has(key(it.kind, it.key))));
}

interface Candidate {
  item: MemoryItem;
  /** Extra items whose current version was consulted to build this line (e.g. the area a note targets). */
  alsoUses: MemoryItem[];
  text: string;
}

/**
 * Picks the slice of `items` to ground one prompt: user notes on touched areas, pinned items,
 * touched areas (relationships only), terms the diff mentions, open threads on touched areas, then
 * neighbouring areas (docs/milestone-4-memory.md §3). Never `stale`/`hidden`. A user note whose
 * `target` is a selected item replaces that item's own text. Deterministic and pure: ties within a
 * category break on `key`, ascending. Items are added in that order while they fit in `budget`
 * (estimated tokens); one that does not fit is skipped whole (never partially rendered) and counted
 * in `droppedForBudget`, and a shorter, later item may still fit after it.
 */
export function selectMemory(items: readonly MemoryItem[], request: MemoryRequest, budget: number): MemorySlice {
  const active = inLanguage(items.filter((it) => it.status === 'active'), request.language);
  const touched = new Set(request.touchedAreas);
  const identifiers = new Set(request.identifiers);
  const byTargetKey = new Map<string, MemoryItem & { content: NoteMemory }>();
  for (const it of active) {
    if (it.kind !== 'note') continue;
    const c = it.content as NoteMemory;
    if (c.target) byTargetKey.set(key(c.target.kind, c.target.key), it as MemoryItem & { content: NoteMemory });
  }

  const selectedKeys = new Set<string>();
  const candidates: Candidate[] = [];
  const take = (it: MemoryItem, text: string, alsoUses: MemoryItem[] = []): void => {
    const k = key(it.kind, it.key);
    if (selectedKeys.has(k)) return;
    selectedKeys.add(k);
    candidates.push({ item: it, alsoUses, text });
  };
  const bySortedKey = (list: MemoryItem[]): MemoryItem[] => [...list].sort((a, b) => cmp(a.key, b.key));

  // 1. User notes on touched areas: the note's own text stands in for the area it targets, so the
  // area is left out of category 3 below (its key is already marked selected via `notedAreas`).
  const notedAreas = new Set<string>();
  const areaNotes = active.filter(
    (it): it is MemoryItem & { content: NoteMemory } =>
      it.kind === 'note' && (it.content as NoteMemory).target?.kind === 'area' && touched.has((it.content as NoteMemory).target!.key),
  );
  for (const n of bySortedKey(areaNotes)) {
    notedAreas.add((n.content as NoteMemory).target!.key);
    take(n, renderNote(n.content as NoteMemory));
  }

  // 2. Pinned items of any kind.
  const pinned = active.filter((it) => it.pinned && it.kind !== 'note');
  for (const it of bySortedKey(pinned)) {
    const override = byTargetKey.get(key(it.kind, it.key));
    const overrideText = override ? redact((override.content as NoteMemory).text) : null;
    if (it.kind === 'area') take(it, overrideText ?? renderAreaFull(it.key, it.content as AreaMemory), override ? [override] : []);
    else if (it.kind === 'term') take(it, renderTerm(it.content as TermMemory, overrideText), override ? [override] : []);
    else if (it.kind === 'thread') take(it, renderThread(it.content as ThreadMemory, overrideText, request.language), override ? [override] : []);
  }

  // 3. Touched areas (relationships only), excluding ones already covered by a note in category 1.
  const touchedAreaItems = active.filter((it) => it.kind === 'area' && touched.has(it.key));
  for (const it of bySortedKey(touchedAreaItems)) {
    if (notedAreas.has(it.key)) continue;
    take(it, renderAreaLinks(it.key, it.content as AreaMemory));
  }

  // 4. Terms found in the diff.
  const diffTerms = active.filter((it) => it.kind === 'term' && identifiers.has((it.content as TermMemory).term));
  for (const it of bySortedKey(diffTerms)) {
    const override = byTargetKey.get(key(it.kind, it.key));
    take(it, renderTerm(it.content as TermMemory, override ? redact((override.content as NoteMemory).text) : null), override ? [override] : []);
  }

  // 5. Open threads on touched areas.
  const openThreads = active.filter(
    (it) => it.kind === 'thread' && (it.content as ThreadMemory).state === 'open' && (it.content as ThreadMemory).areas.some((a) => touched.has(a)),
  );
  for (const it of bySortedKey(openThreads)) {
    const override = byTargetKey.get(key(it.kind, it.key));
    take(
      it,
      renderThread(it.content as ThreadMemory, override ? redact((override.content as NoteMemory).text) : null, request.language),
      override ? [override] : [],
    );
  }

  // 6. Neighbouring areas: connected to a touched area via `uses`/`usedBy`, but not touched themselves.
  const neighbourKeys = new Set<string>();
  for (const it of touchedAreaItems) {
    const c = it.content as AreaMemory;
    for (const k of [...c.uses, ...c.usedBy]) if (!touched.has(k)) neighbourKeys.add(k);
  }
  const neighbours = active.filter((it) => it.kind === 'area' && neighbourKeys.has(it.key) && !touched.has(it.key));
  for (const it of bySortedKey(neighbours)) {
    const override = byTargetKey.get(key(it.kind, it.key));
    take(
      it,
      override ? redact((override.content as NoteMemory).text) : renderAreaLinks(it.key, it.content as AreaMemory),
      override ? [override] : [],
    );
  }

  const lines: string[] = [];
  const used = new Map<number, number>();
  let tokens = 0;
  let dropped = 0;
  for (const c of candidates) {
    const lineTokens = estimateTokens(`${c.text}\n`);
    if (tokens + lineTokens > budget) {
      dropped++;
      continue;
    }
    tokens += lineTokens;
    lines.push(c.text);
    used.set(c.item.id, c.item.version);
    for (const extra of c.alsoUses) used.set(extra.id, extra.version);
  }

  return {
    items: [...used.entries()].map(([id, version]) => ({ id, version })),
    text: lines.join('\n'),
    tokens,
    droppedForBudget: dropped,
  };
}

const WEEKDAY_EN = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tue|Wed|Thu|Fri|Sat';
const MONTH_EN = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const DAY = '\\d{1,2}(?:st|nd|rd|th)?';
/**
 * Date-like phrases, longest form first so "Wed 30 Sep" is matched whole rather than as "Wed" and
 * "30 Sep": a weekday with an optional day + month after it, a day + month, a month + day, or an
 * ISO date. Case-sensitive, so the verb "may" and the word "sun" are not dates.
 */
const DATE_RE_EN = new RegExp(
  [
    `\\b(?:${WEEKDAY_EN})\\b,?(?:\\s+${DAY}\\s+(?:${MONTH_EN})\\b)?`,
    `\\b${DAY}\\s+(?:${MONTH_EN})\\b`,
    `\\b(?:${MONTH_EN})\\.?\\s+${DAY}\\b`,
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
  ].join('|'),
  'g',
);
/** "9월 29일 (화)" with or without the weekday, a bare "화요일"/"(화)", or an ISO date. */
const DATE_RE_KO = /\d{1,2}월\s*\d{1,2}일(?:\s*\([일월화수목금토]\))?|[일월화수목금토]요일|\([일월화수목금토]\)|\b\d{4}-\d{2}-\d{2}\b/g;

const norm = (s: string): string => s.toLowerCase().replace(/[\s,.]+/g, ' ').trim();

/**
 * The text a reply may quote a date from once a memory slice was sent: the slice itself, the project
 * context and the diff the prompt showed. A date that only appears in the code being explained (a
 * date-formatting change, a changelog) is the diff's own fact, not a claimed continuation.
 */
export function memoryDateSources(sliceText: string, files: readonly ProviderFile[], context?: string): string {
  return [sliceText, context ?? '', ...files.map((f) => f.patch ?? '')].join('\n');
}

/**
 * Flags any date or weekday the output text names that is not in `sources` (docs/milestone-4-memory.md
 * §3): the model may only say a thread "continues" on a date that is actually in `<memory>`, so a date
 * with no match there (or in the diff, see `memoryDateSources`) is a hard violation, not a style
 * warning. Empty when the output names no date at all.
 */
export function checkMemoryDateClaims(texts: readonly string[], sources: string, language: ExplainLanguage): string[] {
  const patterns = language === 'ko' ? [DATE_RE_KO, DATE_RE_EN] : [DATE_RE_EN];
  const haystack = norm(sources);
  const v: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const found = m[0];
        const n = norm(found);
        if (seen.has(n)) continue;
        seen.add(n);
        if (!inSources(haystack, n)) v.push(`mentions the date/weekday "${found}" which is not in the memory slice or the diff`);
      }
    }
  }
  return v;
}

/** Whole-word match, so "sat" is not found in "saturated"; a Korean phrase may run into a particle ("화요일에"). */
function inSources(haystack: string, phrase: string): boolean {
  const tail = /[a-z0-9]$/.test(phrase) ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(phrase)}${tail}`, 'u').test(haystack);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
