// DIG-125: hand-built walkthrough replies over snapback's "retry work part 2" checkpoint
// (packages/ingest/test/fixtures/memory-ab-story.mjs), one per validator rule that caused a retry
// in memory A/B rounds 2-3 (`.cache/DIG-11{4,8}-acceptance-real/metrics.json`). The raw replies of
// those rounds were not kept, so each sample is written to reproduce its rule message, in the line-ID
// shape of area prompt a11. Shared by area.repair.test.ts and first-try-replay.test.ts.
// DIG-126: round 4's raw replies were not kept either (`.cache/DIG-121-acceptance-real/metrics.json`
// had no `raw-replies/`), so its one residual rule, callout-vs-callout overlap, is reproduced the
// same way: one sample per overlap shape (exact duplicate, partial, one fully covering the other,
// and the non-trivial same-single-line-different-note case), in the `line`/`from`/`to` callout shape.
import type { ExplainLanguage } from '@digestit/core';
import type { AreaReply, ProviderFile, ReplyStep } from '../src/provider.js';

/** `git diff` of src/retry.js, part 1 -> part 2. Line IDs on the right. */
export const RETRY_PATCH = [
  'diff --git a/src/retry.js b/src/retry.js',
  '--- a/src/retry.js',
  '+++ b/src/retry.js',
  '@@ -1,9 +1,12 @@',
  '-export async function withRetry(fn, times = 3) {', //                         1.1
  "+import { HttpError } from './errors.js';", //                                  1.2  new 1
  '+', //                                                                          1.3  new 2
  '+export async function withRetry(fn, times = 3, baseMs = 100) {', //           1.4  new 3
  '   for (let i = 0; i < times; i++) {', //                                     1.5  new 4
  '     try {', //                                                               1.6  new 5
  '       return await fn();', //                                                1.7  new 6
  '     } catch (e) {', //                                                       1.8  new 7
  '-      if (i === times - 1) throw e;', //                                     1.9
  '+      if (i === times - 1) throw e instanceof HttpError ? e : new HttpError(0, e.message);', // 1.10 new 8
  '+      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));', //         1.11 new 9
  '     }', //                                                                   1.12 new 10
  '   }', //                                                                     1.13 new 11
  ' }', //                                                                       1.14 new 12
  '',
].join('\n');

/** src/errors.js, new in part 2. */
export const ERRORS_PATCH = [
  'diff --git a/src/errors.js b/src/errors.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/errors.js',
  '@@ -0,0 +1,6 @@',
  '+export class HttpError extends Error {',
  '+  constructor(status, message) {',
  '+    super(message);',
  '+    this.status = status;',
  '+  }',
  '+}',
  '',
].join('\n');

export const SAMPLE_FILES: ProviderFile[] = [
  { path: 'src/errors.js', status: 'A', additions: 6, deletions: 0, patch: ERRORS_PATCH, filteredReason: null },
  { path: 'src/retry.js', status: 'M', additions: 5, deletions: 2, patch: RETRY_PATCH, filteredReason: null },
];

const R = 'src/retry.js';
const E = 'src/errors.js';

const TEXT = {
  en: {
    overview: '`withRetry` now waits between attempts and always throws an `HttpError` when it gives up. A new `errors.js` module defines that error with an HTTP status.',
    s1: {
      title: 'Back off between attempts',
      body: '`withRetry` now sleeps `baseMs * 2 ** i` milliseconds after each failed attempt. Before, it retried at once. The last failure is wrapped in an `HttpError`, so callers see one error type.',
      wrap: 'wraps the last error in `HttpError`',
      wait: 'doubles the wait on each attempt',
    },
    s2: {
      title: 'HttpError carries the status',
      body: '`HttpError` extends `Error` and keeps the HTTP status next to the message. Callers can branch on `status` instead of parsing the text.',
      status: 'keeps the HTTP status',
    },
    s3: {
      title: 'Signature gains baseMs',
      body: '`withRetry` takes a third `baseMs` argument that defaults to 100. The module imports `HttpError` for the wrapping in the first step.',
      param: 'new `baseMs` argument, default 100',
    },
    check: ['No test covers the backoff timing or the `HttpError` wrapping.', 'A 4xx response is still retried; confirm that is intended.'],
  },
  ko: {
    overview: '`withRetry`는 이제 시도 사이에 기다리고, 포기할 때는 항상 `HttpError`를 던집니다. 새 `errors.js` 모듈이 HTTP 상태를 담는 이 오류를 정의합니다.',
    s1: {
      title: '시도 사이 대기 추가',
      body: '`withRetry`는 실패한 시도마다 `baseMs * 2 ** i` 밀리초를 기다립니다. 이전에는 곧바로 다시 시도했습니다. 마지막 실패는 `HttpError`로 감싸서 호출자가 오류 타입 하나만 다룹니다.',
      wrap: '마지막 오류를 HttpError로 감쌈',
      wait: '대기 시간을 매번 두 배로',
    },
    s2: {
      title: '상태를 담는 HttpError',
      body: '`HttpError`는 `Error`를 확장하고 메시지와 함께 HTTP 상태를 보관합니다. 호출자는 문구를 해석하지 않고 `status`로 분기할 수 있습니다.',
      status: 'HTTP 상태 보관',
    },
    s3: {
      title: 'baseMs 인자 추가',
      body: '`withRetry`가 기본값이 100인 세 번째 인자 `baseMs`를 받습니다. 첫 단계의 감싸기를 위해 모듈이 `HttpError`를 import합니다.',
      param: '기본값 100인 새 baseMs 인자',
    },
    check: ['백오프 시간과 `HttpError` 감싸기를 확인하는 테스트가 없습니다.', '4xx 응답도 여전히 재시도하니 의도한 동작인지 확인하세요.'],
  },
} as const;

/** A valid reply: step 1 = retry.js 1.8-1.11, step 2 = errors.js 1.1-1.6, step 3 = retry.js 1.1-1.4. */
export function validSample(language: ExplainLanguage): AreaReply {
  const t = TEXT[language];
  return {
    overview: t.overview,
    steps: [
      {
        title: t.s1.title, body: t.s1.body, mechanical: false,
        ranges: [{ path: R, from: '1.8', to: '1.11' }],
        callouts: [{ path: R, line: '1.10', note: t.s1.wrap }, { path: R, line: '1.11', note: t.s1.wait }],
      },
      {
        title: t.s2.title, body: t.s2.body, mechanical: false,
        ranges: [{ path: E, from: '1.1', to: '1.6' }],
        callouts: [{ path: E, line: '1.4', note: t.s2.status }],
      },
      {
        title: t.s3.title, body: t.s3.body, mechanical: false,
        ranges: [{ path: R, from: '1.1', to: '1.4' }],
        callouts: [{ path: R, line: '1.4', note: t.s3.param }],
      },
    ],
    check: [...t.check],
  };
}

export interface Sample {
  id: string;
  /** The round 2-3 rule message(s) this reply reproduces under the a10 validator (no repair). */
  rules: string[];
  /** `repaired`: fixed without a call (DIG-125); `retry`: a hard violation is left, so a second call is made. */
  outcome: 'repaired' | 'retry';
  build(language: ExplainLanguage): AreaReply;
}

function edit(language: ExplainLanguage, i: number, change: (s: ReplyStep, t: (typeof TEXT)[ExplainLanguage]) => Partial<ReplyStep>): AreaReply {
  const reply = validSample(language);
  reply.steps[i] = { ...reply.steps[i]!, ...change(reply.steps[i]!, TEXT[language]) };
  return reply;
}

export const SAMPLES: Sample[] = [
  {
    id: 'callout-outside-only',
    rules: ["step N: callout N (…) is not inside one of step N's own ranges", 'step N: needs at least one callout'],
    outcome: 'repaired',
    // Step 3's only callout sits two lines below its range (1.1-1.4), in the same hunk.
    build: (l) => edit(l, 2, (_s, t) => ({ callouts: [{ path: R, line: '1.6', note: t.s3.param }] })),
  },
  {
    id: 'callout-outside-sibling',
    rules: ["step N: callout N (…) is not inside one of step N's own ranges"],
    outcome: 'repaired',
    // Step 1's second callout points at the closing brace after its range (1.8-1.11).
    build: (l) => edit(l, 0, (_s, t) => ({ callouts: [{ path: R, line: '1.10', note: t.s1.wrap }, { path: R, line: '1.13', note: t.s1.wait }] })),
  },
  {
    id: 'callout-overhang',
    rules: ["step N: callout N (…) is not inside one of step N's own ranges", 'step N: needs at least one callout'],
    outcome: 'repaired',
    // Step 1's only callout runs one line past the end of its range.
    build: (l) => edit(l, 0, (_s, t) => ({ callouts: [{ path: R, from: '1.10', to: '1.12', note: t.s1.wrap }] })),
  },
  {
    id: 'same-step-overlap',
    // Without the merge, range 2 is dropped and the callout on 1.11 loses its range too.
    rules: ['step N: range N (…) overlaps another range in the same step', "step N: callout N (…) is not inside one of step N's own ranges"],
    outcome: 'repaired',
    build: (l) => edit(l, 0, () => ({ ranges: [{ path: R, from: '1.8', to: '1.10' }, { path: R, from: '1.9', to: '1.11' }] })),
  },
  {
    id: 'same-step-duplicate',
    rules: ['step N: range N (…) overlaps another range in the same step'],
    outcome: 'repaired',
    build: (l) => edit(l, 0, () => ({ ranges: [{ path: R, from: '1.8', to: '1.11' }, { path: R, from: '1.8', to: '1.11' }] })),
  },
  {
    id: 'cross-step-overlap',
    rules: ["step N: range N (…) overlaps step N's range (…)", 'step N: references no valid range'],
    outcome: 'repaired',
    // Step 3's only range runs into step 1's first line (1.8).
    build: (l) => edit(l, 2, () => ({ ranges: [{ path: R, from: '1.1', to: '1.8' }] })),
  },
  {
    id: 'cross-step-same-lines',
    rules: ["step N: range N (…) overlaps step N's range (…)", 'step N: references no valid range'],
    outcome: 'retry',
    // Step 3 claims exactly step 1's lines: trimming would leave nothing.
    build: (l) => edit(l, 2, (_s, t) => ({ ranges: [{ path: R, from: '1.8', to: '1.11' }], callouts: [{ path: R, line: '1.10', note: t.s3.param }] })),
  },
  {
    id: 'cross-step-orphan',
    rules: ["step N: range N (…) overlaps step N's range (…)", 'step N: references no valid range'],
    outcome: 'retry',
    // Trimming step 3's range back to 1.1-1.7 would leave its callout (1.9) with no range.
    build: (l) => edit(l, 2, (_s, t) => ({ ranges: [{ path: R, from: '1.1', to: '1.9' }], callouts: [{ path: R, line: '1.9', note: t.s3.param }] })),
  },
  {
    id: 'needs-callout',
    rules: ['step N: needs at least one callout'],
    outcome: 'retry',
    build: (l) => edit(l, 1, () => ({ callouts: [] })),
  },
  {
    id: 'callout-other-file',
    rules: ["step N: callout N (…) is not inside one of step N's own ranges"],
    outcome: 'retry',
    // A callout on a file the step has no range in: moving it would change what it points at.
    build: (l) => edit(l, 2, (s, t) => ({ callouts: [...s.callouts, { path: E, line: '1.2', note: t.s2.status }] })),
  },
  // DIG-126: round 4's single residual rule, "callout N overlaps another callout in step N"
  // (`.cache/DIG-121-acceptance-real/metrics.json`), one sample per overlap shape.
  {
    id: 'callout-overlap-duplicate',
    rules: ['step N: callout N (…) overlaps another callout in step N'],
    outcome: 'repaired',
    // Step 1's two callouts name the same line with the same note.
    build: (l) => edit(l, 0, (_s, t) => ({ callouts: [{ path: R, line: '1.10', note: t.s1.wrap }, { path: R, line: '1.10', note: t.s1.wrap }] })),
  },
  {
    id: 'callout-overlap-partial',
    rules: ['step N: callout N (…) overlaps another callout in step N'],
    outcome: 'repaired',
    // Step 1's second callout's lines run into the first's; its own 1.11 is free.
    build: (l) => edit(l, 0, (_s, t) => ({ callouts: [{ path: R, from: '1.9', to: '1.10', note: t.s1.wrap }, { path: R, from: '1.10', to: '1.11', note: t.s1.wait }] })),
  },
  {
    id: 'callout-overlap-covered',
    rules: ['step N: callout N (…) overlaps another callout in step N'],
    outcome: 'repaired',
    // Step 1's first callout's lines fully cover the second's trailing line.
    build: (l) => edit(l, 0, (_s, t) => ({ callouts: [{ path: R, from: '1.9', to: '1.11', note: t.s1.wrap }, { path: R, line: '1.11', note: t.s1.wait }] })),
  },
  {
    id: 'callout-overlap-same-line',
    rules: ['step N: callout N (…) overlaps another callout in step N'],
    outcome: 'retry',
    // Step 1's two callouts both name 1.10, with different notes: not a trivial duplicate.
    build: (l) => edit(l, 0, (_s, t) => ({ callouts: [{ path: R, line: '1.10', note: t.s1.wrap }, { path: R, line: '1.10', note: t.s1.wait }] })),
  },
];
