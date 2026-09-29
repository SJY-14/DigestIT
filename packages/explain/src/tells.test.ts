import { describe, expect, it } from 'vitest';
import { aiTellHits, aiTells, openerSignature, repeatedOpenerCount } from './tells.js';

const has = (text: string, language: 'en' | 'ko', id: string): boolean => aiTellHits(text, language).some((h) => h.id === id);

interface Case {
  id: string;
  hit: string;
  nearMiss: string;
}

describe('aiTells: English rules', () => {
  const cases: Case[] = [
    { id: 'opener-this-x', hit: 'This change introduces a retry flag for uploads.', nearMiss: 'A new retry flag lets uploads survive a flaky connection.' },
    { id: 'opener-this-x', hit: 'This area adds a Settings screen reachable from App.', nearMiss: 'A new Settings screen is reachable from App.' },
    { id: 'opener-in-this', hit: 'In this commit, the retry loop gains a jitter.', nearMiss: 'The retry loop gains a jitter this time around.' },
    { id: 'opener-overall', hit: 'Overall, the upload path retries transient errors.', nearMiss: 'The upload path retries transient errors and logs each attempt.' },
    { id: 'recap-in-summary', hit: 'The upload retries transient errors. In summary, retries help.', nearMiss: 'The upload retries transient errors. A 4xx reply still fails at once.' },
    { id: 'recap-to-summarize', hit: 'Retries now use backoff. To summarize, the flag is optional.', nearMiss: 'Retries now use backoff. The flag defaults to three attempts.' },
    { id: 'recap-in-conclusion', hit: 'Retries now use backoff. In conclusion, the change is small.', nearMiss: 'Retries now use backoff. The change touches two files.' },
    { id: 'recap-overall', hit: 'Retries now use backoff. Overall, the change is safe.', nearMiss: 'Retries now use backoff. The change touches two files.' },
    {
      id: 'hedge-worth-noting',
      hit: "It's worth noting that retries add latency on failure.",
      nearMiss: 'Retries add up to 10 seconds of latency on failure.',
    },
    {
      id: 'hedge-important-to',
      hit: 'It is important to note that 4xx replies are not retried.',
      nearMiss: '4xx replies are not retried, since retrying them repeats the same bad key.',
    },
    { id: 'hedge-essentially', hit: 'withRetry is essentially a loop with a delay.', nearMiss: 'withRetry is a loop that waits between attempts.' },
    { id: 'hedge-various', hit: 'The change touches various files across the upload path.', nearMiss: 'The change touches three files across the upload path.' },
    { id: 'hedge-a-number-of', hit: 'A number of callers still expect the old return type.', nearMiss: 'Three callers still expect the old return type.' },
    { id: 'hedge-a-number-of', hit: 'A number of callers still expect the old return type.', nearMiss: 'Retries accept a number of 500 or more as a server error.' },
    { id: 'hedge-ensures-that', hit: 'The check ensures that retries never exceed ten attempts.', nearMiss: 'The check caps retries at ten attempts.' },
    { id: 'hedge-helps-to', hit: 'The injected clock helps to make the delays testable.', nearMiss: 'The injected clock makes the delays testable.' },
    { id: 'marketing-seamless', hit: 'Retries happen seamlessly in the background.', nearMiss: 'Retries happen automatically, with no user action needed.' },
    { id: 'marketing-effortless', hit: 'Recovering from a dropped upload is now effortless.', nearMiss: 'Recovering from a dropped upload now takes zero clicks.' },
    { id: 'marketing-powerful', hit: 'The new retry helper is powerful.', nearMiss: 'The new retry helper caps waits at ten seconds.' },
    { id: 'marketing-robust', hit: 'This makes the upload path more robust.', nearMiss: 'This makes the upload path retry ECONNRESET and ETIMEDOUT.' },
    { id: 'marketing-comprehensive', hit: 'The test suite is now comprehensive.', nearMiss: 'The test suite now covers the 403 and 500 cases.' },
    { id: 'marketing-streamline', hit: 'The change streamlines the upload path.', nearMiss: 'The change merges two upload helpers into one.' },
    { id: 'marketing-leverage', hit: 'The retry helper leverages exponential backoff.', nearMiss: 'The retry helper doubles its wait time on each attempt.' },
    { id: 'marketing-unlock', hit: 'The flag unlocks configurable retries.', nearMiss: 'The flag lets operators set the retry count.' },
    { id: 'marketing-supercharge', hit: 'The new cache supercharges page loads.', nearMiss: 'The new cache cuts page load time by half.' },
    { id: 'marketing-delve', hit: "Let's delve into the retry loop's internals.", nearMiss: 'The retry loop doubles its wait on each attempt.' },
    { id: 'marketing-elevate', hit: 'This change elevates the reporting output.', nearMiss: 'This change adds a CSV export option.' },
    { id: 'marketing-enhance-bare', hit: 'The retry loop was enhanced.', nearMiss: "The retry loop was enhanced with a jittered backoff." },
    {
      id: 'vague-value-claim',
      hit: 'This improves the performance of the upload path.',
      nearMiss: 'This cuts upload latency from 800ms to 200ms.',
    },
    { id: 'structure-exclamation', hit: 'Retries now work great!', nearMiss: 'Retries now cap at ten attempts.' },
    { id: 'structure-bold', hit: 'The **retries** flag now defaults to three.', nearMiss: 'The `retries` flag now defaults to three.' },
    {
      id: 'structure-em-dash-chain',
      hit: 'The retry loop — the core of this change — now jitters its wait — always.',
      nearMiss: 'The retry loop is the core of this change, and it now jitters its wait.',
    },
    {
      id: 'structure-triplet',
      hit: 'The new backoff makes uploads faster, safer, and more reliable.',
      nearMiss: 'The new backoff retries ECONNRESET, ETIMEDOUT, and EPIPE.',
    },
  ];

  for (const c of cases) {
    it(`${c.id}: flags "${c.hit}"`, () => {
      expect(has(c.hit, 'en', c.id)).toBe(true);
    });
    it(`${c.id}: does not flag the near-miss "${c.nearMiss}"`, () => {
      expect(has(c.nearMiss, 'en', c.id)).toBe(false);
    });
  }

  it('vague-value-claim is not flagged when the same sentence names a number, function or mechanism', () => {
    expect(has('This improves performance by caching the parsed config, cutting P50 latency by 40%.', 'en', 'vague-value-claim')).toBe(false);
    expect(has('This improves reliability: retryQueue now retries ECONNRESET automatically.', 'en', 'vague-value-claim')).toBe(false);
  });

  it('opener rule only looks at the start of the field', () => {
    expect(has('The retry loop uses this change to decide when to stop.', 'en', 'opener-this-x')).toBe(false);
  });

  it('recap rule only looks at the last sentence', () => {
    expect(has('Overall counts stay on the summary screen. Retries now cap at ten.', 'en', 'recap-overall')).toBe(false);
  });
});

describe('aiTells: stripping code spans, identifiers and paths', () => {
  it('never flags a marketing/hedge word inside a code span', () => {
    expect(aiTells('Call `enhanceRetry()` after the upload fails.', 'en')).toEqual([]);
    expect(aiTells('See `various(x)` for the dispatch table.', 'en')).toEqual([]);
  });

  it('never flags a word inside a bare function call or file path', () => {
    expect(aiTells('enhanceRetry() now accepts a jitter option.', 'en')).toEqual([]);
    expect(aiTells('See docs/various.md for the full list of flags.', 'en')).toEqual([]);
    expect(aiTells('The various.md file documents the flag.', 'en')).toEqual([]);
  });

  it('does not treat __filename or __init__ as markdown italics', () => {
    expect(has('The test uploads __filename as the sample file.', 'en', 'structure-bold')).toBe(false);
    expect(has('__init__ now accepts a retries argument.', 'en', 'structure-bold')).toBe(false);
  });

  it('does not treat "**" used as exponentiation as markdown bold', () => {
    expect(has('delay is base * 2 ** (attempt - 1), capped at max.', 'en', 'structure-bold')).toBe(false);
  });

  it('does not treat "!=" / "!==" as a bare exclamation mark', () => {
    expect(has('The check now compares retries !== 0 before looping.', 'en', 'structure-exclamation')).toBe(false);
    expect(has('The check now compares retries !== 0 before looping!', 'en', 'structure-exclamation')).toBe(true);
    expect(has('Returns early when !ready is true.', 'en', 'structure-exclamation')).toBe(false);
  });

  it('leaves concrete lists and the technical senses of unlock/elevated alone', () => {
    expect(has('Splits the parser, lexer, and printer into separate modules.', 'en', 'structure-triplet')).toBe(false);
    expect(has('The consumer, producer, and worker share one queue.', 'en', 'structure-triplet')).toBe(false);
    expect(has('Adds more tests, more logs, and more retries.', 'en', 'structure-triplet')).toBe(false);
    expect(has('Makes startup simpler, cleaner, and more robust.', 'en', 'structure-triplet')).toBe(true);
    expect(has('Calls unlock on the mutex before returning.', 'en', 'marketing-unlock')).toBe(false);
    expect(has('Runs the installer with elevated privileges.', 'en', 'marketing-elevate')).toBe(false);
  });
});

describe('aiTells: Korean rules', () => {
  const cases: Case[] = [
    {
      id: 'ko-tonghae-hyangsang',
      hit: '재시도 로직을 통해 안정성이 향상됩니다.',
      nearMiss: '재시도 로직이 실패를 3회까지 허용합니다.',
    },
    { id: 'ko-jeonbanjeog-euro', hit: '전반적으로 이번 변경은 여러 파일에 걸쳐 있습니다.', nearMiss: '이번 변경은 retry.ts와 upload.ts 두 파일에 걸쳐 있습니다.' },
    { id: 'ko-dayanghan', hit: '다양한 파일이 이번 변경에 포함되었습니다.', nearMiss: 'retry.ts와 upload.ts 두 파일이 이번 변경에 포함되었습니다.' },
    { id: 'ko-hyoyuljeog-euro', hit: '재시도 로직이 효율적으로 개선되었습니다.', nearMiss: '재시도 대기 시간이 200ms에서 절반으로 줄었습니다.' },
    { id: 'ko-wonhwalhan', hit: '이번 변경으로 보다 원활한 업로드 경험을 제공합니다.', nearMiss: '업로드 실패 시 재시도 횟수를 3회로 제한합니다.' },
    { id: 'ko-hasipsio', hit: '설정 파일을 확인하십시오.', nearMiss: '설정 파일을 확인합니다.' },
    { id: 'ko-hasipsio', hit: '새 플래그를 문서에서 참고하시기 바랍니다.', nearMiss: '새 플래그는 문서에 설명되어 있습니다.' },
    { id: 'ko-salpyeobogessseupnida', hit: '이제 재시도 로직을 살펴보겠습니다.', nearMiss: '재시도 로직은 실패 시 최대 10초까지 대기합니다.' },
  ];

  for (const c of cases) {
    it(`${c.id}: flags "${c.hit}"`, () => {
      expect(has(c.hit, 'ko', c.id)).toBe(true);
    });
    it(`${c.id}: does not flag the near-miss "${c.nearMiss}"`, () => {
      expect(has(c.nearMiss, 'ko', c.id)).toBe(false);
    });
  }

  it('never flags a Latin identifier embedded in Korean prose', () => {
    expect(aiTells('테스트 파일 자신(__filename)을 업로드 대상으로 씁니다.', 'ko')).toEqual([]);
  });

  it('structure rules (bare "!", bold/italics, em-dash chains) also apply to Korean text', () => {
    expect(has('재시도가 이제 잘 됩니다!', 'ko', 'structure-exclamation')).toBe(true);
    expect(has('**재시도** 플래그의 기본값은 3입니다.', 'ko', 'structure-bold')).toBe(true);
    expect(has('재시도 로직 — 이 변경의 핵심 — 이 이제 지터를 줍니다 — 항상.', 'ko', 'structure-em-dash-chain')).toBe(true);
  });
});

describe('aiTells: one reason per distinct rule, not per occurrence', () => {
  it('collapses repeated hits of the same rule into a single reason', () => {
    const hits = aiTellHits('The patch touches various files. It also fixes various tests.', 'en');
    expect(hits.filter((h) => h.id === 'hedge-various')).toHaveLength(1);
  });

  it('reasons say what to do instead, and stack across distinct rules', () => {
    const reasons = aiTells('This change introduces a seamless retry helper.', 'en');
    expect(reasons.some((r) => r.includes('start with the concrete subject'))).toBe(true);
    expect(reasons.some((r) => r.includes('describe the concrete mechanism'))).toBe(true);
  });
});

describe('openerSignature / repeatedOpenerCount (report-only, DIG-65 step 5)', () => {
  it('signature is the first three normalised words', () => {
    expect(openerSignature('This area adds src/retry.ts, a small helper.')).toBe('this area adds');
    expect(openerSignature('  Overview:   uploadFile now retries failed puts.')).toBe('overview uploadfile now');
  });

  it('counts every overview that shares its opener with at least one other', () => {
    const overviews = [
      'This area adds src/retry.ts, a small helper that retries an async call.',
      'uploadFile now retries failed puts through withRetry.',
      'runQueue no longer rejects on the first failed item.',
      'This area adds a retries setting that operators control.',
    ];
    expect(repeatedOpenerCount(overviews)).toBe(2);
  });

  it('is 0 when every overview opens differently', () => {
    const overviews = ['새 src/retry.ts의 withRetry는…', '업로드가 재시도를 모두 소진하면…', 'runQueue가 이제…', 'loadConfig가…'];
    expect(repeatedOpenerCount(overviews)).toBe(0);
  });
});
