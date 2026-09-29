import type { ExplainLanguage } from '@digestit/core';

/**
 * AI-tell lint (DIG-63/DIG-65): pattern-matches prose for the chatty, hedging,
 * marketing and structural habits that make generated text read as AI output.
 * Pure and deterministic; every hit is a soft `styleWarnings` signal, never a
 * hard violation — callers never truncate or rewrite text because of a tell.
 */

export interface TellHit {
  /** Stable id for the lint-report tool to count by rule. */
  id: string;
  /** Short, specific reason fed back to the model on retry: says what to do instead. */
  reason: string;
}

// ---- stripping: code spans and identifiers/paths never trip a tell ----

const CODE_SPAN = /`[^`]*`/g;
const DUNDER = /\b__[A-Za-z_]\w*__\b/g;
const FUNC_CALL = /\b[A-Za-z_$][\w$]*\s*\([^()]*\)/g;
const PATH_LIKE = /\b[\w.-]+\/[\w./-]+\b/g;
const FILE_LIKE = /\b[\w-]+\.(?:tsx?|jsx?|json|md|ya?ml|py|sql|sh|css|html|toml|lock)\b/gi;

/** Removes code spans, function calls, paths and file names so a word inside one of them (`enhanceRetry()`, `docs/various.md`) never trips a tell. */
function stripCodeAndIdentifiers(s: string): string {
  return s.replace(CODE_SPAN, ' ').replace(DUNDER, ' ').replace(FUNC_CALL, ' ').replace(PATH_LIKE, ' ').replace(FILE_LIKE, ' ');
}

const SENTENCE_SPLIT = /(?<=[.!?。])\s+/;
function sentences(s: string): string[] {
  return s.split(SENTENCE_SPLIT).map((p) => p.trim()).filter((p) => p !== '');
}

// ---- English rules ----

interface Rule {
  id: string;
  re: RegExp;
  reason: string;
}

const EN_OPENERS: Rule[] = [
  {
    id: 'opener-this-x',
    re: /^this\s+(?:change|commit|pr|update|area)\s+(?:introduces|enhances|improves|adds)\b/i,
    reason: 'opens with "This change/commit/PR/update/area introduces/enhances/improves/adds…": start with the concrete subject instead (the function, flag or screen)',
  },
  {
    id: 'opener-in-this',
    re: /^in\s+this\s+(?:commit|change)\b/i,
    reason: 'opens with "In this commit/change…": start with the concrete subject instead',
  },
  {
    id: 'opener-overall',
    re: /^overall,/i,
    reason: 'opens with "Overall, …": name the specific thing that changed instead',
  },
];

const EN_RECAP: Rule[] = [
  { id: 'recap-in-summary', re: /^in\s+summary\b/i, reason: 'ends with a recap ("In summary…"): drop it, the reader already read the rest' },
  { id: 'recap-to-summarize', re: /^to\s+summarize\b/i, reason: 'ends with a recap ("To summarize…"): drop it, the reader already read the rest' },
  { id: 'recap-in-conclusion', re: /^in\s+conclusion\b/i, reason: 'ends with a recap ("In conclusion…"): drop it, the reader already read the rest' },
  { id: 'recap-overall', re: /^overall,/i, reason: 'ends with a recap ("Overall, …"): drop it, the reader already read the rest' },
];

const EN_HEDGES: Rule[] = [
  { id: 'hedge-worth-noting', re: /\bit(?:'s|\s+is)\s+worth\s+noting\b/i, reason: 'uses the hedge "it\'s worth noting": state the fact directly' },
  { id: 'hedge-important-to', re: /\bit(?:'s|\s+is)\s+important\s+to(?:\s+note)?\b/i, reason: 'uses the hedge "it is important to (note)": state the fact directly' },
  { id: 'hedge-essentially', re: /\bessentially\b/i, reason: 'uses the filler word "essentially": say the mechanism directly instead' },
  { id: 'hedge-various', re: /\bvarious\b/i, reason: 'uses the vague word "various": name the specific things instead' },
  { id: 'hedge-a-number-of', re: /\ba number of\b(?!\s*\d)/i, reason: 'uses the vague quantifier "a number of": give the actual count or name the items' },
  { id: 'hedge-ensures-that', re: /\bensures?\s+that\b/i, reason: 'uses the filler "ensures that": say what happens directly' },
  { id: 'hedge-helps-to', re: /\bhelps?\s+to\b/i, reason: 'uses the filler "helps to": say what it does directly' },
];

const EN_MARKETING: Rule[] = [
  { id: 'marketing-seamless', re: /\bseamless(?:ly)?\b/i, reason: 'uses the marketing word "seamless(ly)": describe the concrete mechanism instead' },
  { id: 'marketing-effortless', re: /\beffortless(?:ly)?\b/i, reason: 'uses the marketing word "effortless(ly)": describe the concrete mechanism instead' },
  { id: 'marketing-powerful', re: /\bpowerful\b/i, reason: 'uses the marketing word "powerful": name what it actually does instead' },
  { id: 'marketing-robust', re: /\brobust\b/i, reason: 'uses the marketing word "robust": name the specific case it now handles instead' },
  { id: 'marketing-comprehensive', re: /\bcomprehensive\b/i, reason: 'uses the marketing word "comprehensive": name what is actually covered instead' },
  { id: 'marketing-streamline', re: /\bstreamlin(?:e|es|ed|ing)\b/i, reason: 'uses the marketing word "streamline(d)": name the concrete steps that changed instead' },
  { id: 'marketing-leverage', re: /\bleverag(?:e|es|ed|ing)\b/i, reason: 'uses the marketing word "leverage(s)": name what it uses instead' },
  { id: 'marketing-unlock', re: /\bunlocks?\b(?![^.!?]*\b(?:mutex|locks?|semaphore)\b)/i, reason: 'uses the marketing word "unlock(s)": name what becomes possible instead' },
  { id: 'marketing-supercharge', re: /\bsupercharg(?:e|es|ed|ing)\b/i, reason: 'uses the marketing word "supercharge": name the concrete improvement instead' },
  { id: 'marketing-delve', re: /\bdelv(?:e|es|ed|ing)\b/i, reason: 'uses the marketing word "delve": say what it does instead' },
  { id: 'marketing-elevate', re: /\belevat(?:e|es|ed|ing)\b(?!\s+(?:privileges?|permissions?|rights|access|shell|prompt)\b)/i, reason: 'uses the marketing word "elevate": name the concrete improvement instead' },
  {
    id: 'marketing-enhance-bare',
    re: /\benhance[sd]?\b(?=\s*(?:[.,;:]|$))/i,
    reason: 'uses "enhance(s/d)" with no concrete object: name what specifically changed',
  },
];

const VAGUE_NOUNS = ['maintainability', 'readability', 'user experience', 'reliability', 'performance'];
const VAGUE_RE = new RegExp(`\\b(?:improves?|enhances?)\\s+(?:the\\s+)?(?:overall\\s+)?(${VAGUE_NOUNS.join('|')})\\b`, 'i');
const CONCRETE_SIGNAL = /\d|`[^`]*`|\b[a-z][a-z0-9]*[A-Z]\w*\b|\b[A-Z][a-zA-Z0-9]*[A-Z]\w*\b|[\w-]+\/[\w./-]+|\w+\([^()]*\)/;

// A closed list, not any "-er" word or "more <noun>": "parser, lexer, and printer" or
// "more tests, more logs, and more retries" are concrete and must not trip the triplet.
const EN_ADJ = ['fast', 'safe', 'simple', 'easy', 'clean', 'secure', 'reliable', 'scalable', 'flexible', 'efficient', 'quick', 'strong', 'smooth'];
const EN_COMPARATIVES = ['faster', 'safer', 'simpler', 'easier', 'cleaner', 'quicker', 'stronger', 'smoother', 'better', 'clearer', 'leaner', 'lighter', 'smaller', 'tighter'];
const EN_MORE_ADJ = [...EN_ADJ, 'robust', 'readable', 'maintainable', 'stable', 'consistent', 'predictable', 'intuitive', 'responsive', 'resilient', 'accessible', 'performant', 'powerful'];
const TRIPLET_TERM = `(?:${EN_COMPARATIVES.join('|')}|more\\s+(?:${EN_MORE_ADJ.join('|')})|${EN_ADJ.join('|')})`;
const TRIPLET_RE = new RegExp(`\\b${TRIPLET_TERM}\\s*,\\s*${TRIPLET_TERM}\\s*,?\\s*(?:and|&)\\s*${TRIPLET_TERM}\\b`, 'i');
const BOLD_RE = /\*\*(?!\s)[^*\n]+?(?<!\s)\*\*/;
const ITALIC_RE = /__(?!\s)[^_\n]+?(?<!\s)__/;

function hasBareExclamation(strippedSentence: string): boolean {
  // Only a "!" that ends a word ("great!"), not an operator ("!ready", "!==").
  return /[\p{L}\p{N})"'”]!+(?=\s|$)/u.test(strippedSentence.replace(/!==?/g, ' '));
}

/** Bare "!", markdown bold/italics and em-dash chains: shared by both languages. */
function structureTells(stripped: string, strippedSentences: readonly string[]): TellHit[] {
  const hits: TellHit[] = [];
  if (strippedSentences.some((s) => hasBareExclamation(s))) hits.push({ id: 'structure-exclamation', reason: 'uses "!" in prose: end the sentence with a period' });
  if (BOLD_RE.test(stripped) || ITALIC_RE.test(stripped)) {
    hits.push({ id: 'structure-bold', reason: 'uses markdown bold or italics ("**" or "__") in prose: write it as plain text' });
  }
  if (strippedSentences.some((s) => (s.match(/—/g) ?? []).length >= 2)) {
    hits.push({ id: 'structure-em-dash-chain', reason: 'uses two or more em dashes in one sentence: rewrite as separate sentences or a comma' });
  }
  return hits;
}

function enTells(text: string): TellHit[] {
  const hits: TellHit[] = [];
  const seen = new Set<string>();
  const push = (id: string, reason: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      hits.push({ id, reason });
    }
  };

  const raw = text.trim();
  const stripped = stripCodeAndIdentifiers(raw);
  const rawSentences = sentences(raw);
  const strippedSentences = sentences(stripped);

  for (const r of EN_OPENERS) if (r.re.test(stripped)) push(r.id, r.reason);
  if (strippedSentences.length > 0) {
    const last = strippedSentences[strippedSentences.length - 1]!;
    for (const r of EN_RECAP) if (r.re.test(last)) push(r.id, r.reason);
  }
  for (const r of EN_HEDGES) if (r.re.test(stripped)) push(r.id, r.reason);
  for (const r of EN_MARKETING) if (r.re.test(stripped)) push(r.id, r.reason);

  strippedSentences.forEach((s, i) => {
    const m = VAGUE_RE.exec(s);
    if (m && !CONCRETE_SIGNAL.test(rawSentences[i] ?? s)) {
      push('vague-value-claim', `claims "${m[0]}" with no number, name or mechanism in the sentence: name the concrete change that causes it`);
    }
  });

  for (const h of structureTells(stripped, strippedSentences)) push(h.id, h.reason);
  if (strippedSentences.some((s) => TRIPLET_RE.test(s))) {
    push('structure-triplet', 'uses a rhythmic triplet of comparatives ("faster, safer, and more reliable"): name what actually changed instead');
  }

  return hits;
}

// ---- Korean rules ----

const KO_RULES: Rule[] = [
  {
    id: 'ko-tonghae-hyangsang',
    re: /(?:을|를)\s*통해[^.!?。]*향상/,
    reason: 'uses "~을/를 통해 … 향상" (improves via X): name the concrete change instead of a vague causal claim',
  },
  { id: 'ko-jeonbanjeog-euro', re: /전반적으로/, reason: 'uses "전반적으로" (overall) as a summary/filler word: name the specific change instead' },
  { id: 'ko-dayanghan', re: /다양한/, reason: 'uses "다양한" (various): name the specific items instead' },
  { id: 'ko-hyoyuljeog-euro', re: /효율적으로/, reason: 'uses "효율적으로" (efficiently) as a vague claim: give the number or mechanism instead' },
  { id: 'ko-wonhwalhan', re: /보다\s*원활(?:한|하게)/, reason: 'uses "보다 원활한/원활하게" (smoother) as a vague claim: name what concretely changed' },
  { id: 'ko-hasipsio', re: /하십시오|바랍니다/, reason: 'uses 하십시오체 ("…하십시오/…바랍니다"): use 합니다/습니다 endings instead' },
  {
    id: 'ko-salpyeobogessseupnida',
    re: /살펴보겠습니다|알아보겠습니다/,
    reason: 'uses a chatty "let\'s look at/find out" opener ("살펴보겠습니다/알아보겠습니다"): state the fact directly',
  },
];

function koTells(text: string): TellHit[] {
  const stripped = stripCodeAndIdentifiers(text.trim());
  const hits: TellHit[] = [];
  for (const r of KO_RULES) if (r.re.test(stripped)) hits.push({ id: r.id, reason: r.reason });
  for (const h of structureTells(stripped, sentences(stripped))) hits.push(h);
  return hits;
}

/**
 * Every AI-tell hit in `text`: one id + reason per distinct rule triggered
 * (not per occurrence). English rules cover openers, recaps, hedges,
 * marketing words and vague value claims; Korean rules cover the equivalent
 * chatty/marketing/formality tells; structural rules (bare "!", markdown
 * bold/italics, em-dash chains, comparative triplets) apply to both.
 * Code spans, function calls, paths and file names are stripped before any
 * pattern runs, so identifiers like `enhanceRetry()` or `docs/various.md`
 * never trigger a hit.
 */
export function aiTellHits(text: string, language: ExplainLanguage): TellHit[] {
  return language === 'ko' ? koTells(text) : enTells(text);
}

/** Short reasons only, in `aiTellHits` order — what `checkProse` feeds back to the model and stores as `styleWarnings`. */
export function aiTells(text: string, language: ExplainLanguage): string[] {
  return aiTellHits(text, language).map((h) => h.reason);
}

/**
 * Report-only metric (DIG-65 step 5): the first three words of `text`,
 * normalised, as a coarse "opener signature" for cross-field repetition
 * checks. Not used by any validator or retry path.
 */
export function openerSignature(text: string): string {
  const words = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 3).join(' ');
}

/**
 * Report-only metric (DIG-65 step 5): how many of `overviews` (area
 * walkthrough overviews within one digest) share their opener signature with
 * at least one other overview. Count only — never wired into a retry.
 */
export function repeatedOpenerCount(overviews: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const o of overviews) {
    const sig = openerSignature(o);
    if (sig !== '') counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  let repeated = 0;
  for (const n of counts.values()) if (n > 1) repeated += n;
  return repeated;
}
