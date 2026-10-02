// DIG-107 memory A/B kit (docs/milestone-4-memory.md §6): replays a synthetic multi-day story
// (fixtures/memory-ab-story.mjs) and the last 5 digests of this repo's own history through the
// real Explain job runner (packages/ingest, DIG-100/101/103's memory wiring) twice per digest --
// memory on and memory off -- in en and ko, and writes blinded L0/L1/L2(+one walkthrough) pairs,
// the A/B key, a reader sheet and automatic metrics.
//
// This lives in packages/ingest/test/, not packages/explain/test/ like DIG-74's ab-kit.mjs: the
// memory retrieval this kit measures is wired into `ExplainJobRunner` (DIG-103), which packages/
// explain does not depend on, so driving the real pipeline means driving it from here.
//
// "Memory off" uses `DIGESTIT_MEMORY_TEST_OFF`, a test-only switch on `ExplainJobRunner`'s private
// `loadMemoryContext` (packages/ingest/src/explain-job.ts): when set, every part of every job sees
// an empty memory store, so `selectMemory` (still a pure function, untouched) is always given no
// items and returns an empty slice. Same job runner, same prompts, same provider/model/effort in
// both arms -- memory retrieval is the only thing that differs. Never set this outside a kit run.
//
// Dry run (stub provider, no network, deterministic -- what this repo's tests/CI can run; the
// default, `--dry-run` is accepted too):
//   pnpm -r build && node packages/ingest/test/memory-ab-kit.mjs [--dry-run]
// Real provider (the operator runs this; needs a logged-in `claude` CLI, which the sandbox this
// kit was written in does not have):
//   pnpm -r build && node packages/ingest/test/memory-ab-kit.mjs --real
// Results are written under .cache/DIG-107-acceptance/ (gitignored); override with --out <dir>.
// `--scenario snapback|history` and `--languages en,ko` narrow a run (mainly for fast iteration).
//
// DIG-114 (round 2): each pair file ends with the project memory the on arm was sent for that digest
// (memory-ab-render.mjs), so the reader can tell a supported continuity claim from an invented one;
// `promptTokens*` count the whole prompt (cache tokens included, `explain_call.prompt_tokens`); and
// `violations` per arm break the validator's findings down by rule, to explain first-try gaps.
//
// DIG-118 (round 2 follow-up): `violations.byKind` further splits those findings into hard
// violations and style warnings (DIG-94: both cause a retry) versus in-band length notes (never a
// retry), so a lower first-try rate is traceable to a kind, not just a rule name (both "limit" and
// "target" messages blank to the same rule string once their numbers are stripped). Each pipeline's
// sqlite connection is closed as soon as its metrics are read, and `rmSync` below gets Node's own
// retry, so a trailing WAL/SHM write under a memory-on `home` no longer races the final cleanup
// into ENOTEMPTY.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@digestit/core';
import {
  ClaudeCodeProvider, StubProvider, identifiersInDiff, lintDb, loadChange, redact,
} from '@digestit/explain';
import {
  ExplainJobRunner, createBatch, explainProject, finishBatch, initProject, latestCheckpoint,
  listMemoryItems, listProjects, updateProjectMemory, upsertMemoryItem,
} from '@digestit/ingest';
import { SNAPBACK_INIT, SNAPBACK_STORY } from './fixtures/memory-ab-story.mjs';
import {
  READER_SHEET, loadDigestMemory, mergeViolationCounts, promptTokenTotal, renderPair, violationCounts,
} from './memory-ab-render.mjs';
import { closeDbs, removeScratchDirs } from './scratch-cleanup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LANGUAGES = ['en', 'ko'];
const ARMS = ['on', 'off'];
const BUDGET = 100_000; // high enough that the kit itself is never budget-limited
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DIGEST_COUNT = 5;

// ---------------------------------------------------------------------------
// scratch project filesystem helpers
// ---------------------------------------------------------------------------

function writeFiles(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A `now()` that lands on `targetIso` right away but keeps advancing at the real wall-clock rate
 * from there (a fixed offset, not a frozen instant). `job.now` is both the timestamp recorded on
 * checkpoint/digest/explain_call rows and, in `explainDigestSummary` and friends, the clock a
 * call's own duration is measured against (`now().getTime() - at.getTime()`); a frozen clock would
 * report every call as instant, zeroing out `l0TimeMsP50` and every other timing metric even under
 * `--real`.
 */
function clockAt(targetIso) {
  const offsetMs = new Date(targetIso).getTime() - Date.now();
  return () => new Date(Date.now() + offsetMs);
}

/**
 * The last `HISTORY_DIGEST_COUNT` commits on this repo's current branch that each actually change
 * the tree, oldest first, plus the commit right before the oldest of them as the replay's baseline
 * checkpoint. A commit whose tree matches its predecessor's (a no-op merge is the common case --
 * this repo's own history has one right where a first naive "last 5 commits" would have landed) is
 * skipped: `prepareExplainDigest`'s snapshot would call it `unchanged` and produce no digest in
 * production either, so counting it here would silently short the story below 5 real digests.
 * Reads only shas/dates/trees, from one throwaway local clone (no network) so the kit never
 * touches the worktree it runs from; each pipeline gets its own separate clone (`historySteps`) to
 * check out into, so four pipelines never share or race on one working tree.
 */
function buildHistoryScenario() {
  const repoRoot = git(['rev-parse', '--show-toplevel'], here);
  const probeDir = mkdtempSync(join(tmpdir(), 'digestit-ab-history-probe-'));
  git(['clone', '--quiet', '--no-hardlinks', repoRoot, probeDir]);
  const rawLogLimit = HISTORY_DIGEST_COUNT * 4; // generous cushion against no-op merges
  const log = git(['log', '-n', String(rawLogLimit), '--format=%H%x09%cI%x09%s', '--reverse', 'HEAD'], probeDir);
  const raw = log.split('\n').filter(Boolean).map((line) => {
    const [sha, at, ...subjectParts] = line.split('\t');
    return { sha, at, subject: subjectParts.join('\t') };
  });
  if (raw.length === 0) throw new Error('no commits found for the history scenario');
  const baselineSha = git(['rev-parse', `${raw[0].sha}^`], probeDir);
  const baselineAt = git(['log', '-1', '--format=%cI', baselineSha], probeDir);
  const tree = (sha) => git(['rev-parse', `${sha}^{tree}`], probeDir);

  const commits = [];
  let prevTree = tree(baselineSha);
  for (const c of raw) {
    if (commits.length >= HISTORY_DIGEST_COUNT) break;
    const t = tree(c.sha);
    if (t === prevTree) continue;
    commits.push(c);
    prevTree = t;
  }
  if (commits.length < HISTORY_DIGEST_COUNT) {
    throw new Error(`only found ${commits.length} tree-changing commit(s) in the last ${rawLogLimit}; raise HISTORY_DIGEST_COUNT's search window`);
  }
  rmSync(probeDir, { recursive: true, force: true });
  return { repoRoot, baseline: { sha: baselineSha, at: baselineAt }, commits };
}

// ---------------------------------------------------------------------------
// story/history -> a uniform list of steps: {kind: 'init'|'files'|'note', at, message, ...}
// ---------------------------------------------------------------------------

function snapbackSteps(now) {
  const day = (offset) => new Date(now.getTime() + offset * DAY_MS).toISOString();
  return {
    init: { at: day(SNAPBACK_INIT.dayOffset), write: SNAPBACK_INIT.write },
    steps: SNAPBACK_STORY.map((s) => ({ ...s, at: day(s.dayOffset) })),
  };
}

/** Clones fresh into `projectDir` and checks out the baseline commit; each returned step's
 * `apply()` checks out the next commit in place, closing over this same `projectDir`. */
function historySteps(history, projectDir) {
  git(['clone', '--quiet', '--no-hardlinks', history.repoRoot, projectDir]);
  git(['checkout', '--quiet', '--force', history.baseline.sha], projectDir);
  const init = { at: history.baseline.at };
  const steps = history.commits.map((c) => ({
    kind: 'files', at: c.at, message: `${c.sha.slice(0, 12)}: ${c.subject}`,
    apply: () => git(['checkout', '--quiet', '--force', c.sha], projectDir),
  }));
  return { init, steps };
}

// ---------------------------------------------------------------------------
// one (scenario, arm, language) replay
// ---------------------------------------------------------------------------

function knownTermsOf(items) {
  return [
    ...items.filter((it) => it.kind === 'term').map((it) => it.content.term),
    ...items.filter((it) => it.kind === 'area').flatMap((it) => it.content.exports.map((e) => e.name)),
  ];
}

function applyNote(db, repoId, step, now) {
  const checkpoint = latestCheckpoint(db, repoId);
  const content = { kind: 'note', text: redact(step.text), target: step.target, origin: 'correction' };
  const batchId = createBatch(db, repoId, 'user', checkpoint?.id ?? null, now);
  upsertMemoryItem(
    db, batchId, repoId, 'note', `correction-${step.target.kind}-${step.target.key}`, null, content, 'user',
    { files: [], checkpointId: checkpoint?.id ?? null, digestIds: [], jobId: null }, now,
  );
  finishBatch(db, batchId, 0, now);
}

function pickWalkthroughAreaId(db, changeUnitId) {
  const row = db.prepare('SELECT areas FROM digest WHERE change_unit_id = ?').get(changeUnitId);
  const areas = row?.areas ? JSON.parse(row.areas) : [];
  if (areas.length === 0) return null;
  return [...areas].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions) || (a.id < b.id ? -1 : 1))[0].id;
}

function loadDigestContent(db, changeUnitId) {
  const rows = db.prepare('SELECT level, content FROM explanation WHERE change_unit_id = ? AND level IN (0, 1, 2)').all(changeUnitId);
  const byLevel = Object.fromEntries(rows.map((r) => [r.level, JSON.parse(r.content)]));
  return { l0: byLevel[0] ?? null, l1: byLevel[1] ?? null, l2: byLevel[2] ?? null };
}

function loadWalkthrough(db, changeUnitId, areaId) {
  if (!areaId) return null;
  const row = db.prepare('SELECT content FROM area_explanation WHERE change_unit_id = ? AND area_id = ?').get(changeUnitId, areaId);
  return row ? JSON.parse(row.content) : null;
}

/**
 * Replays one scenario's steps under one arm/language into a fresh scratch `DIGESTIT_HOME` and
 * project folder. `arm === 'off'` sets `DIGESTIT_MEMORY_TEST_OFF` for every explain/area call in
 * this pipeline and skips the deterministic memory update and the correction note -- there would
 * be nothing to update or correct, since retrieval never reads it.
 */
async function runPipeline(scenarioName, arm, language, projectDir, init, steps, provider, scratchDirs) {
  const home = mkdtempSync(join(tmpdir(), `digestit-ab-home-${scenarioName}-${arm}-${language}-`));
  scratchDirs.push(home);
  const db = openDb(join(home, 'digestit.sqlite'));
  const memoryOn = arm === 'on';

  if (init.write) writeFiles(projectDir, init.write);
  const initResult = await initProject(
    db, home, projectDir, { name: `${scenarioName}-${arm}-${language}`, language }, clockAt(init.at),
  );
  const repoId = initResult.repoId;
  const runner = new ExplainJobRunner(db, home, { budget: BUDGET });
  // A running server's memory worker does its first daily sweep on the first idle tick after a
  // project is added (lastDailySweepDate starts empty), so by the first Explain the store already
  // holds the baseline's areas and terms. Mirror that, or the on arm's first digest sees no memory.
  if (memoryOn) {
    const added = listProjects(db).find((p) => p.id === repoId);
    await updateProjectMemory(db, home, added, 'daily', clockAt(init.at));
  }

  const digests = [];
  const prevOff = process.env.DIGESTIT_MEMORY_TEST_OFF;
  if (memoryOn) delete process.env.DIGESTIT_MEMORY_TEST_OFF;
  else process.env.DIGESTIT_MEMORY_TEST_OFF = '1';
  try {
    for (const step of steps) {
      const now = clockAt(step.at);
      if (step.kind === 'note') {
        if (memoryOn) applyNote(db, repoId, step, now);
        continue;
      }
      if (step.write) writeFiles(projectDir, step.write);
      if (step.apply) step.apply();

      const project = listProjects(db).find((p) => p.id === repoId);
      const knownTermsSnapshot = memoryOn ? knownTermsOf(listMemoryItems(db, repoId)) : [];
      const r = await explainProject(db, home, project, provider, { budget: BUDGET, now });
      if (r.noChanges) continue;

      const files = loadChange(db, r.digestId)?.files ?? [];
      const areaId = pickWalkthroughAreaId(db, r.digestId);
      let walkthroughOutcome = null;
      if (areaId) {
        const started = await runner.startArea(project, r.digestId, areaId, provider);
        walkthroughOutcome = started.settled ? await started.settled : null;
      }
      if (memoryOn) await updateProjectMemory(db, home, project, 'after-explain', now);

      const content = loadDigestContent(db, r.digestId);
      const createdAt = db.prepare('SELECT created_at AS at FROM digest WHERE change_unit_id = ?').get(r.digestId).at;
      digests.push({
        step, changeUnitId: r.digestId, report: r.report, walkthroughOutcome, files, knownTermsSnapshot, areaId, createdAt,
        ...content, walkthrough: loadWalkthrough(db, r.digestId, areaId),
        memory: loadDigestMemory(db, r.digestId),
      });
    }
  } finally {
    if (prevOff === undefined) delete process.env.DIGESTIT_MEMORY_TEST_OFF;
    else process.env.DIGESTIT_MEMORY_TEST_OFF = prevOff;
  }
  return { db, home, projectDir, repoId, digests };
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function pipelineMetrics(pipeline) {
  const { db, digests } = pipeline;
  let attempted = 0;
  let firstTry = 0;
  for (const d of digests) {
    for (const p of d.report?.parts ?? []) {
      attempted++;
      if ((p.status === 'ok' || p.status === 'truncated') && p.calls === 1) firstTry++;
    }
    if (d.walkthroughOutcome) {
      attempted++;
      if ((d.walkthroughOutcome.outcome === 'ok' || d.walkthroughOutcome.outcome === 'truncated') && d.walkthroughOutcome.calls === 1) firstTry++;
    }
  }
  const lint = lintDb(db);
  const dateViolations = db.prepare("SELECT count(*) AS n FROM explain_call WHERE violations LIKE '%date/weekday%'").get().n;
  const promptTokens = promptTokenTotal(db);
  const callCount = db.prepare('SELECT count(*) AS n FROM explain_call').get().n;
  // Sanity check that the arms really differ: the on arm writes a memory_use row per part that got a
  // non-empty slice, the off arm must write none.
  const memoryUseRows = db.prepare('SELECT count(*) AS n FROM memory_use').get().n;
  const durations = db.prepare("SELECT duration_ms AS ms FROM explain_call WHERE part = 'summary' AND outcome = 'ok' ORDER BY ms")
    .all().map((r) => r.ms);
  return {
    digestCount: digests.length,
    explainCallCount: callCount,
    memoryUseRows,
    firstTryPassRate: attempted === 0 ? null : firstTry / attempted,
    aiTellHits: lint.counts.total,
    dateCheckViolations: dateViolations,
    promptTokensTotal: promptTokens,
    promptTokensPerDigest: digests.length === 0 ? null : promptTokens / digests.length,
    // digests whose on-arm prompts carried a <memory> block at all (an empty slice sends none)
    digestsWithMemory: digests.filter((d) => d.memory.length > 0).length,
    violations: violationCounts(db),
    l0TimeMsP50: percentile(durations, 50),
    // raw inputs for the per-arm rollup in main(), which pools these rather than averaging rates
    attemptedParts: attempted,
    firstTryParts: firstTry,
    l0DurationsMs: durations,
  };
}

/** Share of diff identifiers (matched against the memory-on arm's known terms at explain time --
 * the off arm has none of its own, so it borrows the on arm's as the yardstick) that show up
 * verbatim in each arm's own rendered text, for one scenario/language pair's digests. */
function termCoverage(onPipeline, offPipeline) {
  const wordBoundary = (text, word) => new RegExp(`(?:^|[^A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z0-9_]|$)`).test(text);
  const textOf = (d) => {
    if (!d.l0 || !d.l1 || !d.l2) return '';
    const l2 = d.l2.items.flatMap((it) => [it.title, it.effect, it.how, it.why]).join(' ');
    return [d.l0.text, ...d.l1.bullets, l2].join(' ');
  };
  let identifiers = 0;
  let onHits = 0;
  let offHits = 0;
  for (let i = 0; i < onPipeline.digests.length && i < offPipeline.digests.length; i++) {
    const onDigest = onPipeline.digests[i];
    const offDigest = offPipeline.digests[i];
    const found = identifiersInDiff(onDigest.files, onDigest.knownTermsSnapshot);
    if (found.length === 0) continue;
    const onText = textOf(onDigest);
    const offText = textOf(offDigest);
    for (const id of found) {
      identifiers++;
      if (wordBoundary(onText, id)) onHits++;
      if (wordBoundary(offText, id)) offHits++;
    }
  }
  return {
    sampledIdentifiers: identifiers,
    on: identifiers === 0 ? null : onHits / identifiers,
    off: identifiers === 0 ? null : offHits / identifiers,
  };
}

// ---------------------------------------------------------------------------
// blinded pairs
// ---------------------------------------------------------------------------

function shuffleAB(memoryOnDigest, memoryOffDigest) {
  const onIsA = Math.random() < 0.5;
  return onIsA
    ? { A: 'on', B: 'off', versionA: memoryOnDigest, versionB: memoryOffDigest }
    : { A: 'off', B: 'on', versionA: memoryOffDigest, versionB: memoryOnDigest };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const real = argv.includes('--real');
  if (real && argv.includes('--dry-run')) throw new Error('pass only one of --real or --dry-run');
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : join(here, '../../../.cache/DIG-107-acceptance');
  const scenarioIdx = argv.indexOf('--scenario');
  const scenarios = scenarioIdx >= 0 ? [argv[scenarioIdx + 1]] : ['snapback', 'history'];
  const langIdx = argv.indexOf('--languages');
  const languages = langIdx >= 0 ? argv[langIdx + 1].split(',') : LANGUAGES;
  return { real, out, scenarios, languages };
}

function makeProvider(real) {
  return real
    ? new ClaudeCodeProvider({ bin: process.env.DIGESTIT_CLAUDE_BIN, model: process.env.DIGESTIT_CLAUDE_MODEL, timeoutMs: 600_000 })
    : new StubProvider();
}

async function main() {
  const { real, out, scenarios, languages } = parseArgs(process.argv.slice(2));
  const now = new Date();
  mkdirSync(out, { recursive: true });
  const pairsDir = join(out, 'pairs');
  mkdirSync(pairsDir, { recursive: true });
  const scratchDirs = [];

  const history = scenarios.includes('history') ? buildHistoryScenario() : null;

  const metrics = { generatedAt: now.toISOString(), real, scenarios, languages, byScenarioLanguageArm: [], byArm: {}, termCoverage: [] };
  const key = {};
  const l0Durations = { on: [], off: [] };

  for (const scenarioName of scenarios) {
    for (const language of languages) {
      const pipelines = {};
      for (const arm of ARMS) {
        console.log(`--- ${scenarioName} / ${language} / memory-${arm} ---`);
        const provider = makeProvider(real);
        const projectDir = mkdtempSync(join(tmpdir(), `digestit-ab-proj-${scenarioName}-${arm}-${language}-`));
        scratchDirs.push(projectDir);
        const { init, steps } = scenarioName === 'snapback' ? snapbackSteps(now) : historySteps(history, projectDir);
        const pipeline = await runPipeline(scenarioName, arm, language, projectDir, init, steps, provider, scratchDirs);
        pipelines[arm] = pipeline;
        const { l0DurationsMs, ...m } = pipelineMetrics(pipeline);
        // Closes the WAL/SHM files a running sqlite connection keeps open under `home`, before the
        // cleanup pass at the end removes that directory (DIG-118 item 4, see scratch-cleanup.mjs):
        // nothing below this point reads `pipeline.db` again (the pair files already captured what
        // they need in `digests`), so this is the earliest safe point, not just the latest.
        closeDbs([pipeline.db]);
        l0Durations[arm].push(...l0DurationsMs);
        metrics.byScenarioLanguageArm.push({ scenario: scenarioName, language, arm, ...m });
        console.log(`  digests: ${m.digestCount}, first-try pass rate: ${m.firstTryPassRate === null ? 'n/a' : (m.firstTryPassRate * 100).toFixed(0) + '%'}, AI-tell hits: ${m.aiTellHits}, date-check violations: ${m.dateCheckViolations}`);
      }

      const coverage = termCoverage(pipelines.on, pipelines.off);
      metrics.termCoverage.push({ scenario: scenarioName, language, ...coverage });

      const count = Math.min(pipelines.on.digests.length, pipelines.off.digests.length);
      for (let i = 0; i < count; i++) {
        const onDigest = pipelines.on.digests[i];
        const offDigest = pipelines.off.digests[i];
        const digestKey = `${scenarioName}-${language}-${String(i + 1).padStart(2, '0')}`;
        const shuffled = shuffleAB(onDigest, offDigest);
        key[digestKey] = { A: shuffled.A, B: shuffled.B, message: onDigest.step.message ?? onDigest.step.kind };
        const md = renderPair(
          `${digestKey}: ${onDigest.step.message ?? ''}`, shuffled.versionA, shuffled.versionB, onDigest.memory, onDigest.createdAt,
        );
        writeFileSync(join(pairsDir, `${digestKey}.md`), md);
      }
    }
  }

  for (const arm of ARMS) {
    const rows = metrics.byScenarioLanguageArm.filter((r) => r.arm === arm);
    const digestCount = rows.reduce((n, r) => n + r.digestCount, 0);
    const attemptedParts = rows.reduce((n, r) => n + r.attemptedParts, 0);
    const firstTryParts = rows.reduce((n, r) => n + r.firstTryParts, 0);
    metrics.byArm[arm] = {
      digestCount,
      explainCallCount: rows.reduce((n, r) => n + r.explainCallCount, 0),
      memoryUseRows: rows.reduce((n, r) => n + r.memoryUseRows, 0),
      firstTryPassRate: attemptedParts === 0 ? null : firstTryParts / attemptedParts,
      aiTellHits: rows.reduce((n, r) => n + r.aiTellHits, 0),
      dateCheckViolations: rows.reduce((n, r) => n + r.dateCheckViolations, 0),
      promptTokensTotal: rows.reduce((n, r) => n + r.promptTokensTotal, 0),
      promptTokensPerDigest: digestCount === 0 ? null : rows.reduce((n, r) => n + r.promptTokensTotal, 0) / digestCount,
      l0TimeMsP50: percentile([...l0Durations[arm]].sort((a, b) => a - b), 50),
      digestsWithMemory: rows.reduce((n, r) => n + r.digestsWithMemory, 0),
      violations: mergeViolationCounts(rows.map((r) => r.violations)),
    };
  }

  metrics.totalExplainCalls = metrics.byArm.on.explainCallCount + metrics.byArm.off.explainCallCount;
  metrics.expectedCallsNote =
    'totalExplainCalls is this dry run\'s own call count (one row per provider attempt, so a retried '
    + 'part counts twice); --real makes the same shape of calls per digest (one summary + one call per '
    + 'area + one walkthrough, plus one context call on each pipeline\'s first digest), occasionally '
    + 'one extra call when the validator asks for a retry.';

  writeFileSync(join(out, 'metrics.json'), JSON.stringify(metrics, null, 1) + '\n');
  writeFileSync(join(out, 'key.json'), JSON.stringify(key, null, 1) + '\n');
  writeFileSync(join(out, 'reader-sheet.md'), READER_SHEET);

  removeScratchDirs(scratchDirs);

  console.log(`\nwrote ${out}/metrics.json, key.json, reader-sheet.md and ${Object.keys(key).length} blinded pair(s) under ${pairsDir}/`);
  for (const arm of ARMS) {
    const { violations, ...rest } = metrics.byArm[arm];
    console.log(`memory ${arm}: ${JSON.stringify(rest)}`);
    console.log(`  validator findings: ${violations.callsWithViolations} call(s), by part ${JSON.stringify(violations.byPart)}`);
    // DIG-118 item 2: hard violations and style warnings both cause a retry (DIG-94); length notes
    // never do. Split so a lower first-try rate is traceable to its kind without opening the DB.
    console.log(`  by kind: violation ${violations.byKind.violation.messages}, style ${violations.byKind.style.messages}, note ${violations.byKind.note.messages}, unknown ${violations.byKind.unknown.messages}`);
  }
}

await main();
