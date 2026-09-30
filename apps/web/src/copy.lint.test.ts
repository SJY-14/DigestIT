// DIG-63 Finding 4 (docs/ux/ai-look-audit.md, corrected per docs/ux/critique-2.md): a regression
// guard for the "already clean" state the audit verified. This imports copy.ts and lints the
// *evaluated* exports (every plain string plus every exported function's return value, called with
// representative arguments for both `en` and `ko`) — never the raw TypeScript source, which
// legitimately contains `!` for negation and regex tests (`!builtLabel`, `!/.../.test(code)`) that
// have nothing to do with tone. Banned-word/phrase lists live at the top so they are easy to
// extend; each rule has a self-test below proving it actually fires, using a fake string.
import { describe, expect, it } from 'vitest';
import {
  apiErrorMessage, callsLeftLabel, contextSummary, digestRowLabel, elapsedLabel, emptyCopy, explainButtonLabel, explainingLabel,
  explainOutcomeMessage, graphCopy, headerCopy, humanDateTime, ignoreCopy, LANGUAGE_NAMES, levelsCopy, lineDelta, navCopy,
  notTrackedReasonLabel, pickerCopy, plural, projectsCopy, readerCopy, resetsLabel, reviewedCopy, setupCopy, trustCopy,
  walkthroughCopy, welcomeBackCopy, type Lang,
} from './copy.js';

// --- banned patterns (edit here to extend the lint) -----------------------------------------------

const MARKETING_WORDS = [
  'seamless', 'effortless', 'powerful', 'robust', 'comprehensive', 'streamlined', 'leverage', 'unlock',
  'supercharge', 'delve', 'elevate', 'magic', 'smart', 'intelligent',
];
const CHIRPY_PHRASES = ['welcome back!', "let's", 'great news', 'awesome', 'oops'];
// Bare progress verbs with no object. Matched against the whole string (minus a trailing ellipsis),
// so copy that names the action — "Writing the walkthrough…", "Explaining… 12s" — passes.
const THINKING_PHRASES = ['thinking', 'analyzing', 'generating', 'working', 'processing', 'hang tight', '생각 중', '분석 중', '처리 중'];
const KO_BANNED_WORDS = ['다양한', '전반적으로', '원활', '효율적으로'];
const KO_HAPSIYO_ENDINGS = ['하십시오', '바랍니다'];

// Exact evaluated strings allowed to mention "AI" — one line each for why.
const AI_MENTION_ALLOWLIST = new Set([
  // Onboarding step: tells the user any tool works, AI agents included — DIG-63 audit reviewed and kept this.
  'Work in it with any tool: an editor, an AI agent, a script.',
  // ko twin of the line above.
  '에디터, AI 에이전트, 스크립트 등 원하는 도구로 작업하세요.',
]);

// Deliberate WCAG 1.4.1 state glyphs (DIG-61) — not decorative emoji, excluded from the emoji check.
const STATE_GLYPHS = /[✓○]/gu;

// Names that are allowed to read as Title Case on their own (product names, not prose).
const PRODUCT_NAMES = new Set(['DigestIT', 'GitHub']);

// --- rule functions ---------------------------------------------------------------------------

function hasBang(text: string): boolean {
  return text.includes('!');
}
function hasEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}/u.test(text.replace(STATE_GLYPHS, ''));
}
function findMarketingWord(text: string): string | null {
  const lower = text.toLowerCase();
  return MARKETING_WORDS.find((w) => new RegExp(`\\b${w}\\b`, 'i').test(lower)) ?? null;
}
function findChirpyPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  return CHIRPY_PHRASES.find((p) => lower.includes(p)) ?? null;
}
function findThinkingPhrase(text: string): string | null {
  const bare = text.trim().replace(/(?:…|\.{3})$/u, '').trim().toLowerCase();
  return THINKING_PHRASES.find((p) => bare === p) ?? null;
}
function hasUnlistedAiMention(text: string): boolean {
  return /\bAI\b/.test(text) && !AI_MENTION_ALLOWLIST.has(text);
}
/** Three or more consecutive "Cap-initial, lowercase-second" words (so ALL-CAPS acronyms like
 * "API"/"L3" and bare numbers never count), excluding known product names. */
function hasTitleCaseRun(text: string): boolean {
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? [];
  let run = 0;
  for (const tok of tokens) {
    const isCapWord = /^[A-Z][a-z]/.test(tok) && !PRODUCT_NAMES.has(tok);
    run = isCapWord ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}
function findKoBannedWord(text: string): string | null {
  return KO_BANNED_WORDS.find((w) => text.includes(w)) ?? null;
}
function findKoHapsiyoEnding(text: string): string | null {
  const trimmed = text.replace(/[.!?…\s]+$/u, '');
  return KO_HAPSIYO_ENDINGS.find((e) => trimmed.endsWith(e)) ?? null;
}

// --- entry collection: every evaluated string out of copy.ts -------------------------------------

interface Entry { source: string; lang: Lang; path: string; text: string }

function addStrings(out: Entry[], source: string, lang: Lang, value: unknown, path = ''): void {
  if (typeof value === 'string') { out.push({ source, lang, path, text: value }); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => addStrings(out, source, lang, v, `${path}[${i}]`)); return; }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) addStrings(out, source, lang, v, path ? `${path}.${k}` : k);
  }
}

/** One sample call per function-valued key of a copy table (required by the type checker too). */
type Calls<T> = { [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: (fn: T[K]) => unknown };

/** Walks a copy table: every plain string (nested objects/arrays included) is collected
 * automatically, and every function-valued key must have an entry in `calls`, so a new function
 * added to a table fails here instead of silently skipping the lint. */
function addTable<T extends object>(out: Entry[], source: string, lang: Lang, table: T, calls: Calls<T>): void {
  for (const [k, v] of Object.entries(table)) {
    if (typeof v !== 'function') { addStrings(out, source, lang, v, k); continue; }
    const call = (calls as Record<string, ((fn: unknown) => unknown) | undefined>)[k];
    if (!call) throw new Error(`${source}.${k} is a function with no sample call in copy.lint.test.ts`);
    addStrings(out, source, lang, call(v), k);
  }
}

const SAMPLE = {
  msg: 'network timeout',
  path: 'src/app.ts',
  pattern: 'dist/',
  title: 'upload retry logic',
  when: '3 hours ago',
  projectName: 'my-project',
  examples: ['dist/', '*.log'],
  headline: 'sample headline',
};
const COUNTS = [0, 1, 2, 12] as const;
const LANGS: readonly Lang[] = ['en', 'ko'];
const API_ERROR_CODES = [
  'bad_root_path', 'root_not_found', 'root_not_allowed', 'bad_context_path', 'context_not_found', 'context_not_allowed',
  'project_roots_not_configured', 'bad_language', 'bad_body', 'not_found', 'explain_running', 'no_provider',
  'explain_failed', 'context_failed', 'unauthorized', 'bad_action', 'bad_patterns',
];
const NOT_TRACKED_REASONS = ['denylist', 'gitignore', 'project-ignore', 'git-exclude', 'too_large', 'nested_repo', 'unreadable'];

function collectAll(): Entry[] {
  const out: Entry[] = [];

  for (const [k, v] of Object.entries(LANGUAGE_NAMES)) addStrings(out, 'LANGUAGE_NAMES', k as Lang, v, k);

  for (const lang of LANGS) {
    for (const n of COUNTS) addStrings(out, 'plural', lang, plural(n, 'file'), `n=${n}`);

    const now = new Date(2026, 8, 28, 18, 0).getTime();
    for (const iso of [
      new Date(2026, 8, 28, 17, 5).toISOString(), // today
      new Date(2026, 8, 27, 9, 12).toISOString(), // yesterday
      new Date(2026, 8, 20, 0, 30).toISOString(), // same year
      new Date(2025, 11, 31, 8, 0).toISOString(), // different year
    ]) addStrings(out, 'humanDateTime', lang, humanDateTime(iso, now, lang), iso);

    addStrings(out, 'lineDelta', lang, lineDelta(7, 3));

    for (const n of COUNTS) addStrings(out, 'explainButtonLabel', lang, explainButtonLabel(n, lang), `n=${n}`);
    for (const s of [0, 12, 65, 600]) {
      addStrings(out, 'elapsedLabel', lang, elapsedLabel(s, lang), `s=${s}`);
      addStrings(out, 'explainingLabel', lang, explainingLabel(s, lang), `s=${s}`);
    }

    const midnight = new Date(2026, 8, 29, 0, 0).toISOString();
    const laterDate = new Date(2026, 8, 30, 9, 0).toISOString();
    addStrings(out, 'resetsLabel', lang, resetsLabel(midnight, now, lang), 'within-day');
    addStrings(out, 'resetsLabel', lang, resetsLabel(laterDate, now, lang), 'future-date');
    for (const n of COUNTS) addStrings(out, 'callsLeftLabel', lang, callsLeftLabel(n, midnight, now, lang), `n=${n}`);

    for (const status of ['none', 'ok', 'pending', 'error', 'truncated'] as const) {
      for (const hasUserContext of [false, true]) {
        addStrings(out, 'contextSummary', lang, contextSummary(status, SAMPLE.when, 12, hasUserContext, lang), `${status}/${hasUserContext}`);
      }
    }
    addStrings(out, 'contextSummary', lang, contextSummary('pending', null, null, false, lang), 'no-built-label');

    for (const outcome of ['error', 'budget', 'no_changes'] as const) {
      addStrings(out, 'explainOutcomeMessage', lang, explainOutcomeMessage(outcome, undefined, SAMPLE.when, lang), `${outcome}/no-detail`);
      addStrings(
        out, 'explainOutcomeMessage', lang,
        explainOutcomeMessage(outcome, apiErrorMessage('no_provider', lang), SAMPLE.when, lang),
        `${outcome}/detail`,
      );
    }

    for (const n of COUNTS) {
      addStrings(out, 'digestRowLabel', lang, digestRowLabel(midnight, n, SAMPLE.headline, now, lang), `files=${n}/headline`);
      addStrings(out, 'digestRowLabel', lang, digestRowLabel(midnight, n, null, now, lang), `files=${n}/no-headline`);
    }

    for (const code of API_ERROR_CODES) addStrings(out, 'apiErrorMessage', lang, apiErrorMessage(code, lang), code);
    addStrings(out, 'apiErrorMessage', lang, apiErrorMessage('some_unmapped_code', lang), 'unmapped');

    for (const reason of NOT_TRACKED_REASONS) addStrings(out, 'notTrackedReasonLabel', lang, notTrackedReasonLabel(reason, lang), reason);

    const n4 = <R>(fn: (n: number) => R) => COUNTS.map(fn);

    addTable(out, 'headerCopy', lang, headerCopy(lang), {
      statusError: (fn) => fn(SAMPLE.msg), languageError: (fn) => fn(SAMPLE.msg), resets: (fn) => fn(SAMPLE.when),
    });
    addTable(out, 'navCopy', lang, navCopy(lang), {});
    addTable(out, 'ignoreCopy', lang, ignoreCopy(lang), {
      remove: (fn) => fn(SAMPLE.pattern), addError: (fn) => fn(SAMPLE.msg), removeError: (fn) => fn(SAMPLE.msg),
      notTrackedExamples: (fn) => fn(SAMPLE.examples), suggestionAdd: (fn) => fn(SAMPLE.pattern),
    });
    addTable(out, 'pickerCopy', lang, pickerCopy(lang), { loadError: (fn) => fn(SAMPLE.msg) });
    addTable(out, 'emptyCopy', lang, emptyCopy(lang), {
      noDigests: (fn) => n4((n) => fn(SAMPLE.projectName, n)),
    });
    const lv = levelsCopy(lang);
    addStrings(out, 'levelsCopy', lang, lv);
    addTable(out, 'readerCopy', lang, readerCopy(lang), {
      digestCrumb: (fn) => fn(SAMPLE.when), digestLoadError: (fn) => fn(SAMPLE.msg), period: (fn) => fn(SAMPLE.when, SAMPLE.when),
      fileCount: (fn) => n4(fn), filteredTo: (fn) => fn(2, 5), filterAnnounce: (fn) => fn(SAMPLE.path),
      nextLevel: (fn) => lv.map((l) => fn(l.key, l.label)),
    });
    addTable(out, 'welcomeBackCopy', lang, welcomeBackCopy(lang), {
      strip: (fn) => n4((n) => fn(n, SAMPLE.when, n * 3)),
    });
    addTable(out, 'reviewedCopy', lang, reviewedCopy(lang), {});
    addTable(out, 'walkthroughCopy', lang, walkthroughCopy(lang), {
      regionLabel: (fn) => fn(SAMPLE.title), loadError: (fn) => fn(SAMPLE.msg), generateCost: (fn) => n4(fn),
      stepLabel: (fn) => n4(fn), stepOf: (fn) => fn(2, 5), missingRange: (fn) => [fn(SAMPLE.path, 3, 3), fn(SAMPLE.path, 12, 14)],
      showAll: (fn) => n4(fn), rangeLabel: (fn) => [fn(12, 14), fn(41, 41)], goToStep: (fn) => n4(fn),
    });
    addTable(out, 'graphCopy', lang, graphCopy(lang), {
      loadError: (fn) => fn(SAMPLE.msg), nodeFiles: (fn) => n4(fn), summary: (fn) => [fn(5, 0), fn(5, 2)],
      openHint: (fn) => [0, 1, 2].map(fn),
    });
    addTable(out, 'setupCopy', lang, setupCopy(lang), { projectsLoadError: (fn) => fn(SAMPLE.msg) });
    addTable(out, 'trustCopy', lang, trustCopy(lang), { providerOther: (fn) => fn('acme-provider') });
    addTable(out, 'projectsCopy', lang, projectsCopy(lang), {
      lastActivity: (fn) => fn(SAMPLE.when), unreadCount: (fn) => n4(fn), removeTitle: (fn) => fn(SAMPLE.projectName),
      removeError: (fn) => fn(SAMPLE.msg), allProjectsHeading: (fn) => [fn(3, 0), fn(3, 1), fn(3, 2)],
    });
  }

  return out;
}

// --- the lint itself ---------------------------------------------------------------------------

interface Violation { rule: string; detail?: string; source: string; lang: Lang; path: string; text: string }

function lintEntries(entries: Entry[]): Violation[] {
  const violations: Violation[] = [];
  for (const e of entries) {
    if (hasBang(e.text)) violations.push({ rule: 'exclamation-mark', ...e });
    if (hasEmoji(e.text)) violations.push({ rule: 'emoji', ...e });
    const marketing = findMarketingWord(e.text);
    if (marketing) violations.push({ rule: 'marketing-word', detail: marketing, ...e });
    const chirpy = findChirpyPhrase(e.text);
    if (chirpy) violations.push({ rule: 'chirpy-phrase', detail: chirpy, ...e });
    const thinking = findThinkingPhrase(e.text);
    if (thinking) violations.push({ rule: 'thinking-progress', detail: thinking, ...e });
    if (hasUnlistedAiMention(e.text)) violations.push({ rule: 'ai-mention', ...e });
    if (hasTitleCaseRun(e.text)) violations.push({ rule: 'title-case', ...e });
    if (e.lang === 'ko') {
      const koBanned = findKoBannedWord(e.text);
      if (koBanned) violations.push({ rule: 'ko-banned-word', detail: koBanned, ...e });
      const koEnding = findKoHapsiyoEnding(e.text);
      if (koEnding) violations.push({ rule: 'ko-hapsiyo-ending', detail: koEnding, ...e });
    }
  }
  return violations;
}

describe('copy.ts lint (DIG-63 regression guard)', () => {
  it('every evaluated en/ko string is free of banned patterns', () => {
    const entries = collectAll();
    // Sanity floor: if the walk ever collects nothing (an import/collection bug), the lint below
    // would trivially pass "green" without checking anything — catch that before it does.
    expect(entries.length).toBeGreaterThan(200);
    const violations = lintEntries(entries);
    if (violations.length > 0) {
      const report = violations
        .map((v) => `[${v.rule}] ${v.source}.${v.path} (${v.lang}): "${v.text}"${v.detail ? ` — matched "${v.detail}"` : ''}`)
        .join('\n');
      throw new Error(`copy.ts lint failed:\n${report}`);
    }
  });
});

describe('lint rules actually bite (self-test, run against fake strings)', () => {
  const fake = (text: string, lang: Lang = 'en'): Entry => ({ source: 'fake', lang, path: 'x', text });
  const rules = (text: string, lang: Lang = 'en') => lintEntries([fake(text, lang)]).map((v) => v.rule);

  it('flags an exclamation mark', () => {
    expect(rules('Welcome to the project!')).toContain('exclamation-mark');
  });

  it('flags emoji, but not the ✓/○ state glyphs', () => {
    expect(rules('Done 🎉')).toContain('emoji');
    expect(rules('Reviewed ✓')).not.toContain('emoji');
  });

  it('flags a marketing word', () => {
    expect(rules('A seamless workflow')).toContain('marketing-word');
  });

  it('flags a chirpy phrase', () => {
    expect(rules('Welcome back, great news')).toContain('chirpy-phrase');
  });

  it('flags a bare thinking verb, in en and ko, but not progress copy that names the action', () => {
    expect(rules('Thinking…')).toContain('thinking-progress');
    expect(rules('Hang tight')).toContain('thinking-progress');
    expect(rules('생각 중…', 'ko')).toContain('thinking-progress');
    for (const ok of ['Writing the walkthrough…', 'Explaining… 12s', 'Keep working', 'Generating the graph…']) {
      expect(rules(ok)).not.toContain('thinking-progress');
    }
    expect(rules('설명을 작성하는 중…', 'ko')).not.toContain('thinking-progress');
  });

  it('refuses a copy table whose function has no sample call', () => {
    const table = { plain: 'Fine', later: (n: number) => `${n} files` };
    expect(() => addTable([], 'fake', 'en', table, {} as never)).toThrow(/fake\.later/);
  });

  it('flags an unlisted "AI" mention, but not the allowlisted onboarding line', () => {
    expect(rules('Powered by AI')).toContain('ai-mention');
    expect(rules('Work in it with any tool: an editor, an AI agent, a script.')).not.toContain('ai-mention');
  });

  it('flags three-or-more-word Title Case, but not short incidental capitals', () => {
    expect(rules('This Is Totally Title Case')).toContain('title-case');
    expect(rules('Explain 12 changes')).not.toContain('title-case');
  });

  it('flags a banned Korean word', () => {
    expect(rules('다양한 기능을 제공합니다', 'ko')).toContain('ko-banned-word');
  });

  it('flags a 하십시오체 ending, but not the plain -세요 style already in use', () => {
    expect(rules('다시 시도하십시오.', 'ko')).toContain('ko-hapsiyo-ending');
    expect(rules('다시 시도해주세요.', 'ko')).not.toContain('ko-hapsiyo-ending');
  });
});
