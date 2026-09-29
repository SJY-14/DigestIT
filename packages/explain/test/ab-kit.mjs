// DIG-74 operator A/B kit (docs/explain-speed.md §2-3, §8): runs the split Explain parts (summary,
// area text, area walkthrough) over the synthetic `walkthrough-snapback` fixture in English and
// Korean, across a flag/model matrix, and prints per-part timing, tokens, AI-tell lint counts,
// first-try validator pass rate and walkthrough coverage-repair rate.
//
// The legacy one-call `explainDigest` also runs first, as the "Now" baseline from the doc's table,
// to derive the digest's areas the same way an operator would see them today (DIG-75's deterministic
// `groupDigestAreas` is not part of this package; this stand-in is replaced once DIG-75 lands).
//
// Dry run (no network, deterministic, what this repo's tests/CI can run):
//   pnpm -r build && node packages/explain/test/ab-kit.mjs
// Real provider (sends the synthetic fixture, not real code, to Anthropic; needs a logged-in `claude`
// CLI, which the sandbox this kit was written in does not have — the operator runs this form):
//   pnpm -r build && node packages/explain/test/ab-kit.mjs --real
// Results are written under .cache/DIG-74-acceptance/ (gitignored); override with --out <dir>.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@digestit/core';
import {
  ClaudeCodeProvider, StubProvider, explainArea, explainDigest, explainDigestAreaText, explainDigestSummary,
  finishJob, formatTimingReport, lintDb, startJob, timingReport,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures/walkthrough-snapback.json');
const LANGUAGES = ['en', 'ko'];
const BUDGET = 1000; // high enough that the kit itself is never budget-limited

const FLAG_SETS = [
  { name: 'flags-off', cheapRun: {} },
  { name: 'flags-on', cheapRun: { systemPrompt: true, noSessionPersistence: true, strictMcpConfig: true, disableSlashCommands: true } },
];
const SUMMARY_MODELS = [
  { name: 'sonnet-low', tasks: { summary: { model: 'sonnet', effort: 'low' }, context: { model: 'sonnet', effort: 'low' } } },
  { name: 'haiku', tasks: { summary: { model: 'haiku', effort: 'low' }, context: { model: 'haiku', effort: 'low' } } },
];
const FIXED_TASKS = { area: { model: 'sonnet', effort: 'low' }, walkthrough: { model: 'sonnet', effort: 'medium' } };

function seedDb(fixture, language) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, ?, '/project')").run(fixture.repoName);
  const id = Number(
    db.prepare("INSERT INTO change_unit (repo_id, kind, head_sha, title) VALUES (1, 'digest', 'shadow', 'digest')").run().lastInsertRowid,
  );
  for (const f of fixture.files) {
    db.prepare('INSERT INTO file_change (change_unit_id, path, status, additions, deletions, patch) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, f.path, f.status, f.additions, f.deletions, f.patch);
  }
  const now = new Date().toISOString();
  db.prepare("INSERT INTO checkpoint (id, repo_id, seq, shadow_sha, tree_sha, taken_at, reason) VALUES (1, 1, 1, 's1', 't1', ?, 'init')").run(now);
  db.prepare("INSERT INTO checkpoint (id, repo_id, seq, shadow_sha, tree_sha, taken_at, reason) VALUES (2, 1, 2, 's2', 't2', ?, 'explain')").run(now);
  db.prepare('INSERT INTO digest (change_unit_id, repo_id, from_checkpoint_id, to_checkpoint_id, created_at, language) VALUES (?, 1, 1, 2, ?, ?)')
    .run(id, now, language);
  return { db, id };
}

/** Legacy one-shot digest, as the "Now" baseline and as a stand-in for DIG-75's `groupDigestAreas`. */
async function baselineAreas(db, id, provider, language) {
  const start = Date.now();
  const baseline = await explainDigest(db, id, provider, { budget: BUDGET, language });
  const baselineMs = Date.now() - start;
  const l2Row = db.prepare('SELECT content FROM explanation WHERE change_unit_id = ? AND level = 2').get(id);
  const l2 = JSON.parse(l2Row.content);
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const areas = l2.items.map((it) => {
    const files = fixture.files.filter((f) => it.paths.includes(f.path));
    return {
      id: it.id, label: it.title, paths: it.paths,
      additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  });
  db.prepare('UPDATE digest SET areas = ? WHERE change_unit_id = ?').run(JSON.stringify(areas), id);
  return { areas, baseline, baselineMs };
}

async function runCombo(provider, language, comboName) {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const { db, id } = seedDb(fixture, language);
  const { areas, baseline, baselineMs } = await baselineAreas(db, id, provider, language);

  const parts = []; // { part, outcome, calls }
  const digestJobId = startJob(db, 'explain', { repoId: 1, changeUnitId: id }, BUDGET);
  const job = { jobId: digestJobId, budget: BUDGET };
  const summary = await explainDigestSummary(db, id, provider, { job, language });
  parts.push({ part: 'summary', ...summary });
  for (const area of areas) {
    const r = await explainDigestAreaText(db, id, area.id, provider, { job, language });
    parts.push({ part: `area:${area.id}`, ...r });
  }
  finishJob(db, digestJobId);

  let coverageRepairs = 0;
  for (const area of areas) {
    const wJobId = startJob(db, 'area', { changeUnitId: id, areaId: area.id }, BUDGET);
    let chunks = 0;
    const r = await explainArea(db, id, area.id, provider, { job: { jobId: wJobId, budget: BUDGET }, language, onProgress: () => chunks++ });
    parts.push({ part: `walkthrough:${area.id}`, ...r });
    finishJob(db, wJobId);
    const row = db.prepare('SELECT content FROM area_explanation WHERE change_unit_id = ? AND area_id = ?').get(id, area.id);
    const content = JSON.parse(row.content);
    if (content.steps.some((s) => s.title === 'Other changes' || s.title === '기타 변경')) coverageRepairs++;
    parts[parts.length - 1].onProgressChunks = chunks;
  }

  const firstTry = parts.filter((p) => (p.outcome === 'ok' || p.outcome === 'truncated') && p.calls === 1).length;
  const attempted = parts.filter((p) => p.outcome !== 'cached').length;
  const tokenRows = db.prepare('SELECT input_tokens, output_tokens FROM explain_call WHERE job_id IS NOT NULL').all();
  const totalTokens = tokenRows.reduce((n, r) => n + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
  const lint = lintDb(db);

  return {
    language, combo: comboName,
    baseline: { outcome: baseline.outcome, calls: baseline.calls, ms: baselineMs },
    parts: parts.map(({ part, outcome, calls, onProgressChunks }) => ({ part, outcome, calls, onProgressChunks })),
    firstTryPassRate: attempted === 0 ? null : firstTry / attempted,
    coverageRepairRate: areas.length === 0 ? null : coverageRepairs / areas.length,
    totalTokens,
    aiTellHits: lint.counts.total,
    timing: timingReport(db),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const real = args.includes('--real');
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : join(here, '../../../.cache/DIG-74-acceptance');
  mkdirSync(outDir, { recursive: true });

  const combos = real
    ? FLAG_SETS.flatMap((f) => SUMMARY_MODELS.map((m) => ({
        name: `${f.name}_${m.name}`,
        cheapRun: f.cheapRun,
        tasks: { ...m.tasks, ...FIXED_TASKS },
      })))
    : [{ name: 'stub-dry-run', cheapRun: {}, tasks: {} }];

  const results = [];
  for (const language of LANGUAGES) {
    for (const combo of combos) {
      const provider = real
        ? new ClaudeCodeProvider({
            bin: process.env.DIGESTIT_CLAUDE_BIN, model: process.env.DIGESTIT_CLAUDE_MODEL, timeoutMs: 600_000,
            cheapRun: combo.cheapRun, tasks: combo.tasks,
          })
        : new StubProvider();
      console.log(`--- ${language} / ${combo.name} (${provider.id}) ---`);
      const r = await runCombo(provider, language, combo.name);
      results.push(r);
      console.log(`  baseline (legacy one-call digest): ${r.baseline.outcome}, ${r.baseline.calls} call(s), ${r.baseline.ms}ms`);
      console.log(`  parts: ${r.parts.map((p) => `${p.part}=${p.outcome}(${p.calls})`).join(', ')}`);
      console.log(`  first-try pass rate: ${r.firstTryPassRate === null ? 'n/a' : (r.firstTryPassRate * 100).toFixed(0) + '%'}`);
      console.log(`  walkthrough coverage-repair rate: ${r.coverageRepairRate === null ? 'n/a' : (r.coverageRepairRate * 100).toFixed(0) + '%'}`);
      console.log(`  total tokens (split parts + walkthroughs): ${r.totalTokens}`);
      console.log(`  AI-tell hits: ${r.aiTellHits}`);
      console.log(formatTimingReport(r.timing).split('\n').map((l) => `  ${l}`).join('\n'));
    }
  }

  const outFile = join(outDir, `${real ? 'real' : 'dry-run'}.json`);
  writeFileSync(outFile, JSON.stringify(results, null, 1) + '\n');
  console.log(`\nwrote ${outFile}`);
}

await main();
