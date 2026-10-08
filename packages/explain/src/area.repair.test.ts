import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb, type AreaProgressEvent, type AreaWalkthrough, type ExplainLanguage } from '@digestit/core';
import { rangeSpan, splitHunks, walkPatch, type LineSpan } from '@digestit/core/hunks';
import { SAMPLES, SAMPLE_FILES, validSample } from '../test/walkthrough-samples.js';
import { ANCHOR_EXAMPLE, OTHER_CHANGES, buildAreaPrompt, checkAreaWalkthrough, explainArea } from './area.js';
import { DIGEST_PROMPT_VERSION } from './digest.js';
import { startJob } from './jobs.js';
import type { AreaInput, AreaResult, AreaStreamChunk, ExplanationProvider, ProviderFile } from './provider.js';

const LANGS: ExplainLanguage[] = ['en', 'ko'];
const ruleOf = (m: string): string => m.replace(/"[^"]*"/g, '"…"').replace(/\([^)]*\)/g, '(…)').replace(/\b\d+\b/g, 'N').trim();

/** Every shown hunk covered by a step's range, no "Other changes" step, and no line under two steps. */
function expectCoveredOnce(content: AreaWalkthrough, files: readonly ProviderFile[], language: ExplainLanguage): void {
  const lines = new Map(files.map((f) => [f.path, walkPatch(f.patch!)]));
  const spans = content.steps.map((s) => s.ranges.map((r) => {
    const res = rangeSpan(lines.get(r.path)!, r.side, r.start, r.end);
    if (!res.ok) throw new Error(`stored range ${JSON.stringify(r)} does not resolve: ${res.reason}`);
    return { path: r.path, span: res.span };
  }));
  for (const f of files) {
    for (const h of splitHunks(f.patch!)) {
      expect(spans.flat().some((s) => s.path === f.path && s.span.hunk === h.index)).toBe(true);
    }
  }
  expect(content.steps.map((s) => s.title)).not.toContain(OTHER_CHANGES[language].title);
  const all = spans.flatMap((ss, step) => ss.map((s) => ({ ...s, step })));
  const overlap = (a: LineSpan, b: LineSpan): boolean => a.from <= b.to && b.from <= a.to;
  for (const a of all) for (const b of all) {
    if (a !== b && a.path === b.path) expect(overlap(a.span, b.span)).toBe(false);
  }
  // Every callout inside one of its own step's ranges.
  content.steps.forEach((s, i) => {
    for (const c of s.callouts) {
      const res = rangeSpan(lines.get(c.path)!, c.side, c.start, c.end);
      expect(res.ok).toBe(true);
      if (res.ok) expect(spans[i]!.some((r) => r.path === c.path && r.span.from <= res.span.from && res.span.to <= r.span.to)).toBe(true);
    }
  });
}

describe.each(LANGS)('walkthrough repair before retry (DIG-125, %s)', (language) => {
  it('the valid sample passes as is: no violation, no repair', () => {
    const r = checkAreaWalkthrough(validSample(language), SAMPLE_FILES, language)!;
    expect(r.violations).toEqual([]);
    expect(r.styleWarnings).toEqual([]);
    expect(r.repairs).toEqual([]);
    expectCoveredOnce(r.content, SAMPLE_FILES, language);
  });

  it.each(SAMPLES)('$id reproduces its round 2-3 rule without repair', (sample) => {
    const r = checkAreaWalkthrough(sample.build(language), SAMPLE_FILES, language, undefined, { repair: false })!;
    expect(r.repairs).toEqual([]);
    expect([...new Set(r.violations.map(ruleOf))].sort()).toEqual([...sample.rules].sort());
  });

  it.each(SAMPLES.filter((s) => s.outcome === 'repaired'))('$id is repaired: no violation left, coverage and no-repeat hold', (sample) => {
    const r = checkAreaWalkthrough(sample.build(language), SAMPLE_FILES, language)!;
    expect(r.violations).toEqual([]);
    expect(r.repairs.length).toBeGreaterThan(0);
    expectCoveredOnce(r.content, SAMPLE_FILES, language);
    // Prose is never touched by a repair.
    expect(r.content.steps.map((s) => [s.title, s.body])).toEqual(validSample(language).steps.map((s) => [s.title, s.body]));
  });

  it.each(SAMPLES.filter((s) => s.outcome === 'retry'))('$id is not repairable: its violation stays', (sample) => {
    const r = checkAreaWalkthrough(sample.build(language), SAMPLE_FILES, language)!;
    expect(r.violations.map(ruleOf)).toEqual(expect.arrayContaining(sample.rules));
  });

  it('moves a callout just outside its range to the nearest line inside it', () => {
    const r = checkAreaWalkthrough(SAMPLES.find((s) => s.id === 'callout-outside-only')!.build(language), SAMPLE_FILES, language)!;
    expect(r.repairs).toEqual(["step 3: callout 1 (src/retry.js 1.6) was outside step 3's ranges; moved to src/retry.js 1.4"]);
    expect(r.content.steps[2]!.callouts.map(({ note: _n, ...c }) => c)).toEqual([{ path: 'src/retry.js', side: 'new', start: 3, end: 3 }]);
  });

  it('clips a callout that runs past its range to the lines inside it', () => {
    const r = checkAreaWalkthrough(SAMPLES.find((s) => s.id === 'callout-overhang')!.build(language), SAMPLE_FILES, language)!;
    // 1.10-1.11 named inside the range; 1.10 is the added half of a replacement, so 1.9 (its removed half) comes along.
    expect(r.repairs).toEqual(["step 1: callout 1 (src/retry.js 1.10-1.12) was outside step 1's ranges; moved to src/retry.js 1.9-1.11"]);
    expect(r.content.steps[0]!.callouts.map(({ note: _n, ...c }) => c)).toEqual([{ path: 'src/retry.js', side: 'new', start: 8, end: 9 }]);
  });

  it('merges overlapping ranges of one step, and drops an exact duplicate', () => {
    const merged = checkAreaWalkthrough(SAMPLES.find((s) => s.id === 'same-step-overlap')!.build(language), SAMPLE_FILES, language)!;
    expect(merged.repairs).toEqual(['step 1: range 2 (src/retry.js 1.9-1.11) overlapped range 1 of the same step; merged into src/retry.js 1.8-1.11']);
    expect(merged.content.steps[0]!.ranges).toEqual([{ path: 'src/retry.js', side: 'new', start: 7, end: 9 }]);
    const dup = checkAreaWalkthrough(SAMPLES.find((s) => s.id === 'same-step-duplicate')!.build(language), SAMPLE_FILES, language)!;
    expect(dup.repairs).toEqual(['step 1: range 2 (src/retry.js 1.8-1.11) repeats range 1; dropped']);
    expect(dup.content).toEqual(checkAreaWalkthrough(validSample(language), SAMPLE_FILES, language)!.content);
  });

  it('trims a later step\'s range off an earlier step\'s lines', () => {
    const r = checkAreaWalkthrough(SAMPLES.find((s) => s.id === 'cross-step-overlap')!.build(language), SAMPLE_FILES, language)!;
    expect(r.repairs).toEqual(["step 3: range 1 (src/retry.js 1.1-1.8) overlapped step 1's range (src/retry.js 1.8-1.11); trimmed to src/retry.js 1.1-1.7"]);
    expect(r.content.steps[2]!.ranges).toEqual([{ path: 'src/retry.js', side: 'new', start: 1, end: 6 }]);
  });

  it('keeps the overlap a violation when trimming would empty the range or orphan a callout', () => {
    const same = checkAreaWalkthrough(SAMPLES.find((s) => s.id === 'cross-step-same-lines')!.build(language), SAMPLE_FILES, language)!;
    expect(same.violations).toEqual([
      "step 3: range 1 (src/retry.js 1.8-1.11) overlaps step 1's range (src/retry.js 1.8-1.11)",
      'step 3: references no valid range',
    ]);
    const orphan = checkAreaWalkthrough(SAMPLES.find((s) => s.id === 'cross-step-orphan')!.build(language), SAMPLE_FILES, language)!;
    expect(orphan.violations).toEqual([
      "step 3: range 1 (src/retry.js 1.1-1.9) overlaps step 1's range (src/retry.js 1.8-1.11)",
      'step 3: references no valid range',
    ]);
    // The dropped step's hunk is still covered by step 1, so no "Other changes" step is needed.
    expectCoveredOnce(orphan.content, SAMPLE_FILES, language);
  });

  it('keeps an overlap strictly inside a later range a violation (trimming would split it in two)', () => {
    const reply = validSample(language);
    reply.steps[2] = { ...reply.steps[2]!, ranges: [{ path: 'src/retry.js', from: '1.1', to: '1.13' }] };
    const r = checkAreaWalkthrough(reply, SAMPLE_FILES, language)!;
    expect(r.violations).toContain("step 3: range 1 (src/retry.js 1.1-1.13) overlaps step 1's range (src/retry.js 1.8-1.11)");
    expect(r.repairs).toEqual([]);
  });

  it('never repairs a missing callout on a non-mechanical step', () => {
    const r = checkAreaWalkthrough(SAMPLES.find((s) => s.id === 'needs-callout')!.build(language), SAMPLE_FILES, language)!;
    expect(r.violations).toEqual(['step 2: needs at least one callout']);
    expect(r.repairs).toEqual([]);
  });

  it('does not move a callout in another file, or onto a line another callout of the step holds', () => {
    const other = checkAreaWalkthrough(SAMPLES.find((s) => s.id === 'callout-other-file')!.build(language), SAMPLE_FILES, language)!;
    expect(other.violations).toEqual(["step 3: callout 2 (src/errors.js 1.2) is not inside one of step 3's own ranges"]);
    const reply = validSample(language);
    // 1.12 is outside step 1's 1.8-1.11; its nearest line, 1.11, already has a callout.
    reply.steps[0] = { ...reply.steps[0]!, callouts: [reply.steps[0]!.callouts[1]!, { ...reply.steps[0]!.callouts[0]!, line: '1.12' }] };
    const taken = checkAreaWalkthrough(reply, SAMPLE_FILES, language)!;
    expect(taken.violations).toEqual(["step 1: callout 2 (src/retry.js 1.12) is not inside one of step 1's own ranges"]);
  });

  it('drops a range entry that names no lines, when the step has another', () => {
    const reply = validSample(language);
    reply.steps[1] = { ...reply.steps[1]!, ranges: [{} as never, ...reply.steps[1]!.ranges] };
    const r = checkAreaWalkthrough(reply, SAMPLE_FILES, language)!;
    expect(r.violations).toEqual([]);
    expect(r.repairs).toEqual(['step 2: range 1 names no lines; dropped']);
  });

  it('keeps the "Other changes" fallback for a hunk no range touches', () => {
    const reply = validSample(language);
    reply.steps = [reply.steps[0]!, reply.steps[2]!];
    const r = checkAreaWalkthrough(reply, SAMPLE_FILES, language)!;
    expect(r.violations).toEqual(["hunks not covered by any step's range: src/errors.js hunk 1"]);
    expect(r.content.steps.map((s) => s.title)).toEqual([reply.steps[0]!.title, reply.steps[1]!.title, OTHER_CHANGES[language].title]);
    expect(r.content.steps[2]!.ranges).toEqual([{ path: 'src/errors.js', side: 'new', start: 1, end: 6 }]);
  });

  it('gives line-ID error messages the retry can act on', () => {
    const reply = validSample(language);
    reply.steps[0] = {
      ...reply.steps[0]!,
      ranges: [
        { path: 'src/retry.js', from: '1.8', to: '1.11' },
        { path: 'src/retry.js', from: '1.2', to: '2.1' },
        { path: 'src/retry.js', from: '1.40', to: '1.41' },
        { path: 'src/retry.js', from: 1.2, to: 1.3 } as never,
        { path: 'src/retry.js', from: '3.1', to: '3.2' },
      ],
    };
    const r = checkAreaWalkthrough(reply, SAMPLE_FILES, language)!;
    expect(r.violations).toEqual([
      'step 1: range 2 (src/retry.js 1.2-2.1) crosses hunks: split it into one range per hunk',
      'step 1: range 3 (src/retry.js 1.40-1.41) names a line hunk 1 does not show (its lines are 1.1 to 1.14)',
      'step 1: range 4 (src/retry.js 1.2-1.3) is malformed: give line IDs as strings copied from the diff, like "2.7"',
      'step 1: range 5 (src/retry.js 3.1-3.2) names hunk 3, which this file does not show',
    ]);
  });
});

describe('area prompt a11 (DIG-125)', () => {
  const input: AreaInput = {
    repoName: 'snapback',
    digest: { l0: 'Failed requests are retried with a growing delay.', l1Bullets: ['Requests retry with backoff.'] },
    area: { id: 'src', title: 'Retry backoff', effect: 'e', how: 'h', why: 'w' },
    files: SAMPLE_FILES,
    language: 'en',
  };

  it('labels every line with its ID and asks for line-ID ranges and callouts', () => {
    const p = buildAreaPrompt(input);
    expect(p).toContain("hunk 1  @@ -1,9 +1,12 @@\n1.1- export async function withRetry(fn, times = 3) {\n1.2+ import { HttpError } from './errors.js';");
    expect(p).toContain('1.5    for (let i = 0; i < times; i++) {');
    expect(p).toContain('"ranges":[{"path":string,"from":string,"to":string}],"callouts":[{"path":string,"line":string,"note":string}]');
    expect(p).toContain('Ranges never overlap: not two ranges of one step, and not a range of one step with a range of another');
    expect(p).toContain("where every line lies inside one of this step's own \"ranges\"");
    expect(p).not.toMatch(/"side":"old"\|"new"/);
  });

  it.each(LANGS)('states the anchor rules with one short example in the walkthrough language (%s)', (language) => {
    const p = buildAreaPrompt({ ...input, language });
    expect(p).toContain(ANCHOR_EXAMPLE[language]);
    expect(p).not.toContain(ANCHOR_EXAMPLE[language === 'en' ? 'ko' : 'en']);
    // The example's own callout is inside its own range: it follows the rule it states.
    expect(ANCHOR_EXAMPLE[language]).toContain('"from":"2.3","to":"2.9"');
    expect(ANCHOR_EXAMPLE[language]).toContain('"line":"2.5"');
  });
});

class Scripted implements ExplanationProvider {
  readonly id = 'scripted';
  readonly model = 'm';
  inputs: AreaInput[] = [];
  constructor(private readonly replies: unknown[], private readonly chunk?: AreaStreamChunk) {}
  async explain(): Promise<never> { throw new Error('unused'); }
  async explainArea(input: AreaInput, onProgress?: (chunk: AreaStreamChunk) => void): Promise<AreaResult> {
    this.inputs.push(input);
    if (this.chunk) onProgress?.(this.chunk);
    const r = this.replies[Math.min(this.inputs.length - 1, this.replies.length - 1)];
    return { content: r as AreaResult['content'], provider: this.id, model: this.model };
  }
}

function seed(db: DatabaseSync, files: readonly ProviderFile[]): number {
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'snapback', '/path/to/my-project')").run();
  const id = Number(db.prepare("INSERT INTO change_unit (repo_id, kind, head_sha, title) VALUES (1, 'digest', 'sha1', 'digest')").run().lastInsertRowid);
  for (const f of files) {
    db.prepare('INSERT INTO file_change (change_unit_id, path, status, additions, deletions, patch) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, f.path, f.status, f.additions, f.deletions, f.patch);
  }
  const at = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO explanation (change_unit_id, level, content, status, provider, model, prompt_version, input_hash, created_at)
     VALUES (?, ?, ?, 'ok', 'stub', 'stub-1', ?, 'h', ?)`,
  );
  insert.run(id, 0, JSON.stringify({ text: 'Failed requests are retried with a growing delay.' }), DIGEST_PROMPT_VERSION, at);
  insert.run(id, 1, JSON.stringify({ userVisible: false, bullets: ['Requests retry with backoff.'] }), DIGEST_PROMPT_VERSION, at);
  const item = { id: 'src', paths: files.map((f) => f.path), title: 'Retry backoff', effect: 'e', how: 'h', why: 'w' };
  insert.run(id, 2, JSON.stringify({ items: [item], notAnalysed: [] }), DIGEST_PROMPT_VERSION, at);
  return id;
}

describe.each(LANGS)('explainArea: retry only for a hard violation left after repair (%s)', (language) => {
  it('stores a repaired reply from one call and logs the repairs as their own kind', async () => {
    const db = openDb(':memory:');
    const id = seed(db, SAMPLE_FILES);
    const jobId = startJob(db, 'area', { changeUnitId: id, areaId: 'src' }, 40)!;
    const p = new Scripted([SAMPLES.find((s) => s.id === 'callout-outside-only')!.build(language), validSample(language)]);
    const r = await explainArea(db, id, 'src', p, { job: { jobId, budget: 40 }, language });
    expect(r).toMatchObject({ outcome: 'ok', calls: 1 });
    const logged = db.prepare('SELECT violations FROM explain_call WHERE job_id = ?').all(jobId) as { violations: string | null }[];
    expect(logged).toEqual([{ violations: "repair: step 3: callout 1 (src/retry.js 1.6) was outside step 3's ranges; moved to src/retry.js 1.4" }]);
    const row = db.prepare('SELECT status, style_warnings FROM area_explanation').get() as { status: string; style_warnings: number };
    expect(row).toEqual({ status: 'ok', style_warnings: 0 });
  });

  it('retries a reply whose violation cannot be repaired, without the repairs in the feedback', async () => {
    const db = openDb(':memory:');
    const id = seed(db, SAMPLE_FILES);
    const bad = SAMPLES.find((s) => s.id === 'needs-callout')!.build(language);
    bad.steps[0] = SAMPLES.find((s) => s.id === 'callout-outside-sibling')!.build(language).steps[0]!;
    const p = new Scripted([bad, validSample(language)]);
    const r = await explainArea(db, id, 'src', p, { budget: 40, language });
    expect(r).toMatchObject({ outcome: 'ok', calls: 2 });
    expect(p.inputs[1]!.retryFeedback).toEqual(['step 2: needs at least one callout']);
  });

  it('streams steps with their line IDs already turned into stored ranges', async () => {
    const db = openDb(':memory:');
    const id = seed(db, SAMPLE_FILES);
    const reply = validSample(language);
    const events: AreaProgressEvent[] = [];
    const p = new Scripted([reply], { overview: reply.overview, steps: reply.steps.slice(0, 2), done: false });
    await explainArea(db, id, 'src', p, { budget: 40, language, onProgress: (e) => events.push(e) });
    expect(events[0]!.steps.map((s) => s.ranges)).toEqual([
      [{ path: 'src/retry.js', side: 'new', start: 7, end: 9 }],
      [{ path: 'src/errors.js', side: 'new', start: 1, end: 6 }],
    ]);
    expect(events[0]!.steps[0]!.callouts.map(({ note: _n, ...c }) => c)).toEqual([
      { path: 'src/retry.js', side: 'new', start: 8, end: 8 },
      { path: 'src/retry.js', side: 'new', start: 9, end: 9 },
    ]);
  });
});
