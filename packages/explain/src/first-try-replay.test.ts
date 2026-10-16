// DIG-125 item 5: first-try pass of the walkthrough and summary parts, replayed from hand-built
// samples at the rule frequencies memory A/B rounds 2-3 logged (real provider, `explain_call`
// findings that caused a retry, memory on / off; `.cache/DIG-11{4,8}-acceptance-real/metrics.json`).
// The raw replies of those rounds were not kept, so this is a partial replay:
// - each round-2/3 rule message becomes one reply that reproduces it (test/walkthrough-samples.ts,
//   checked by area.repair.test.ts), the rest of the 30 first attempts per arm (10 snapback digests
//   in round 2 en, round 3 en and round 3 ko) are clean. Spreading the messages one per reply is the
//   pessimistic "before": real replies often carried two or three of them.
// - which way an ambiguous message went is not known, so the walkthrough is replayed twice: "best"
//   (a missing callout came from a callout dropped for being outside its range, a cross-step overlap
//   was partial) and "worst" (both genuine, so not repairable).
// - the summary replay can only show the deterministic check. The stronger l0 prompt is what should
//   lower the identifier rate, and only a real run can measure that (DIG-122 round 4).
//
// DIG-126: round 4 (DIG-122) left one residual rule, callout-vs-callout overlap, as the main cause
// of a retry in both arms; its raw replies were not kept either, so the `round4` mix below is the
// same kind of guess as `best`/`worst` above, one reply per overlap shape (test/walkthrough-
// samples.ts), spread over the ~17 occurrences the real metrics logged.
// Run `pnpm --filter @digestit/explain exec vitest run src/first-try-replay.test.ts` to print the report.
import { describe, expect, it } from 'vitest';
import type { ExplainLanguage } from '@digestit/core';
import { SAMPLES, SAMPLE_FILES, validSample } from '../test/walkthrough-samples.js';
import { checkAreaWalkthrough } from './area.js';
import { checkSummaryLevels } from './digest.js';
import { FILE_REF } from './validate.js';

type Arm = 'on' | 'off';
const PER_ARM = 30;
// One language per first attempt, in round order: round 2 en (10), round 3 en (10), round 3 ko (10).
const languageOf = (i: number): ExplainLanguage => (i < 20 ? 'en' : 'ko');

/** Walkthrough replies with a defect, per arm and scenario, matching the round 2-3 rule counts. */
const WALKTHROUGH_MIX: Record<'best' | 'worst' | 'round4', Record<Arm, [string, number][]>> = {
  best: {
    on: [['callout-outside-only', 2], ['callout-outside-sibling', 7], ['same-step-overlap', 3], ['same-step-duplicate', 3], ['cross-step-overlap', 1]],
    off: [['callout-outside-sibling', 5], ['same-step-overlap', 2], ['same-step-duplicate', 2], ['cross-step-overlap', 1]],
  },
  worst: {
    on: [['needs-callout', 2], ['callout-outside-sibling', 9], ['same-step-overlap', 3], ['same-step-duplicate', 3], ['cross-step-same-lines', 1]],
    off: [['callout-outside-sibling', 5], ['same-step-overlap', 2], ['same-step-duplicate', 2], ['cross-step-same-lines', 1]],
  },
  // DIG-126: round 4's single residual rule, callout-vs-callout overlap, spread over its three
  // repairable shapes plus the one that stays a violation, 17 total (`.cache/DIG-121-acceptance-
  // real/metrics.json`: en 5/5, ko 3/4 digests hit it). The raw replies were not kept, so the mix
  // of shapes is a guess, not a measurement (as for round 2-3's `best`/`worst` above).
  round4: {
    on: [['callout-overlap-duplicate', 3], ['callout-overlap-partial', 3], ['callout-overlap-covered', 3], ['callout-overlap-same-line', 1]],
    off: [['callout-overlap-duplicate', 2], ['callout-overlap-partial', 2], ['callout-overlap-covered', 2], ['callout-overlap-same-line', 1]],
  },
};

/**
 * Round 2-3 summary l0s that named code (8 on / 6 off), rebuilt by hand. Those were caught by the
 * a10-era check, so every sample here is one `FILE_REF` already catches (backticks, a file name).
 * What the stricter check adds was measured on real data instead: 0 of the 60 l0s rounds 2-3
 * accepted would now be flagged (no camelCase, snake_case, quoted name or call among them).
 */
const L0_WITH_CODE: Record<ExplainLanguage, string[]> = {
  en: [
    'The `withRetry` helper now backs off between attempts, so flaky calls recover.',
    '`retryRequest` now stops on client errors, so callers stop wasting retries on bad input.',
    'Retries now throw an `HttpError` with the status, so callers can tell failures apart.',
    'A new errors.js module gives failed requests one error type, so callers can tell failures apart.',
  ],
  ko: [
    '`withRetry`가 이제 시도 사이에 기다려, 일시적 장애에서 호출이 스스로 회복합니다.',
    '`retryRequest`가 4xx 응답에서는 바로 멈춰, 쓸모없는 재시도를 줄입니다.',
  ],
};
const L0_COUNT: Record<Arm, number> = { on: 8, off: 6 };
const CLEAN_L0: Record<ExplainLanguage, string> = {
  en: 'Failed requests now retry with a growing delay, so brief network errors no longer break a call.',
  ko: '실패한 요청이 점점 긴 간격을 두고 다시 시도되어, 짧은 네트워크 오류로 호출이 깨지지 않습니다.',
};
const L1 = { userVisible: false, bullets: ['Requests retry with backoff.'] };

/** Passes on the first try: no hard violation and no style warning left (the `clean` test in `explainArea`). */
function walkthroughPasses(reply: unknown, language: ExplainLanguage, repair: boolean): boolean {
  const r = checkAreaWalkthrough(reply, SAMPLE_FILES, language, undefined, { repair })!;
  return r.violations.length === 0 && r.styleWarnings.length === 0;
}

function walkthroughRate(arm: Arm, scenario: 'best' | 'worst' | 'round4', repair: boolean): number {
  const defects = WALKTHROUGH_MIX[scenario][arm].flatMap(([id, n]) => Array.from({ length: n }, () => SAMPLES.find((s) => s.id === id)!));
  let pass = 0;
  for (let i = 0; i < PER_ARM; i++) {
    const language = languageOf(i);
    const reply = i < defects.length ? defects[i]!.build(language) : validSample(language);
    if (walkthroughPasses(reply, language, repair)) pass++;
  }
  return pass / PER_ARM;
}

/** Summary first try: "before" is the a10-era check (`FILE_REF` only), "after" is `checkSummaryLevels` today. */
function summaryRate(arm: Arm, after: boolean): number {
  let pass = 0;
  for (let i = 0; i < PER_ARM; i++) {
    const language = languageOf(i);
    const pool = L0_WITH_CODE[language];
    const text = i % 3 === 0 && Math.floor(i / 3) < L0_COUNT[arm] ? pool[Math.floor(i / 3) % pool.length]! : CLEAN_L0[language];
    const r = checkSummaryLevels({ l0: { text }, l1: L1 }, language)!;
    const ok = after ? r.violations.length === 0 : r.violations.filter((v) => !v.startsWith('l0: mentions')).length === 0 && !FILE_REF.test(text);
    if (ok && r.styleWarnings.length === 0) pass++;
  }
  return pass / PER_ARM;
}

const pct = (x: number): string => x.toFixed(2);

describe('first-try replay (DIG-125)', () => {
  const rows = (['on', 'off'] as const).map((arm) => ({
    arm,
    wBefore: walkthroughRate(arm, 'worst', false),
    wBestBefore: walkthroughRate(arm, 'best', false),
    wBest: walkthroughRate(arm, 'best', true),
    wWorst: walkthroughRate(arm, 'worst', true),
    // DIG-126: round 4's residual, callout-vs-callout overlap, before and after this issue's repair.
    r4Before: walkthroughRate(arm, 'round4', false),
    r4After: walkthroughRate(arm, 'round4', true),
    sBefore: summaryRate(arm, false),
    sAfter: summaryRate(arm, true),
  }));

  it('prints the report', () => {
    const lines = [
      `| memory | walkthrough before (worst / best mix) | walkthrough after, best | walkthrough after, worst | round 4 before | round 4 after | summary before | summary after (check only) |`,
      `|---|---|---|---|---|---|---|---|`,
      ...rows.map((r) =>
        `| ${r.arm} | ${pct(r.wBefore)} / ${pct(r.wBestBefore)} | ${pct(r.wBest)} | ${pct(r.wWorst)} | ${pct(r.r4Before)} | ${pct(r.r4After)} | ${pct(r.sBefore)} | ${pct(r.sAfter)} |`),
    ];
    console.log(`first-try pass, ${PER_ARM} first attempts per arm:\n${lines.join('\n')}`);
  });

  it('repair lifts the walkthrough to the 0.95 target when the ambiguous findings were anchoring slips', () => {
    for (const r of rows) {
      expect(r.wBest).toBeGreaterThanOrEqual(0.95);
      expect(r.wBest).toBeGreaterThan(r.wBestBefore);
      // A genuinely missing callout or a step claiming another step's lines still costs a retry.
      expect(r.wWorst).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('the summary replay is unchanged by the deterministic check: only the prompt can move it', () => {
    for (const r of rows) expect(r.sAfter).toBe(r.sBefore);
  });

  it('callout-overlap repair lifts round 4\'s residual close to the 0.95 target (DIG-126)', () => {
    for (const r of rows) {
      expect(r.r4After).toBeGreaterThanOrEqual(0.9);
      expect(r.r4After).toBeGreaterThan(r.r4Before);
      // The same single line with two different notes is not trivial: it still costs a retry.
      expect(r.r4After).toBeLessThan(1);
    }
  });
});
