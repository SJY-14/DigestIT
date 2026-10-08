import type {
  AreaMemory, ExplainLanguage, MemoryItem, MemorySlice, NoteMemory, TermMemory, ThreadDigestRef, ThreadMemory,
} from '@digestit/core';
import { MEMORY_LIMITS } from '@digestit/core';
import { estimateTokens } from './prepare.js';
import type { ProviderFile } from './provider.js';
import { redact } from './redact.js';

/** The three prompts memory can ground (docs/milestone-4-memory.md §3); each has its own token budget. */
export type MemoryPromptKind = keyof typeof MEMORY_LIMITS.sliceTokens;

/**
 * Rules shared by every prompt that may carry a `<memory>` block (docs/milestone-4-memory.md §3).
 * DIG-114: the reader never sees `<memory>`, so a reply must cite what it uses the way a colleague
 * would -- the earlier change by its title and age, a note as the user's note of its date -- and
 * never name the mechanism ("in memory", "the slice"); `checkMemoryMechanism` enforces the last part.
 * DIG-118: a continuity mention had been landing as a whole added sentence on top of an already
 * full field, pushing `why` (and similarly `l0`/`effect`) past its word limit on the first try --
 * the rule below now gives the exact short clause ("continues <title> from <age>") and says it
 * replaces a less important detail rather than adding to the field, and it rules out a vague
 * continuity claim ("earlier work", "the previous days") that does not name both.
 * DIG-121: memory-on replies broke the "l0 names no identifier" rule more often than memory-off
 * ones (a term listed in <memory> read as an invitation), so the rules say where term names go;
 * and an age may only be one the slice gives for an earlier change, which `checkMemoryAgeClaims`
 * enforces.
 */
export const MEMORY_PROMPT_RULES = 'Use the project\'s own area, term and thread names exactly as given in <memory>; invent none. A term in <memory> is a code identifier: it belongs in the detailed fields (the l1 bullets, the area text, the walkthrough), never in l0, which still names no file, function or other identifier -- say there in plain words what the named code does. You may say a change continues earlier work only when a thread in <memory> covers it; then name that earlier change the way a colleague would, as a short clause inside the sentence you are already writing -- "continues <title> from <age>" ("continues the retry work from five days earlier"), using that thread\'s own title and the age shown for that earlier change exactly as written there, never a bare date and never any other age. That clause counts against the word limit stated for this field: drop a less important detail to make room for it, never add it on top as an extra sentence past the limit. Never say "earlier work", "the previous days" or another vague stand-in for a continuity claim without naming that thread\'s own title and age; if you cannot name both, do not claim continuity at all. A `note` in <memory> is a correction from the user: it outranks every other fact in <memory>, but never outranks what the diff itself shows; cite it the same way, as a short clause, not an added sentence ("per the user\'s note of Tue 22 Sep, the team convention is 200ms"). Name no other date, weekday or relative age ("three days earlier", "3일 전") unless the diff itself shows it. The reader cannot see <memory>: never mention memory, a slice, a note list or any other part of how this text was produced.';

/** What retrieval is grounded on: the change's own touched areas, the diff's known identifiers, and the target prompt. */
export interface MemoryRequest {
  /** Area keys (folder/package paths) whose files this change touches. */
  touchedAreas: string[];
  /** Identifiers found in the prepared diff that match a known term or export (see `identifiersInDiff`). */
  identifiers: string[];
  kind: MemoryPromptKind;
  /** Language the rendered slice (note dates, ages) is written in; the prompt is written in the same language. */
  language: ExplainLanguage;
  /**
   * When the change being explained was made (its digest's `created_at`, ISO). Thread lines then
   * give each earlier change's age relative to it ("5 days earlier") and leave out any digest of the
   * thread that is not strictly older (the change itself, on a re-explain). Omitted: no ages.
   */
  at?: string;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight of `iso`'s calendar day in local time (the same clock `formatMemoryDate` shows), as UTC ms. */
const calendarDay = (iso: string): number => {
  const d = new Date(iso);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * How long before `toIso` the change at `fromIso` was, in calendar days: "earlier the same day",
 * "the day before", "5 days earlier", "3 weeks earlier", "2 months earlier" (en) or the ko
 * equivalent. Relative to the change being explained, not to today, so a stored explanation stays
 * true however late it is read. Calendar days, not elapsed 24h periods, so 17 Sep 18:00 to 23 Sep
 * 09:00 reads "6 days earlier", matching the dates a reader sees on the timeline.
 */
export function relativeAge(fromIso: string, toIso: string, language: ExplainLanguage): string {
  const days = Math.max(0, Math.round((calendarDay(toIso) - calendarDay(fromIso)) / DAY_MS));
  const weeks = Math.round(days / 7);
  const months = Math.round(days / 30);
  if (language === 'ko') {
    if (days === 0) return '같은 날 앞서';
    if (days === 1) return '하루 전';
    if (days < 14) return `${days}일 전`;
    if (days < 60) return `${weeks}주 전`;
    return `${months}개월 전`;
  }
  if (days === 0) return 'earlier the same day';
  if (days === 1) return 'the day before';
  if (days < 14) return `${days} days earlier`;
  if (days < 60) return `${weeks} weeks earlier`;
  return `${months} months earlier`;
}

// ---- relative ages in text (DIG-121) ----

const EN_NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};
const EN_COUNT = `\\d+|a\\s+few|few|several|${Object.keys(EN_NUMBER_WORDS).join('|')}`;
/**
 * A relative age as `relativeAge` writes it in en ("earlier the same day", "the day before",
 * "3 days earlier", "2 weeks earlier") plus the paraphrases a model reaches for ("three days
 * before", "a week ago", "yesterday", "the previous days"). Not anchored; see `EN_AGE_RE`.
 */
const EN_AGE = `(?:earlier\\s+(?:the\\s+same|that)\\s+day|the\\s+(?:day|week|month)\\s+before|the\\s+previous\\s+(?:days?|weeks?|months?)|yesterday|(?:${EN_COUNT})\\s+(?:days?|weeks?|months?)\\s+(?:earlier|before|ago|prior))`;
const EN_AGE_RE = new RegExp(`\\b${EN_AGE}\\b`, 'gi');
/** The ko equivalents ("같은 날 앞서", "하루 전", "3일 전", "2주 전", "2개월 전"). A day number right after a
 * month ("9월 13일 전") is a date, not an age, so it is left to the date check. */
const KO_AGE_RE = /같은\s*날\s*앞서|하루\s*전|이틀\s*전|사흘\s*전|일주일\s*전|한\s*달\s*전|(?<![\d월./-]\s?)\d+\s*(?:일|주일?|개월|달)\s*전/g;

interface AgeMention {
  phrase: string;
  /** Language-neutral value: `d3` (3 days), `w2`, `m2`; `?…` for one that names no exact age ("a few days"). */
  key: string;
  index: number;
}

function enAgeKey(phrase: string): string {
  const p = phrase.toLowerCase().replace(/\s+/g, ' ');
  if (p.startsWith('earlier')) return 'd0';
  if (p === 'yesterday') return 'd1';
  const before = /^the (?:(day|week|month) before|previous (day|week|month))$/.exec(p);
  if (before) return `${(before[1] ?? before[2])![0]}1`;
  const counted = /^(.+?) (day|week|month)s? (?:earlier|before|ago|prior)$/.exec(p);
  if (counted) {
    const n = /^\d+$/.test(counted[1]!) ? Number(counted[1]) : EN_NUMBER_WORDS[counted[1]!];
    if (n !== undefined) return `${counted[2]![0]}${n}`;
  }
  return `?${p}`;
}

function koAgeKey(phrase: string): string {
  const p = phrase.replace(/\s+/g, '');
  const fixed: Record<string, string> = { 같은날앞서: 'd0', 하루전: 'd1', 이틀전: 'd2', 사흘전: 'd3', 일주일전: 'd7', 한달전: 'm1' };
  if (fixed[p]) return fixed[p]!;
  const m = /^(\d+)(일|주일?|개월|달)전$/.exec(p);
  if (!m) return `?${p}`;
  const unit = m[2] === '일' ? 'd' : m[2]!.startsWith('주') ? 'w' : 'm';
  return `${unit}${Number(m[1])}`;
}

/** Every relative age in `text`, en and ko patterns both (a ko reply may slip into en), in order. */
function findAges(text: string, languages: readonly ExplainLanguage[] = ['en', 'ko']): AgeMention[] {
  const out: AgeMention[] = [];
  if (languages.includes('ko')) for (const m of text.matchAll(KO_AGE_RE)) out.push({ phrase: m[0], key: koAgeKey(m[0]), index: m.index });
  if (languages.includes('en')) for (const m of text.matchAll(EN_AGE_RE)) out.push({ phrase: m[0], key: enAgeKey(m[0]), index: m.index });
  return out.sort((a, b) => a.index - b.index);
}

/** The relative age phrases in `text` (en and ko), in order, each once. */
export function relativeAgesIn(text: string): string[] {
  return [...new Set(findAges(text).map((m) => m.phrase))];
}

// ---- continuity clauses in stored L0 text (DIG-121) ----

const EN_CONT = '(?:continu(?:es|ing|ed|e)|build(?:s|ing)?\\s+on|built\\s+on|follow(?:s|ing)?\\s+(?:up\\s+on|on\\s+from)|pick(?:s|ing)?\\s+up|extend(?:s|ing)?|carr(?:ies|ying)\\s+on)';
/** ", continuing the retry work from three days earlier[ on backoff and …]" up to the clause's end. */
const EN_CLAUSE_RE = new RegExp(`,\\s*(?:and\\s+)?(?:(?:this|it|which)\\s+)?${EN_CONT}\\b[^,;.]*?\\b${EN_AGE}\\b[^,;.]*`, 'gi');
/** "Continuing the retry work from three days earlier, failed requests …" */
const EN_LEAD_RE = new RegExp(`^${EN_CONT}\\b[^,;.]*?\\b${EN_AGE}\\b[^,;.]*,\\s*`, 'i');
/** "This continues the retry work from three days earlier." as a sentence of its own. */
const EN_SENTENCE_RE = new RegExp(`^(?:this|it|that)(?:\\s+change)?\\s+${EN_CONT}\\b[^;]*?\\b${EN_AGE}\\b`, 'i');
/** Whatever age is left once no clause shape matched: drop the age itself ("added three days earlier"). */
const EN_LEFTOVER_RE = new RegExp(`\\s*\\b(?:from\\s+)?${EN_AGE}\\b`, 'gi');

/** The verb that ties a ko clause to earlier work: "이어", "이어서", "이은", "이어갑니다", … */
const KO_CONT_RE = /이어(?:갑니다|집니다|나갑니다|받습니다|서|가며|가고|받아)?|이은|잇는|잇고|잇습니다|이었습니다/;
/** A word that ends in a connective ("막고", "줄이며", "하면서"): the clause before it stands on its own. */
const KO_CONNECTIVE_RE = /(\S+?)(으며|으면서|면서|며|고)\s+/g;

/** "막" -> "막습니다", "줄이" -> "줄입니다", "만들" -> "만듭니다": a verb stem in the plain polite ending. */
function koPoliteFinal(stem: string): string {
  const last = stem.charCodeAt(stem.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return `${stem}습니다`;
  const jong = (last - 0xac00) % 28;
  if (jong !== 0 && jong !== 8) return `${stem}습니다`; // ㄹ (8) drops before ㅂ, like no final consonant
  return `${stem.slice(0, -1)}${String.fromCharCode(last - jong + 17)}니다`; // 17: ㅂ as the final consonant
}

function stripKoSentence(sentence: string): string {
  let s = sentence;
  for (let guard = 0; guard < 5; guard++) {
    const age = findAges(s, ['ko'])[0];
    if (!age) break;
    const ageEnd = age.index + age.phrase.length;
    const rest = s.slice(ageEnd);
    const clauseEnd = rest.search(/[,.!?]/);
    const verb = KO_CONT_RE.exec(clauseEnd === -1 ? rest : rest.slice(0, clauseEnd));
    // The clause starts after the last comma before the age, or after a connective word in between.
    const commaBefore = s.slice(0, age.index).search(/,\s*[^,]*$/);
    const boundary = commaBefore === -1 ? 0 : commaBefore + (/^,\s*/.exec(s.slice(commaBefore))![0].length);
    let connective: { start: number; stem: string } | null = null;
    for (const m of s.slice(boundary, age.index).matchAll(KO_CONNECTIVE_RE)) {
      connective = { start: boundary + m.index, stem: m[1]! };
    }
    if (verb) {
      const verbEnd = ageEnd + verb.index + verb[0].length;
      if (!/니다$/.test(verb[0])) {
        // "…, 3일 전 자동 재시도 작업을 이어 서버 부담을 줄입니다." -> "…, 서버 부담을 줄입니다."
        const start = connective ? connective.start + s.slice(connective.start).indexOf(' ') + 1 : boundary;
        const after = verbEnd + (/^,?\s*/.exec(s.slice(verbEnd))![0].length);
        s = s.slice(0, start) + s.slice(after);
        continue;
      }
      if (connective) {
        // "…, 요청 반복을 막고 3일 전 재시도 작업을 이어갑니다." -> "…, 요청 반복을 막습니다."
        s = s.slice(0, connective.start) + koPoliteFinal(connective.stem) + s.slice(verbEnd);
        continue;
      }
    }
    // No clause shape to cut cleanly: drop the age alone ("3일 전의 작업" -> "작업").
    s = s.slice(0, age.index) + s.slice(ageEnd).replace(/^의?\s*/, '');
  }
  return s;
}

function stripEnSentence(sentence: string): string {
  if (findAges(sentence, ['en']).length === 0) return sentence;
  if (EN_SENTENCE_RE.test(sentence)) return '';
  let s = sentence.replace(EN_CLAUSE_RE, '');
  const lead = s.replace(EN_LEAD_RE, '');
  if (lead !== s) s = lead.charAt(0).toUpperCase() + lead.slice(1);
  if (findAges(s, ['en']).length > 0) s = s.replace(EN_LEFTOVER_RE, '');
  return s;
}

const tidy = (s: string): string =>
  s.replace(/\s+([,.;!?])/g, '$1').replace(/,\s*([.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();

/**
 * Stored L0 text without the continuity clauses it was written with (DIG-121). An L0 that said
 * "…, continuing the retry work from three days earlier" ("…3일 전 … 작업을 이어갑니다") was true
 * on its own date; quoted later as a thread's title or entry, that age is stale and a reply
 * copies it. Every relative age goes: the clause around it when it has a known shape (", continuing
 * … from <age>", "This continues … <age>.", "<age> … 작업을 이어", "…막고 <age> … 이어갑니다"),
 * otherwise the age phrase alone. Text with no relative age comes back unchanged. en and ko
 * patterns both apply, whatever the item's language.
 */
export function stripContinuity(text: string): string {
  if (findAges(text).length === 0) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out = tidy(sentences.map((s) => tidy(stripEnSentence(stripKoSentence(s)))).filter((s) => s !== '').join(' '));
  return out === '' ? tidy(text.replace(EN_LEFTOVER_RE, '').replace(KO_AGE_RE, '')) : out;
}

/**
 * Flags every relative age in the output that is not the age of an earlier change the slice
 * gives (DIG-121): `ages` are `MemorySlice.ages`, exactly as `relativeAge` wrote them, and
 * `otherSources` is the diff and project context (an age the code itself contains is the
 * diff's own fact). Quoted L0 text in the slice is deliberately not a source: its ages were
 * measured from that change's own date. "three days earlier" equals "3 days earlier"; "a few days
 * earlier" equals nothing. A hard violation, worded like the date check's so the kit counts both.
 */
export function checkMemoryAgeClaims(
  texts: readonly string[], ages: readonly string[], otherSources: string, language: ExplainLanguage,
): string[] {
  const allowed = new Set([...ages.flatMap((a) => findAges(a)), ...findAges(otherSources)].map((m) => m.key));
  const languages: ExplainLanguage[] = language === 'ko' ? ['ko', 'en'] : ['en'];
  const v: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of findAges(text, languages)) {
      if (allowed.has(m.key) || seen.has(m.phrase)) continue;
      seen.add(m.phrase);
      v.push(`mentions the relative age "${m.phrase}", which is not the age of any earlier change in the memory slice (date check): use an age exactly as given there, or drop the claim`);
    }
  }
  return v;
}

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

/** "note from the user, Tue 22 Sep" -- the provenance a reply cites a note by (DIG-114). */
function noteLabel(note: MemoryItem, language: ExplainLanguage): string {
  return `note from the user, ${formatMemoryDate(note.updatedAt, language)}`;
}

/** A selected item whose own text a user note replaces: the item's name, then the note, labelled
 * as the user's, so the model can cite it as a note rather than as a bare fact. */
function renderOverride(label: string, note: MemoryItem, language: ExplainLanguage): string {
  return `- ${label} — ${noteLabel(note, language)}: ${redact((note.content as NoteMemory).text)}`;
}

function renderTerm(c: TermMemory): string {
  const meaning = c.meaning ? redact(c.meaning) : null;
  return meaning ? `- ${c.term} (term): ${meaning}` : `- ${c.term} (term)`;
}

/** The thread's digests a reply may cite as earlier work: all of them, or only the ones strictly
 * older than the change being explained when `at` is known. Oldest first. */
function priorDigests(c: ThreadMemory, at: string | undefined): ThreadDigestRef[] {
  const prior = at === undefined ? [...c.digests] : c.digests.filter((d) => d.at < at);
  return prior.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
}

/**
 * A thread as the earlier changes a reader can find on the timeline (DIG-114): its title (the first
 * change's L0), the latest earlier change's L0, and how long before this change each was. No dates:
 * "thread of Thu 17 Sep" named nothing the reader could look up. DIG-121: the title, the latest L0
 * and the summary go through `stripContinuity`, so the only ages in the line are the ones computed
 * here (returned as `ages`), never one an old L0 measured from its own date.
 */
function renderThread(
  c: ThreadMemory, prior: readonly ThreadDigestRef[], language: ExplainLanguage, at: string | undefined,
): { text: string; ages: string[] } {
  const first = prior[0]!;
  const latest = prior[prior.length - 1]!;
  const age = (d: ThreadDigestRef): string | null => (at === undefined ? null : relativeAge(d.at, at, language));
  const changes = prior.length === 1
    ? [`1 earlier change`, age(first)]
    : [`${prior.length} earlier changes`, age(first) && `first ${age(first)}`, `latest "${stripContinuity(latest.l0)}"${age(latest) ? ` ${age(latest)}` : ''}`];
  const meta = changes.filter((p): p is string => p !== null).join('; ');
  const title = stripContinuity(c.title);
  const summary = c.summary ? stripContinuity(redact(c.summary)) : null;
  const ages = [age(first), prior.length > 1 ? age(latest) : null].filter((a): a is string => a !== null);
  return { text: `- ${title} (thread; ${meta})${summary && summary !== title ? `: ${summary}` : ''}`, ages };
}

/** A note on its own (category 1): the target it is about, then the note, labelled as the user's. */
function renderNote(note: MemoryItem, language: ExplainLanguage): string {
  const c = note.content as NoteMemory;
  const about = c.target ? ` on ${c.target.key}` : '';
  return `- ${noteLabel(note, language)}${about}: ${redact(c.text)}`;
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
  /** The relative ages this line gives as ages of earlier changes (a thread line's, see `renderThread`). */
  ages: string[];
  /**
   * Whether this line ties the slice to this specific change (a note, a pinned item, a term the
   * diff uses, a thread sharing one): an area's `uses`/`usedBy` line on its own is structure the
   * project context already gives, so a slice of only those is not sent at all (DIG-114).
   */
  specific: boolean;
}

/**
 * Picks the slice of `items` to ground one prompt: user notes on touched areas, pinned items,
 * touched areas (relationships only), terms the diff mentions, open threads on touched areas that
 * share a term with the diff, then neighbouring areas (docs/milestone-4-memory.md §3). Never
 * `stale`/`hidden`. A user note whose `target` is a selected item replaces that item's own text,
 * labelled as the user's note. Deterministic and pure: ties within a category break on `key`,
 * ascending. Items are added in that order while they fit in `budget` (estimated tokens); one that
 * does not fit is skipped whole (never partially rendered) and counted in `droppedForBudget`, and a
 * shorter, later item may still fit after it. A slice whose kept lines are all area relationships
 * (nothing specific to this change, see `Candidate.specific`) comes back empty, so no `<memory>`
 * block is sent (DIG-114).
 */
export function selectMemory(items: readonly MemoryItem[], request: MemoryRequest, budget: number): MemorySlice {
  const { language, at } = request;
  const active = inLanguage(items.filter((it) => it.status === 'active'), language);
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
  const take = (it: MemoryItem, text: string, specific: boolean, alsoUses: MemoryItem[] = [], ages: string[] = []): void => {
    const k = key(it.kind, it.key);
    if (selectedKeys.has(k)) return;
    selectedKeys.add(k);
    candidates.push({ item: it, alsoUses, text, specific, ages });
  };
  const bySortedKey = (list: MemoryItem[]): MemoryItem[] => [...list].sort((a, b) => cmp(a.key, b.key));
  /** `render()` unless a user note targets the item, in which case the note's text stands in for it. */
  const takeWithOverride = (it: MemoryItem, label: string, render: () => string | { text: string; ages: string[] }, specific: boolean): void => {
    const override = byTargetKey.get(key(it.kind, it.key));
    if (override) {
      take(it, renderOverride(label, override, language), true, [override]);
      return;
    }
    const r = render();
    if (typeof r === 'string') take(it, r, specific);
    else take(it, r.text, specific, [], r.ages);
  };

  // 1. User notes on touched areas: the note's own text stands in for the area it targets, so the
  // area is left out of category 3 below (its key is already marked selected via `notedAreas`).
  const notedAreas = new Set<string>();
  const areaNotes = active.filter(
    (it): it is MemoryItem & { content: NoteMemory } =>
      it.kind === 'note' && (it.content as NoteMemory).target?.kind === 'area' && touched.has((it.content as NoteMemory).target!.key),
  );
  for (const n of bySortedKey(areaNotes)) {
    notedAreas.add((n.content as NoteMemory).target!.key);
    take(n, renderNote(n, language), true);
  }

  // 2. Pinned items of any kind.
  const pinned = active.filter((it) => it.pinned && it.kind !== 'note');
  for (const it of bySortedKey(pinned)) {
    if (it.kind === 'area') takeWithOverride(it, `${it.key} (area, pinned)`, () => renderAreaFull(it.key, it.content as AreaMemory), true);
    else if (it.kind === 'term') takeWithOverride(it, `${(it.content as TermMemory).term} (term)`, () => renderTerm(it.content as TermMemory), true);
    else if (it.kind === 'thread') {
      const prior = priorDigests(it.content as ThreadMemory, at);
      if (prior.length === 0) continue; // nothing earlier than this change to point at
      takeWithOverride(it, `${stripContinuity((it.content as ThreadMemory).title)} (thread)`, () => renderThread(it.content as ThreadMemory, prior, language, at), true);
    }
  }

  // 3. Touched areas (relationships only), excluding ones already covered by a note in category 1.
  const touchedAreaItems = active.filter((it) => it.kind === 'area' && touched.has(it.key));
  for (const it of bySortedKey(touchedAreaItems)) {
    if (notedAreas.has(it.key)) continue;
    take(it, renderAreaLinks(it.key, it.content as AreaMemory), false);
  }

  // 4. Terms found in the diff.
  const diffTerms = active.filter((it) => it.kind === 'term' && identifiers.has((it.content as TermMemory).term));
  for (const it of bySortedKey(diffTerms)) {
    takeWithOverride(it, `${(it.content as TermMemory).term} (term)`, () => renderTerm(it.content as TermMemory), true);
  }

  // 5. Open threads on touched areas with earlier changes to point at. A thread that has terms must
  // share one with the diff (DIG-114): in a project whose code sits in one or two folders, area
  // overlap alone ties every change to whatever thread is open there. A thread with no terms yet
  // keeps the area-overlap rule, which is all there is to go on.
  const openThreads = active.filter((it) => {
    if (it.kind !== 'thread') return false;
    const c = it.content as ThreadMemory;
    if (c.state !== 'open' || !c.areas.some((a) => touched.has(a))) return false;
    return c.terms.length === 0 || c.terms.some((t) => identifiers.has(t));
  });
  for (const it of bySortedKey(openThreads)) {
    const prior = priorDigests(it.content as ThreadMemory, at);
    if (prior.length === 0) continue;
    takeWithOverride(it, `${stripContinuity((it.content as ThreadMemory).title)} (thread)`, () => renderThread(it.content as ThreadMemory, prior, language, at), true);
  }

  // 6. Neighbouring areas: connected to a touched area via `uses`/`usedBy`, but not touched themselves.
  const neighbourKeys = new Set<string>();
  for (const it of touchedAreaItems) {
    const c = it.content as AreaMemory;
    for (const k of [...c.uses, ...c.usedBy]) if (!touched.has(k)) neighbourKeys.add(k);
  }
  const neighbours = active.filter((it) => it.kind === 'area' && neighbourKeys.has(it.key) && !touched.has(it.key));
  for (const it of bySortedKey(neighbours)) {
    takeWithOverride(it, `${it.key} (area)`, () => renderAreaLinks(it.key, it.content as AreaMemory), false);
  }

  const kept: Candidate[] = [];
  let tokens = 0;
  let dropped = 0;
  for (const c of candidates) {
    const lineTokens = estimateTokens(`${c.text}\n`);
    if (tokens + lineTokens > budget) {
      dropped++;
      continue;
    }
    tokens += lineTokens;
    kept.push(c);
  }
  if (!kept.some((c) => c.specific)) return { items: [], text: '', tokens: 0, droppedForBudget: dropped, ages: [] };

  const used = new Map<number, number>();
  for (const c of kept) {
    used.set(c.item.id, c.item.version);
    for (const extra of c.alsoUses) used.set(extra.id, extra.version);
  }
  return {
    items: [...used.entries()].map(([id, version]) => ({ id, version })),
    text: kept.map((c) => c.text).join('\n'),
    tokens,
    droppedForBudget: dropped,
    ages: [...new Set(kept.flatMap((c) => c.ages))],
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

/** What a reply that was sent a memory slice is checked against (`checkMemoryClaims`). */
export interface MemoryCheckSources {
  /** Slice, project context and diff: where a date or a mechanism phrase may come from (`memoryDateSources`). */
  text: string;
  /** The ages the slice gives as ages of earlier changes (`MemorySlice.ages`). */
  ages: readonly string[];
  /** Project context and diff only: an age found here is the code's own (`checkMemoryAgeClaims`). */
  codeText: string;
}

export function memoryCheckSources(slice: MemorySlice, files: readonly ProviderFile[], context?: string): MemoryCheckSources {
  return {
    text: memoryDateSources(slice.text, files, context),
    ages: slice.ages ?? [],
    codeText: memoryDateSources('', files, context),
  };
}

/** Every memory rule a reply is held to once a slice was sent: dates, relative ages, and never naming the mechanism. */
export function checkMemoryClaims(texts: readonly string[], sources: MemoryCheckSources, language: ExplainLanguage): string[] {
  return [
    ...checkMemoryDateClaims(texts, sources.text, language),
    ...checkMemoryAgeClaims(texts, sources.ages, sources.codeText, language),
    ...checkMemoryMechanism(texts, sources.text, language),
  ];
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

// ---- naming the mechanism (DIG-114) ----

const MEM_EN = "(?:the\\s+|this\\s+)?(?:project(?:'s)?\\s+)?memory";
/**
 * Phrases that cite `<memory>` itself instead of what it holds: "memory says", "according to
 * memory", "the convention in memory", "noted in memory", "project memory", "memory slice".
 * Precision over recall: the check runs only when a slice was sent, so a false hit costs the
 * memory-on side a retry the memory-off side never pays. Ordinary talk about code is left alone:
 * not a bare "in memory" ("cached in memory"), no generic nouns or verbs before it ("records in
 * memory", "found in memory"), no "memory holds/has/shows" (heap usage), no "memory block"
 * (allocation). A missed leak is still caught by the reader.
 */
const MECHANISM_RE_EN = new RegExp(
  [
    `\\b${MEM_EN}\\s+(?:says|said|notes|noted|states|stated|mentions|mentioned)\\b`,
    `\\baccording\\s+to\\s+${MEM_EN}\\b`,
    // "per memory, ..." but not "cost per memory access"
    `\\bper\\s+${MEM_EN}\\b(?![ \\t]+[a-z])`,
    `\\b(?:conventions?|notes?|threads?|rules?|corrections?)\\s+(?:in|from)\\s+${MEM_EN}\\b`,
    `\\b(?:listed|noted|mentioned|given|described|documented|stated|remembered)\\s+(?:in|from)\\s+${MEM_EN}\\b`,
    "\\bproject(?:'s)?\\s+memory\\b",
    '\\bmemory\\s+(?:slice|items?)\\b',
    '<\\/?memory>',
  ].join('|'),
  'gi',
);
/** The ko equivalents ("메모리에 따르면", "메모리에 있는 규칙", "규칙은 메모리에"). Same precision rule as
 * en: never a bare "메모리에 저장/있는/기록된" or "메모리 상의" (data held in memory is what code does);
 * those count only when they lead to a convention, note or thread. */
const KO_MEMORY_NOUN = '(?:규칙|관례|컨벤션|노트|메모|스레드|정정)';
const MECHANISM_RE_KO = new RegExp(
  [
    '메모리\\s*에\\s*따르면',
    `메모리\\s*(?:에|에서|상)\\s*(?:의\\s*)?(?:있는|나온|나와\\s*있는|기록된|적힌|적혀\\s*있는|언급된|명시된|남긴|남아\\s*있는|정의된|말하는)\\s*(?:\\S+\\s+)?${KO_MEMORY_NOUN}`,
    `${KO_MEMORY_NOUN}\\s*(?:은|는|이|가|도)?\\s*메모리\\s*(?:에|에서|상)`,
    '프로젝트\\s*메모리',
    '메모리\\s*(?:슬라이스|항목)',
  ].join('|'),
  'g',
);

/**
 * Flags output text that names the memory mechanism instead of citing its source the way a
 * colleague would (DIG-114: "The 200ms convention in memory is not applied here."). The reader
 * never sees `<memory>`, so "in memory" points at nothing; the fix is "the user's note of <date>
 * says ..." or the earlier change by name. A phrase that also appears in `sources` (see
 * `memoryDateSources`) is the diff's own wording -- DigestIT explaining its own memory code, say --
 * and is not flagged. A ko reply is checked against both the ko and the en phrases.
 */
export function checkMemoryMechanism(texts: readonly string[], sources: string, language: ExplainLanguage): string[] {
  const patterns = language === 'ko' ? [MECHANISM_RE_KO, MECHANISM_RE_EN] : [MECHANISM_RE_EN];
  const haystack = norm(sources);
  const v: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const found = m[0].trim();
        const n = norm(found);
        if (seen.has(n)) continue;
        seen.add(n);
        if (inSources(haystack, n)) continue;
        v.push(`names the memory mechanism ("${found}"), cite the source the way a colleague would (the user's note of its date, or the earlier change by its title)`);
      }
    }
  }
  return v;
}
