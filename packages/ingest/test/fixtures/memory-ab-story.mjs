// DIG-107 memory A/B kit (docs/milestone-4-memory.md §6): the synthetic multi-day "snapback"
// story. A small placeholder HTTP client project, replayed as one checkpoint at a time so a
// memory-on run has real continuity to draw on by the time later checkpoints land: retry work at
// checkpoints 1, 3 and 6 (one thread), an unrelated change in between (2), a user correction (the
// `note` entry) between the retry work at 3 and the rename at 4, then more retry work (6) and
// unrelated filler (5, 7, 9) through a final polish pass (10). Placeholder names only -- "snapback"
// is not a real registered project.
//
// `write` keys are project-relative paths; `SNAPBACK_STORY` entries are applied in order, each on
// top of the last (a later entry only lists the files it adds or changes). `dayOffset` is in days
// relative to "now" at kit run time, so the story always reads as a real multi-day history no
// matter when the kit runs.

const packageJson = (description) => `{
  "name": "snapback",
  "version": "0.1.0",
  "description": "${description}"
}
`;

export const SNAPBACK_INIT = {
  dayOffset: -14,
  write: {
    'package.json': packageJson('A small HTTP client with retries.'),
    'README.md': '# snapback\n\nA small HTTP client.\n',
    'src/http.js': [
      'export async function request(url, opts = {}) {',
      '  return fetch(url, opts);',
      '}',
      '',
    ].join('\n'),
    'src/index.js': "export { request } from './http.js';\n",
  },
};

export const SNAPBACK_STORY = [
  {
    dayOffset: -14,
    kind: 'files',
    message: 'retry work part 1: add withRetry',
    write: {
      'src/retry.js': [
        'export async function withRetry(fn, times = 3) {',
        '  for (let i = 0; i < times; i++) {',
        '    try {',
        '      return await fn();',
        '    } catch (e) {',
        '      if (i === times - 1) throw e;',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    dayOffset: -12,
    kind: 'files',
    message: 'unrelated: document usage in the README',
    write: {
      'README.md': [
        '# snapback',
        '',
        'A small HTTP client.',
        '',
        '## Usage',
        '',
        '```js',
        "import { request } from 'snapback';",
        "await request('/api/x');",
        '```',
        '',
      ].join('\n'),
    },
  },
  {
    dayOffset: -11,
    kind: 'files',
    message: 'retry work part 2: exponential backoff and HttpError',
    write: {
      'src/errors.js': [
        'export class HttpError extends Error {',
        '  constructor(status, message) {',
        '    super(message);',
        '    this.status = status;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/retry.js': [
        "import { HttpError } from './errors.js';",
        '',
        'export async function withRetry(fn, times = 3, baseMs = 100) {',
        '  for (let i = 0; i < times; i++) {',
        '    try {',
        '      return await fn();',
        '    } catch (e) {',
        '      if (i === times - 1) throw e instanceof HttpError ? e : new HttpError(0, e.message);',
        '      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    dayOffset: -9,
    kind: 'note',
    message: 'user correction: the backoff base is 200ms by team convention',
    target: { kind: 'term', key: 'withRetry' },
    text:
      "withRetry's default backoff base is 200ms per the team's retry convention, not the 100ms "
      + 'in the code comment; the convention doc is the source of truth.',
  },
  {
    dayOffset: -8,
    kind: 'files',
    message: 'rename withRetry to retryRequest',
    write: {
      'src/retry.js': [
        "import { HttpError } from './errors.js';",
        '',
        'export async function retryRequest(fn, times = 3, baseMs = 100) {',
        '  for (let i = 0; i < times; i++) {',
        '    try {',
        '      return await fn();',
        '    } catch (e) {',
        '      if (i === times - 1) throw e instanceof HttpError ? e : new HttpError(0, e.message);',
        '      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/index.js': "export { request } from './http.js';\nexport { retryRequest } from './retry.js';\n",
    },
  },
  {
    dayOffset: -6,
    kind: 'files',
    message: 'unrelated: add a simple GET cache',
    write: {
      'src/cache.js': [
        'const store = new Map();',
        '',
        'export function cached(key, fn) {',
        '  if (store.has(key)) return store.get(key);',
        '  const value = fn();',
        '  store.set(key, value);',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    dayOffset: -5,
    kind: 'files',
    message: 'retry work part 3: stop retrying 4xx, add maxAttempts option',
    write: {
      'src/retry.js': [
        "import { HttpError } from './errors.js';",
        '',
        'export async function retryRequest(fn, { maxAttempts = 3, baseMs = 100 } = {}) {',
        '  for (let i = 0; i < maxAttempts; i++) {',
        '    try {',
        '      return await fn();',
        '    } catch (e) {',
        '      const err = e instanceof HttpError ? e : new HttpError(0, e.message);',
        '      if (i === maxAttempts - 1 || (err.status >= 400 && err.status < 500)) throw err;',
        '      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    dayOffset: -3,
    kind: 'files',
    message: 'unrelated: bump package version and description',
    write: { 'package.json': packageJson('A small HTTP client with retries. Now with caching.') },
  },
  {
    dayOffset: -2,
    kind: 'files',
    message: 'add tests for retryRequest',
    write: {
      'tests/retry.test.js': [
        "import { retryRequest } from '../src/retry.js';",
        '',
        "test('retries then succeeds', async () => {",
        '  let n = 0;',
        "  const v = await retryRequest(async () => { if (n++ < 1) throw new Error('x'); return 'ok'; });",
        "  expect(v).toBe('ok');",
        '});',
        '',
      ].join('\n'),
    },
  },
  {
    dayOffset: -1,
    kind: 'files',
    message: 'unrelated: log request timing in http.js',
    write: {
      'src/http.js': [
        'export async function request(url, opts = {}) {',
        '  const start = Date.now();',
        '  const res = await fetch(url, opts);',
        '  console.debug(`request ${url} took ${Date.now() - start}ms`);',
        '  return res;',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    dayOffset: 0,
    kind: 'files',
    message: 'final polish: JSDoc on retryRequest',
    write: {
      'src/retry.js': [
        "import { HttpError } from './errors.js';",
        '',
        '/** Retries `fn` up to `maxAttempts` times with exponential backoff; gives up at once on a 4xx `HttpError`. */',
        'export async function retryRequest(fn, { maxAttempts = 3, baseMs = 100 } = {}) {',
        '  for (let i = 0; i < maxAttempts; i++) {',
        '    try {',
        '      return await fn();',
        '    } catch (e) {',
        '      const err = e instanceof HttpError ? e : new HttpError(0, e.message);',
        '      if (i === maxAttempts - 1 || (err.status >= 400 && err.status < 500)) throw err;',
        '      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  },
];
