import type { ExplainLanguage } from '@digestit/core';
import { aiTells } from './tells.js';
import { cleanText, hasUnsafeMarkup, truncateWords, wordCount } from './validate.js';

// Shared voice, language and boilerplate rules for the digest, area and context prompts (DIG-48).

export const DEFAULT_LANGUAGE: ExplainLanguage = 'en';

export const KO_CHARS_PER_WORD = 5;

/** Tone rules pasted into every user-facing prompt. */
export const VOICE = `Voice: you are a senior engineer explaining this to a colleague who knows the project but has not read this change. Write plain, natural sentences in the active voice, as you would say them out loud. Name the concrete things: functions, flags, endpoints, config keys, commands, screens. Say what happens, not that "something changed". Never write filler such as "may have changed", "Changed here.", "Changes in <folder>", "file(s)" or a bare "No user-visible change". When the change does not show something (for example why a limit was picked), say in one clause what exactly is unclear and what would settle it (a test, a ticket, the caller); never write a bare "not evident from the diff".
Style: start every field with its concrete subject, never with "This change", "This commit", "This PR", "This update" or "This area" followed by a generic verb like "introduces/enhances/improves/adds" — name the function, flag, screen or file first, so two areas of the same change never read like the same template. Avoid hedges and filler: "it's worth noting", "it is important to note", "essentially", "various", "a number of", "ensures that", "helps to" — state the fact directly instead. Avoid marketing words: "seamless", "effortless", "powerful", "robust", "comprehensive", "streamlined", "leverage", "unlock", "supercharge", "delve", "elevate" — and never write "enhances"/"improves" without naming what concretely changed. A claim that something is more maintainable, readable, reliable or performant needs a number, a name or a mechanism in the same sentence, not just the adjective. Write plain prose: no "!", no markdown bold or italics ("**", "__"), at most one em dash per sentence, and no rhythmic triplet of comparatives like "faster, safer, and more reliable". Never end with a recap sentence such as "In summary", "To summarize", "In conclusion" or a trailing "Overall, ..." — stop after the last concrete point.`;

/** The language rule: prose in `language`, code as written, JSON keys and ids in English. */
export function languageInstruction(language: ExplainLanguage): string {
  if (language === 'ko') {
    return `Language: write every prose value (everything a reader sees: sentences, titles, bullets, list items) in Korean (한국어), in the concise written style a Korean senior engineer uses with a colleague (~합니다/~습니다 endings; never 하십시오체 such as "…하십시오"/"…바랍니다"; no translationese, no English sentences). Avoid "전반적으로" (overall), "다양한" (various), "효율적으로" (efficiently) and "보다 원활한/원활하게" (smoother) as vague filler, and never open with a chatty "살펴보겠습니다"/"알아보겠습니다" ("let's look at/find out") — state the fact directly. Keep code identifiers, file paths, flags, endpoints, commands and quoted code exactly as written in the change: never translate or transliterate them. JSON keys, ids and hunk references stay exactly as specified. "Words" below means space-separated words (어절). Each field may also use at most ${KO_CHARS_PER_WORD} characters per allowed word, spaces included (e.g. at most ${8 * KO_CHARS_PER_WORD} characters for an 8-word title).`;
  }
  return 'Language: write every prose value in English. Keep code identifiers, file paths, flags, endpoints and quoted code exactly as written in the change.';
}

/**
 * Character cap per field: `KO_CHARS_PER_WORD` per allowed word for Korean (one 어절 often carries
 * more than one English word, and code identifiers inside Korean prose are long); generous for English.
 */
export function charCap(language: ExplainLanguage, words: number): number {
  return language === 'ko' ? words * KO_CHARS_PER_WORD : words * 12;
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

interface Pattern {
  re: RegExp;
  label: string;
}

/** Phrases that read as generated filler in any prose field. */
const FILLER: Pattern[] = [
  { re: /\bmay have changed\b/i, label: '"may have changed"' },
  { re: /\breason not evident from the change\b/i, label: '"reason not evident from the change"' },
  { re: /\b(?:file|line|area|change|commit|test|module|folder|director(?:y|ie)|item|hunk|function|step)s?\((?:e?s)\)/i, label: '"file(s)"-style plural' },
  { re: /변경되었을 수 있습니다|바뀌었을 수 있습니다/, label: '"변경되었을 수 있습니다"' },
  { re: /[가-힣]+\(들\)/, label: '"파일(들)"-style plural' },
];

/** Whole-field filler: the field says nothing else. */
const FILLER_WHOLE: Pattern[] = [
  { re: /^(?:changed|added|removed) here\.?$/i, label: '"Changed here."' },
  { re: /^no user-visible changes?\.?$/i, label: 'a bare "No user-visible change"' },
  { re: /^changes? (?:in|to|under) [\w./@()-]+\.?$/i, label: '"Changes in <folder>"' },
  { re: /^여기(?:서|에서)? (?:변경|추가|삭제)(?:됨|되었습니다)\.?$/, label: '"여기서 변경됨"' },
  { re: /^사용자(?:에게)? 보이는 변경(?:\s*사항)?(?:이)? 없(?:음|습니다)\.?$/, label: 'a bare "사용자에게 보이는 변경 없음"' },
  { re: /^[\w./@()-]+(?:의|에서의)? 변경(?:\s*사항)?\.?$/, label: '"<폴더> 변경 사항"' },
];

/** "not evident from the diff" and friends: allowed only in a sentence long enough to say what is unclear and what would settle it. */
const UNCLEAR: RegExp[] = [
  /\bnot (?:evident|clear|obvious|shown|visible) (?:from|in) the (?:diff|change|code|patch)\b/i,
  /(?:diff|변경 내용|코드|변경)(?:에서|만으로(?:는)?)\s*(?:는\s*)?(?:알 수 없|확인할 수 없|드러나지 않|파악할 수 없)/,
];
const UNCLEAR_MIN_WORDS = { en: 12, ko: 8 } as const;

/**
 * Returns a short reason when `text` is boilerplate: a filler phrase, a
 * whole-field placeholder, or a bare "not evident from the diff". `null` when fine.
 */
export function boilerplate(text: string, language: ExplainLanguage = DEFAULT_LANGUAGE): string | null {
  const t = text.trim();
  for (const p of FILLER) if (p.re.test(t)) return `uses the filler ${p.label}`;
  for (const p of FILLER_WHOLE) if (p.re.test(t)) return `is only the filler ${p.label}`;
  for (const sentence of t.split(/(?<=[.!?。])\s+/)) {
    if (UNCLEAR.some((re) => re.test(sentence)) && sentence.trim().split(/\s+/).length < UNCLEAR_MIN_WORDS[language]) {
      return 'says something is not evident from the diff without saying what is unclear and what would settle it';
    }
  }
  return null;
}

/** An L0 that is a stats line ("15 files changed, +120 / -30") instead of a sentence about why. */
export function isStatsLine(text: string): boolean {
  return /^\s*\d+\s+(?:files?|changes?|lines?)\b/i.test(text) ||
    /[+]\d+\s*\/\s*-\d+/.test(text) ||
    /\b\d+\s+files?\s+changed\b/i.test(text) ||
    /^\s*\d+\s*개\s*파일/.test(text);
}

export interface CheckProseOptions {
  /**
   * `false` for a one-line headline (DIG-94): an over-limit field is still
   * flagged in `v` so a retry gets the chance to fix it, but the delivered
   * text is kept whole rather than cut mid-sentence with a trailing ellipsis.
   * Default `true` (cut to the limit, as every other prose field already did).
   */
  truncate?: boolean;
}

/**
 * Cleans one prose field and checks it against a word limit, the language's
 * character cap, the boilerplate rules and the AI-tell lint. Over-limit text
 * is cut unless `opts.truncate` is `false`; boilerplate and tells are
 * reported but never rewritten or truncated on their account (only a retry
 * can replace them). Tells go into `styleWarnings`, never `v`: they are soft
 * signals, not hard violations.
 */
export function checkProse(
  raw: string, label: string, words: number, language: ExplainLanguage, v: string[], styleWarnings: string[] = [],
  opts: CheckProseOptions = {},
): string {
  const truncate = opts.truncate ?? true;
  if (hasUnsafeMarkup(raw)) v.push(`${label}: contains HTML or a link`);
  let text = cleanText(raw);
  if (wordCount(text) > words) {
    v.push(`${label}: ${wordCount(text)} words, limit ${words}`);
    if (truncate) text = truncateWords(text, words);
  }
  const cap = charCap(language, words);
  if (charLength(text) > cap) {
    v.push(`${label}: ${charLength(text)} characters, limit ${cap}`);
    if (truncate) text = truncateChars(text, cap);
  }
  if (text !== '') {
    const bad = boilerplate(text, language);
    if (bad) v.push(`${label}: ${bad}`);
    for (const tell of aiTells(text, language)) styleWarnings.push(`${label}: ${tell}`);
  }
  return text;
}
