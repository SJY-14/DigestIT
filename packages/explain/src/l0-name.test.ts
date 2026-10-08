import { describe, expect, it } from 'vitest';
import {
  DIGEST_PROMPT_VERSION, DIGEST_SUMMARY_PROMPT_VERSION, L0_NAME_FREE_LOCAL, buildDigestPrompt, buildDigestSummaryPrompt,
  checkDigestLevels, checkSummaryLevels,
} from './digest.js';
import { l0CodeName } from './validate.js';

const L1 = { userVisible: true, bullets: ['Failed requests are retried with a growing delay.'] };

// DIG-125: the L0 rule names no identifier at all. Each line names the token l0CodeName must report.
const HITS: { lang: string; text: string; hit: string }[] = [
  { lang: 'en', text: 'The `withRetry` helper now backs off between attempts, so flaky calls recover.', hit: '`' },
  { lang: 'en', text: 'Requests now retry through src/retry.js, so flaky calls recover.', hit: 'src/retry.js' },
  { lang: 'en', text: 'Failed requests now go through withRetry, so flaky calls recover on their own.', hit: 'withRetry' },
  { lang: 'en', text: 'A new RetryPolicy decides when to give up, so callers stop guessing.', hit: 'RetryPolicy' },
  { lang: 'en', text: 'Callers can now set max_retries, so slow servers get more chances.', hit: 'max_retries' },
  { lang: 'en', text: 'Callers can now set MAX_RETRIES, so slow servers get more chances.', hit: 'MAX_RETRIES' },
  { lang: 'en', text: 'Calling retryRequest() now gives up early on client errors, which saves wasted calls.', hit: 'retryRequest()' },
  { lang: 'en', text: 'The client now exports request(url) wrapped in retries, so callers get them for free.', hit: 'request(url)' },
  { lang: 'en', text: "The 'cached' wrapper now remembers results, so repeated lookups are instant.", hit: "'cached'" },
  { lang: 'en', text: 'The "maxAttempts" option now caps retries, so a dead server fails fast.', hit: '"maxAttempts"' },
  { lang: 'en', text: 'The “baseMs” setting now controls the delay, so teams can tune it.', hit: '“baseMs”' },
  { lang: 'en', text: 'The "--retries" flag now sets the attempt count from the command line.', hit: '"--retries"' },
  { lang: 'ko', text: '`withRetry`가 이제 시도 사이에 기다려, 일시적 장애에서 호출이 스스로 회복합니다.', hit: '`' },
  { lang: 'ko', text: 'withRetry가 이제 시도 사이에 기다려, 일시적 장애에서 호출이 스스로 회복합니다.', hit: 'withRetry' },
  { lang: 'ko', text: '「retryRequest」가 4xx 응답에서는 바로 멈춰, 쓸모없는 재시도를 줄입니다.', hit: '「retryRequest」' },
  { lang: 'ko', text: '이제 retryRequest()가 4xx 응답에서는 바로 멈춰, 쓸모없는 재시도를 줄입니다.', hit: 'retryRequest()' },
  { lang: 'ko', text: "'maxAttempts' 옵션으로 재시도 횟수를 정할 수 있어, 느린 서버에 더 기회를 줍니다.", hit: "'maxAttempts'" },
  { lang: 'ko', text: 'max_attempts 설정으로 재시도 횟수를 정할 수 있어, 느린 서버에 더 기회를 줍니다.', hit: 'max_attempts' },
];

// Ordinary prose that must pass, Korean included: product names with inner capitals, UI labels in
// quotes, acronyms, apostrophes, and accepted L0s from the real memory A/B rounds 2-3 (snapback).
const PASSES: { lang: string; text: string }[] = [
  { lang: 'en', text: 'The HTTP client can now automatically retry a failed request, so brief network errors no longer break a call.' },
  { lang: 'en', text: 'snapback gains a retry helper that re-runs a failing request up to three times, so transient errors stop failing calls outright.' },
  { lang: 'en', text: 'Developers can now see how long each HTTP request takes in debug output, which helps them spot slow endpoints.' },
  { lang: 'en', text: 'The package description now advertises caching, though the diff adds no caching code, so the listing may promise a feature that doesn\'t exist.' },
  { lang: 'en', text: 'Pull requests on GitHub now show the TypeScript build status, so reviewers see breakage before merging.' },
  { lang: 'en', text: 'The "Export to PDF" button now keeps the page layout, so reports print the way users see them.' },
  { lang: 'en', text: 'A new "Save" button and a "PDF" option let readers keep a copy of the report.' },
  { lang: 'en', text: 'Users\' settings now survive a restart on macOS and iOS, so nobody has to sign in twice.' },
  { lang: 'en', text: 'Retries now wait longer each time (up to three attempts), so a busy server gets room to recover.' },
  { lang: 'en', text: 'Reviewers now see which file(s) and branch(es) changed, so they know where to start.' },
  { lang: 'ko', text: 'HTTP 요청이 끝내 실패해도 오류 형식이 일정하고 재시도 간격이 늘어나, 3일 전 자동 재시도 작업을 이어 서버 부담을 줄입니다.' },
  { lang: 'ko', text: 'API 호출이 실패하면 간격을 두고 다시 시도하고 오류 형태도 통일해, 일시적 장애에서 호출자가 직접 대응하지 않아도 됩니다.' },
  { lang: 'ko', text: '재시도 함수를 패키지 진입점에서 바로 가져다 쓸 수 있어, 사용자가 실패한 API 호출을 직접 재시도하기 쉬워집니다.' },
  { lang: 'ko', text: 'GitHub에서 TypeScript 빌드 결과를 바로 볼 수 있어, 리뷰어가 병합 전에 문제를 발견합니다.' },
  { lang: 'ko', text: '「내보내기」 버튼이 페이지 배치를 유지해, 보고서가 화면과 같은 모양으로 인쇄됩니다.' },
  { lang: 'ko', text: '‘저장’ 버튼으로 보고서 사본을 남길 수 있어, 표를 손으로 옮기지 않아도 됩니다.' },
  { lang: 'ko', text: '재시도 간격이 매번 두 배로 늘어나(최대 세 번), 바쁜 서버가 회복할 여유를 얻습니다.' },
  { lang: 'ko', text: 'GitHub(깃허브) 로그인이 끊기지 않아, 사용자가 다시 로그인하지 않아도 됩니다.' },
  { lang: 'ko', text: 'API(외부 연동) 응답이 빨라져 페이지가 바로 열립니다.' },
];

describe('l0CodeName (DIG-125)', () => {
  it.each(HITS)('catches $hit ($lang)', ({ text, hit }) => {
    expect(l0CodeName(text)).toBe(hit);
  });

  it.each(PASSES)('lets ordinary prose through ($lang): $text', ({ text }) => {
    expect(l0CodeName(text)).toBeNull();
  });
});

describe('the L0 check in both digest validators (DIG-125)', () => {
  it.each(['en', 'ko'] as const)('flags a code name in the summary l0 and names it in the message (%s)', (language) => {
    const text = HITS.find((h) => h.lang === language && h.hit.endsWith('()'))!.text;
    const r = checkSummaryLevels({ l0: { text }, l1: L1 }, language)!;
    expect(r.violations).toContain('l0: mentions a file name or code identifier (retryRequest()); say it in plain words');
  });

  it.each(['en', 'ko'] as const)('passes a plain l0 in the summary (%s)', (language) => {
    const text = PASSES.find((p) => p.lang === language)!.text;
    expect(checkSummaryLevels({ l0: { text }, l1: L1 }, language)!.violations).toEqual([]);
  });

  it('flags a camelCase name in the one-call digest l0 too', () => {
    const r = checkDigestLevels({
      l0: { text: 'Failed requests now go through withRetry, so flaky calls recover on their own.' }, l1: L1,
      l2: { items: [{ id: 'src', paths: ['src/retry.js'], title: 'Retry helper', effect: 'Requests retry.', how: 'Adds `withRetry`.', why: 'Flaky calls.' }], notAnalysed: [] },
    }, [{ path: 'src/retry.js', status: 'A', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+x\n', filteredReason: null }])!;
    expect(r.violations).toContain('l0: mentions a file name or code identifier (withRetry); say it in plain words');
  });
});

describe('the L0 no-code instruction (DIG-125)', () => {
  const summaryInput = { repoName: 'snapback', files: [], areas: [], language: 'en' as const };

  it('is bumped: summary s7, one-call digest d6', () => {
    expect(DIGEST_SUMMARY_PROMPT_VERSION).toBe('s7');
    expect(DIGEST_PROMPT_VERSION).toBe('d6');
  });

  it('states the rule outright in both prompts, and backticks for l1 only', () => {
    for (const p of [buildDigestSummaryPrompt(summaryInput), buildDigestPrompt({ repoName: 'snapback', files: [], language: 'en' } as never)]) {
      expect(p).toContain('l0 names no code at all, which overrides the voice rule to name functions and flags');
      expect(p).toContain('not even in quotes or 「」');
      expect(p).toContain('Product names such as GitHub or TypeScript are fine.');
      expect(p).not.toContain(L0_NAME_FREE_LOCAL.ko);
    }
    expect(buildDigestSummaryPrompt(summaryInput)).toContain('file/path fragments in l1 (never in l0)');
  });

  it('restates it in Korean for a Korean digest', () => {
    const p = buildDigestSummaryPrompt({ ...summaryInput, language: 'ko' });
    expect(p).toContain(L0_NAME_FREE_LOCAL.ko);
    expect(L0_NAME_FREE_LOCAL.ko).toContain('「」');
    expect(buildDigestPrompt({ repoName: 'snapback', files: [], language: 'ko' } as never)).toContain(L0_NAME_FREE_LOCAL.ko);
  });
});
