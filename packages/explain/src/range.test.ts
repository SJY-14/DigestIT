import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BudgetTracker, StubProvider, ROLLUP_PROMPT_VERSION, RANGE_PROMPT_VERSION, PROMPT_VERSION,
  buildRangePrompt, buildRollupPrompt, cacheKey, explainRange, explainRollup, prepareRange, prepareRollup,
} from './index.js';
import type { ExplanationProvider, RangeInput, RollupInput, ProviderResult, RollupResult, AllLevels, RawRange } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = (name: string) => join(here, '../test/golden', name);
const budget = () => new BudgetTracker({ maxCalls: 100, maxTokens: 1e9 });

const patchA = '@@ -1,3 +1,4 @@\n export function a() {\n-  return 1;\n+  return 2;\n+  // changed\n }\n';
const patchB = '@@ -0,0 +1,2 @@\n+export const b = 1;\n+export const c = 2;\n';
const range: RawRange = {
  repoName: 'DigestIT',
  title: 'DIG-99 add range prompt',
  members: [
    { sha: 'aaaaaaa1111', subject: 'Add a() change' },
    { sha: 'bbbbbbb2222', subject: 'Add b.ts constants' },
    { sha: 'ccccccc3333', subject: 'Fix typo' },
  ],
  files: [
    { path: 'src/a.ts', status: 'M', additions: 2, deletions: 1, patch: patchA },
    { path: 'src/b.ts', status: 'A', additions: 2, deletions: 0, patch: patchB },
  ],
};

const good: AllLevels = {
  l0: { text: 'Change the default return value and add shared constants' },
  l1: { userVisible: false, bullets: ['No user-visible change', 'Internal constants added.'] },
  l2: { items: [{ path: 'src/a.ts', role: 'module', change: 'returns 2' }], notAnalysed: [] },
  l3: { annotations: [{ path: 'src/a.ts', side: 'new', startLine: 2, endLine: 3, note: 'Return value changed.' }] },
};

class Scripted implements ExplanationProvider {
  readonly id = 'scripted';
  readonly model = 'm';
  ranges: RangeInput[] = [];
  rollups: RollupInput[] = [];
  constructor(private readonly replies: unknown[]) {}
  async explain(): Promise<ProviderResult> { throw new Error('unused'); }
  async explainRange(input: RangeInput): Promise<ProviderResult> {
    this.ranges.push(input);
    return { levels: this.replies[Math.min(this.ranges.length - 1, this.replies.length - 1)] as AllLevels, provider: this.id, model: this.model };
  }
  async rollup(input: RollupInput): Promise<RollupResult> {
    this.rollups.push(input);
    return { levels: this.replies[Math.min(this.rollups.length - 1, this.replies.length - 1)] as RollupResult['levels'], provider: this.id, model: this.model };
  }
}

function checkGolden(name: string, value: unknown): void {
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(golden(name)), { recursive: true });
    writeFileSync(golden(name), JSON.stringify(value, null, 1) + '\n');
  }
  expect(value).toEqual(JSON.parse(readFileSync(golden(name), 'utf8')));
}

describe('range prompt', () => {
  it('includes member subjects and a numbered range diff, and marks the unit as a range', () => {
    const p = buildRangePrompt(prepareRange(range).input);
    expect(p).toContain('kind="range"');
    expect(p).toContain('Commits (3):');
    expect(p).toContain('- aaaaaaa Add a() change');
    expect(p).toContain('2+   return 2;');
  });
  it('caps the member list in the prompt', () => {
    const many = { ...range, members: Array.from({ length: 60 }, (_, i) => ({ sha: `s${i}0000000`, subject: `c${i}` })) };
    expect(buildRangePrompt(prepareRange(many).input)).toContain('(+20 more commits)');
  });
});

describe('cache key and versions', () => {
  it('includes the unit kind, and the range hash depends on kind and members', () => {
    expect(cacheKey('range', 'r1', 'h')).not.toBe(cacheKey('commit', 'r1', 'h'));
    const a = prepareRange(range).inputHash;
    expect(prepareRange({ ...range, members: range.members.slice(1) }).inputHash).not.toBe(a);
    expect(prepareRange(range).inputHash).toBe(a);
    expect(new Set([PROMPT_VERSION, RANGE_PROMPT_VERSION, ROLLUP_PROMPT_VERSION]).size).toBe(3);
  });
});

describe('explainRange', () => {
  it('stub path: golden sample for a 3-commit range', async () => {
    const r = await explainRange(new StubProvider(), range, budget());
    expect(r).toMatchObject({ outcome: 'ok', calls: 1, promptVersion: RANGE_PROMPT_VERSION });
    checkGolden('range-3-commits.stub.json', r.levels);
  });

  it('accepts valid output with anchors in the range diff', async () => {
    const p = new Scripted([good]);
    const r = await explainRange(p, range, budget());
    expect(r).toMatchObject({ outcome: 'ok', calls: 1 });
    expect(r.levels.l3.annotations).toHaveLength(1);
  });

  it('rejects bad anchors, retries once with feedback, then stores truncated without them', async () => {
    const bad = { ...good, l3: { annotations: [
      { path: 'src/a.ts', side: 'new', startLine: 99, endLine: 100, note: 'nope' },
      { path: 'src/other.ts', side: 'new', startLine: 1, endLine: 1, note: 'nope' },
      good.l3.annotations[0]!,
    ] } };
    const p = new Scripted([bad]);
    const r = await explainRange(p, range, budget());
    expect(r.outcome).toBe('truncated');
    expect(r.calls).toBe(2);
    expect(p.ranges[1]!.retryFeedback?.join('\n')).toContain('does not exist in the diff');
    expect(r.levels.l3.annotations).toEqual(good.l3.annotations);
  });

  it('above the size cap makes no call and lists per-commit stubs and what was not analysed', async () => {
    const p = new Scripted([good]);
    const r = await explainRange(p, range, budget(), { maxRangeTokens: 10 });
    expect(r.outcome).toBe('oversize');
    expect(r.calls).toBe(0);
    expect(p.ranges).toHaveLength(0);
    expect(r.commitStubs.map((s) => s.l0)).toEqual(['Add a() change', 'Add b.ts constants', 'Fix typo']);
    expect(r.levels.l2.notAnalysed).toEqual(['src/a.ts (too_large)', 'src/b.ts (too_large)']);
    checkGolden('range-oversize.golden.json', { levels: r.levels, commitStubs: r.commitStubs });
  });

  it('respects the call budget', async () => {
    const r = await explainRange(new Scripted([good]), range, new BudgetTracker({ maxCalls: 0, maxTokens: 1 }));
    expect(r).toMatchObject({ outcome: 'budget', calls: 0 });
  });
});

const units = [
  { key: 'DIG-1', title: 'Login', state: 'merged', l0: 'Let people sign in.', userVisible: true, bullets: ['Sign-in page appears.'] },
  { key: 'DIG-2', title: 'Refactor', state: 'handoff', l0: 'Tidy the parser.', userVisible: false, bullets: ['No user-visible change'] },
  { key: 'DIG-3', title: 'Docs', state: 'active', l0: 'Document the API.', userVisible: false, bullets: ['No user-visible change'] },
];
const window: RollupInput = { repoName: 'DigestIT', windowStart: '2026-09-25T10:00:00Z', windowEnd: '2026-09-25T11:00:00Z', units };

describe('explainRollup', () => {
  it('stub path: golden sample for a roll-up of 3 units', async () => {
    const r = await explainRollup(new StubProvider(), window, budget());
    expect(r).toMatchObject({ outcome: 'ok', calls: 1, promptVersion: ROLLUP_PROMPT_VERSION });
    checkGolden('rollup-3-units.stub.json', r.levels);
  });

  it('sends text only: no diff or file content in the prompt', () => {
    const p = buildRollupPrompt(prepareRollup(window).input);
    expect(p).toContain('## DIG-1 [merged] Login');
    expect(p).not.toMatch(/@@|^--- /m);
    expect(p).not.toContain('<change');
  });

  it('makes no call for an empty window', async () => {
    const p = new Scripted([]);
    const r = await explainRollup(p, { ...window, units: [] }, budget());
    expect(r).toMatchObject({ outcome: 'empty', calls: 0 });
    expect(p.rollups).toHaveLength(0);
  });

  it('retries once on over-long L0 and then accepts', async () => {
    const long = { l0: { text: Array(30).fill('word').join(' ') }, l1: { userVisible: true, bullets: ['Sign-in appears.'] } };
    const ok = { l0: { text: 'Sign-in shipped and internals tidied' }, l1: { userVisible: true, bullets: ['Sign-in appears.'] } };
    const p = new Scripted([long, ok]);
    const r = await explainRollup(p, window, budget());
    expect(r).toMatchObject({ outcome: 'ok', calls: 2 });
    expect(p.rollups[1]!.retryFeedback?.[0]).toContain('l0: 30 words');
  });

  it('redacts secrets in unit text before sending', () => {
    const u = { ...units[0]!, l0: 'Use key ghp_abcdefghijklmnopqrstuvwxyz0123456789 now.' };
    const p = prepareRollup({ ...window, units: [u] });
    expect(p.input.units[0]!.l0).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
