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
  notTrackedReasonLabel, pickerCopy, plural, readerCopy, resetsLabel, reviewedCopy, setupCopy, walkthroughCopy, welcomeBackCopy,
  type Lang,
} from './copy.js';

// --- banned patterns (edit here to extend the lint) -----------------------------------------------

const MARKETING_WORDS = [
  'seamless', 'effortless', 'powerful', 'robust', 'comprehensive', 'streamlined', 'leverage', 'unlock',
  'supercharge', 'delve', 'elevate', 'magic', 'smart', 'intelligent',
];
const CHIRPY_PHRASES = ['welcome back!', "let's", 'great news', 'awesome', 'oops'];
const THINKING_PHRASES = ['thinking…', 'analyzing…', 'generating…', 'working…', 'hang tight', '생각 중', '분석 중'];
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
  const lower = text.toLowerCase();
  return THINKING_PHRASES.find((p) => lower.includes(p.toLowerCase())) ?? null;
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

    const h = headerCopy(lang);
    addStrings(out, 'headerCopy', lang, {
      projectLabel: h.projectLabel, loadingStatus: h.loadingStatus, statusError: h.statusError(SAMPLE.msg),
      infoLabel: h.infoLabel, refreshContext: h.refreshContext, refreshingContext: h.refreshingContext,
      languageLabel: h.languageLabel, languageHint: h.languageHint, languageError: h.languageError(SAMPLE.msg),
      nothingPendingHint: h.nothingPendingHint, noCallsHint: h.noCallsHint, resets: h.resets(SAMPLE.when),
    });

    addStrings(out, 'navCopy', lang, navCopy(lang));

    const ig = ignoreCopy(lang);
    addStrings(out, 'ignoreCopy', lang, {
      heading: ig.heading, hint: ig.hint, placeholder: ig.placeholder, add: ig.add, adding: ig.adding, empty: ig.empty,
      remove: ig.remove(SAMPLE.pattern), addError: ig.addError(SAMPLE.msg), removeError: ig.removeError(SAMPLE.msg),
      notTrackedHeading: ig.notTrackedHeading, notTrackedEmpty: ig.notTrackedEmpty,
      notTrackedExamples: ig.notTrackedExamples(SAMPLE.examples),
      suggestionsHeading: ig.suggestionsHeading, suggestionsHint: ig.suggestionsHint,
      suggestionAdd: ig.suggestionAdd(SAMPLE.pattern), suggestionAdded: ig.suggestionAdded, continueLabel: ig.continueLabel,
    });

    const pk = pickerCopy(lang);
    addStrings(out, 'pickerCopy', lang, {
      label: pk.label, choose: pk.choose, listLabel: pk.listLabel, loading: pk.loading, loadError: pk.loadError(SAMPLE.msg),
      startOfHistory: pk.startOfHistory, retry: pk.retry, retrying: pk.retrying, retryNoBudget: pk.retryNoBudget, status: pk.status,
    });

    const em = emptyCopy(lang);
    addStrings(out, 'emptyCopy', lang, { noProjectsHeading: em.noProjects.heading, noProjectsSteps: em.noProjects.steps, digestNoChanges: em.digestNoChanges });
    for (const n of COUNTS) {
      const nd = em.noDigests(SAMPLE.projectName, n);
      addStrings(out, 'emptyCopy', lang, { heading: nd.heading, body: nd.body }, `noDigests(${n})`);
    }

    const lv = levelsCopy(lang);
    addStrings(out, 'levelsCopy', lang, lv);

    const rd = readerCopy(lang);
    addStrings(out, 'readerCopy', lang, {
      switcherLabel: rd.switcherLabel, switcherHint: rd.switcherHint, breadcrumbLabel: rd.breadcrumbLabel,
      digestCrumb: rd.digestCrumb(SAMPLE.when), loadingDigest: rd.loadingDigest, digestLoadError: rd.digestLoadError(SAMPLE.msg),
      digestPending: rd.digestPending, digestError: rd.digestError, digestTruncated: rd.digestTruncated,
      retry: rd.retry, retrying: rd.retrying, retryNoBudget: rd.retryNoBudget,
      noHeadline: rd.noHeadline, period: rd.period(SAMPLE.when, SAMPLE.when),
      fileCount0: rd.fileCount(0), fileCount1: rd.fileCount(1), fileCount2: rd.fileCount(2), fileCount12: rd.fileCount(12),
      noImpact: rd.noImpact, internalOnly: rd.internalOnly,
      noAreas: rd.noAreas, areaHow: rd.areaHow, areaWhy: rd.areaWhy, openArea: rd.openArea,
      filteredTo: rd.filteredTo(2, 5), noAreaForNode: rd.noAreaForNode, clearFilter: rd.clearFilter,
      filterAnnounce: rd.filterAnnounce(SAMPLE.path), filterCleared: rd.filterCleared, notAnalysed: rd.notAnalysed,
      pickArea: rd.pickArea, nextLevel: rd.nextLevel(lv[1].key, lv[1].label),
      areasGlanceHeading: rd.areasGlanceHeading, openAreaCard: rd.openAreaCard,
    });

    const wb = welcomeBackCopy(lang);
    for (const n of COUNTS) addStrings(out, 'welcomeBackCopy', lang, wb.strip(n, SAMPLE.when, n * 3), `strip(${n})`);
    addStrings(out, 'welcomeBackCopy', lang, wb.openDigestList, 'openDigestList');

    addStrings(out, 'reviewedCopy', lang, reviewedCopy(lang));

    const wt = walkthroughCopy(lang);
    addStrings(out, 'walkthroughCopy', lang, {
      regionLabel: wt.regionLabel(SAMPLE.title), loading: wt.loading, loadError: wt.loadError(SAMPLE.msg),
      generate: wt.generate,
      generateCost0: wt.generateCost(0), generateCost1: wt.generateCost(1), generateCost2: wt.generateCost(2), generateCost12: wt.generateCost(12),
      noBudget: wt.noBudget, notGenerated: wt.notGenerated, generating: wt.generating, generateError: wt.generateError,
      retry: wt.retry, truncated: wt.truncated, overview: wt.overview,
      stepLabel0: wt.stepLabel(0), stepLabel1: wt.stepLabel(1), stepLabel2: wt.stepLabel(2), stepLabel12: wt.stepLabel(12),
      stepOf: wt.stepOf(2, 5), mechanical: wt.mechanical, stepsNav: wt.stepsNav, previous: wt.previous, next: wt.next,
      stepKeysHint: wt.stepKeysHint, check: wt.check, uncovered: wt.uncovered, uncoveredNote: wt.uncoveredNote,
      fullDiff: wt.fullDiff, missingHunk: wt.missingHunk(SAMPLE.path, 3),
      showAll0: wt.showAll(0), showAll1: wt.showAll(1), showAll2: wt.showAll(2), showAll12: wt.showAll(12),
      showLess: wt.showLess, noTextChange: wt.noTextChange, notAnalysed: wt.notAnalysed,
    });

    const gp = graphCopy(lang);
    addStrings(out, 'graphCopy', lang, {
      label: gp.label, legendChanged: gp.legendChanged, legendSelected: gp.legendSelected, fitChanges: gp.fitChanges,
      fitAll: gp.fitAll, zoomIn: gp.zoomIn, zoomOut: gp.zoomOut, loading: gp.loading, loadError: gp.loadError(SAMPLE.msg),
      folded: gp.folded, keysHint: gp.keysHint, show: gp.show, hide: gp.hide,
      nodeFiles0: gp.nodeFiles(0), nodeFiles1: gp.nodeFiles(1), nodeFiles2: gp.nodeFiles(2), nodeFiles12: gp.nodeFiles(12),
      summaryNone: gp.summaryNone, summaryNoFolders: gp.summary(5, 0), summaryWithFolders: gp.summary(5, 2),
      openHint0: gp.openHint(0), openHint1: gp.openHint(1), openHint2: gp.openHint(2), expandHint: gp.expandHint,
    });

    const su = setupCopy(lang);
    addStrings(out, 'setupCopy', lang, {
      projectFolderLabel: su.projectFolderLabel, projectFolderPlaceholder: su.projectFolderPlaceholder,
      contextFileLabel: su.contextFileLabel, contextFilePlaceholder: su.contextFilePlaceholder,
      starting: su.starting, start: su.start, projectsLoadError: su.projectsLoadError(SAMPLE.msg),
      noApiHintBefore: su.noApiHint.before, noApiHintHistoryWord: su.noApiHint.historyWord, noApiHintAfter: su.noApiHint.after,
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

  it('flags thinking-style progress copy, in en and ko', () => {
    expect(rules('Thinking…')).toContain('thinking-progress');
    expect(rules('생각 중…', 'ko')).toContain('thinking-progress');
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
