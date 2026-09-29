import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type {
  AreaWalkthrough, DigestL2Content, ExplainLanguage, L0Content, L1Content, ProjectContextContent,
} from '@digestit/core';
import { aiTellHits, repeatedOpenerCount } from './tells.js';

/** One AI-tell hit, tagged with the surface it came from, for the report's per-rule/per-level counts. */
export interface LevelHit {
  level: 'l0' | 'l1' | 'l2' | 'l3' | 'context';
  ruleId: string;
}

export interface LintCounts {
  total: number;
  byRule: Record<string, number>;
  byLevel: Record<string, number>;
}

export function aggregateHits(hits: readonly LevelHit[]): LintCounts {
  const byRule: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  for (const h of hits) {
    byRule[h.ruleId] = (byRule[h.ruleId] ?? 0) + 1;
    byLevel[h.level] = (byLevel[h.level] ?? 0) + 1;
  }
  return { total: hits.length, byRule, byLevel };
}

function fieldHits(level: LevelHit['level'], text: string, language: ExplainLanguage): LevelHit[] {
  return aiTellHits(text, language).map((h) => ({ level, ruleId: h.id }));
}

/** Every AI-tell hit across one digest's L0, L1 bullets and L2 area fields. */
export function lintDigestLevels(l0: L0Content, l1: L1Content, l2: DigestL2Content, language: ExplainLanguage): LevelHit[] {
  const hits: LevelHit[] = [...fieldHits('l0', l0.text, language)];
  for (const b of l1.bullets) hits.push(...fieldHits('l1', b, language));
  for (const it of l2.items) {
    hits.push(...fieldHits('l2', it.title, language));
    hits.push(...fieldHits('l2', it.effect, language));
    hits.push(...fieldHits('l2', it.how, language));
    hits.push(...fieldHits('l2', it.why, language));
  }
  return hits;
}

/** Every AI-tell hit across one area's overview, step titles/bodies and check items. */
export function lintAreaWalkthrough(w: AreaWalkthrough, language: ExplainLanguage): LevelHit[] {
  const hits: LevelHit[] = [...fieldHits('l3', w.overview, language)];
  for (const s of w.steps) {
    hits.push(...fieldHits('l3', s.title, language));
    hits.push(...fieldHits('l3', s.body, language));
  }
  for (const c of w.check) hits.push(...fieldHits('l3', c, language));
  return hits;
}

/** Every AI-tell hit across one project context's purpose, module roles, glossary and conventions. */
export function lintProjectContext(c: ProjectContextContent, language: ExplainLanguage): LevelHit[] {
  const hits: LevelHit[] = [...fieldHits('context', c.purpose, language)];
  for (const m of c.modules) hits.push(...fieldHits('context', m.role, language));
  for (const g of c.glossary) {
    hits.push(...fieldHits('context', g.term, language));
    hits.push(...fieldHits('context', g.meaning, language));
  }
  for (const conv of c.conventions) hits.push(...fieldHits('context', conv, language));
  return hits;
}

export interface LintReport {
  counts: LintCounts;
  /** Report-only (DIG-65 step 5): area overviews sharing an opener with another in the same digest. */
  repeatedOpeners: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Runs the AI-tell lint over every stored digest (L0-L2), area walkthrough
 * (L3) and project context row in `db`. Each prompt version's rows are linted
 * as their own set, so a digest explained under d2 and d3 counts twice and
 * never mixes levels across versions. Error rows (empty content) are skipped.
 */
export function lintDb(db: DatabaseSync): LintReport {
  const hits: LevelHit[] = [];
  let repeatedOpeners = 0;

  const digestLanguage = new Map<number, ExplainLanguage>(
    (db.prepare('SELECT change_unit_id, language FROM digest').all() as { change_unit_id: number; language: ExplainLanguage }[])
      .map((r) => [r.change_unit_id, r.language]),
  );

  const explanationRows = db.prepare(
    `SELECT e.change_unit_id, e.level, e.content, e.prompt_version FROM explanation e
       JOIN change_unit cu ON cu.id = e.change_unit_id
      WHERE cu.kind = 'digest' AND e.level IN (0, 1, 2) AND e.status IN ('ok', 'truncated')`,
  ).all() as { change_unit_id: number; level: number; content: string; prompt_version: string }[];
  const byUnit = new Map<string, { changeUnitId: number; l0?: L0Content; l1?: L1Content; l2?: DigestL2Content }>();
  for (const r of explanationRows) {
    const key = `${r.change_unit_id}:${r.prompt_version}`;
    const entry = byUnit.get(key) ?? { changeUnitId: r.change_unit_id };
    const parsed = JSON.parse(r.content) as unknown;
    if (r.level === 0) entry.l0 = parsed as L0Content;
    else if (r.level === 1) entry.l1 = parsed as L1Content;
    else if (r.level === 2) entry.l2 = parsed as DigestL2Content;
    byUnit.set(key, entry);
  }
  for (const entry of byUnit.values()) {
    if (!entry.l0 || !entry.l1 || !entry.l2) continue;
    const language = digestLanguage.get(entry.changeUnitId) ?? 'en';
    hits.push(...lintDigestLevels(entry.l0, entry.l1, entry.l2, language));
  }

  const areaRows = db.prepare(
    "SELECT change_unit_id, content, prompt_version FROM area_explanation WHERE status IN ('ok', 'truncated')",
  ).all() as { change_unit_id: number; content: string; prompt_version: string }[];
  const overviewsByUnit = new Map<string, string[]>();
  for (const r of areaRows) {
    const language = digestLanguage.get(r.change_unit_id) ?? 'en';
    const content = JSON.parse(r.content) as AreaWalkthrough;
    hits.push(...lintAreaWalkthrough(content, language));
    const key = `${r.change_unit_id}:${r.prompt_version}`;
    if (content.overview !== '') overviewsByUnit.set(key, [...(overviewsByUnit.get(key) ?? []), content.overview]);
  }
  for (const overviews of overviewsByUnit.values()) repeatedOpeners += repeatedOpenerCount(overviews);

  const repoLanguage = new Map<number, ExplainLanguage>(
    (db.prepare('SELECT id, language FROM repo').all() as { id: number; language: ExplainLanguage }[]).map((r) => [r.id, r.language]),
  );
  const contextRows = db.prepare("SELECT repo_id, content FROM project_context WHERE status IN ('ok', 'truncated')").all() as { repo_id: number; content: string }[];
  for (const r of contextRows) {
    const language = repoLanguage.get(r.repo_id) ?? 'en';
    hits.push(...lintProjectContext(JSON.parse(r.content) as ProjectContextContent, language));
  }

  return { counts: aggregateHits(hits), repeatedOpeners };
}

/** The shape of `packages/explain/test/golden/walkthrough-snapback.sample.*.json`. */
export interface WalkthroughGolden {
  language: ExplainLanguage;
  digest: { l0: L0Content; l1: L1Content; l2: DigestL2Content };
  areas: { id: string; walkthrough: AreaWalkthrough }[];
}

export function lintGolden(golden: WalkthroughGolden): LintReport {
  const hits = [...lintDigestLevels(golden.digest.l0, golden.digest.l1, golden.digest.l2, golden.language)];
  for (const area of golden.areas) hits.push(...lintAreaWalkthrough(area.walkthrough, golden.language));
  const overviews = golden.areas.map((a) => a.walkthrough.overview).filter((o) => o !== '');
  return { counts: aggregateHits(hits), repeatedOpeners: repeatedOpenerCount(overviews) };
}

function printReport(label: string, report: LintReport): void {
  console.log(`${label}: ${report.counts.total} AI-tell hit(s), ${report.repeatedOpeners} repeated area-overview opener(s)`);
  if (report.counts.total > 0) {
    console.log('  by level:');
    for (const [level, n] of Object.entries(report.counts.byLevel).sort(([, a], [, b]) => b - a)) console.log(`    ${level}: ${n}`);
    console.log('  by rule:');
    for (const [rule, n] of Object.entries(report.counts.byRule).sort(([, a], [, b]) => b - a)) console.log(`    ${rule}: ${n}`);
  }
}

export const LINT_REPORT_USAGE = `usage: digest-explain lint-report --db <file> | --golden <file,...>
  --db <file>          sqlite file to scan (explanation, area_explanation, project_context)
  --golden <file,...>  golden JSON fixture(s) in the walkthrough-snapback.sample shape`;

/** Runs `digest-explain lint-report`; argv excludes node, script and the `lint-report` subcommand. Returns the exit code. */
export async function runLintReportCli(argv: string[]): Promise<number> {
  const dbArgIndex = argv.indexOf('--db');
  const goldenArgIndex = argv.indexOf('--golden');
  if (dbArgIndex === -1 && goldenArgIndex === -1) {
    console.error(LINT_REPORT_USAGE);
    return 2;
  }
  if (dbArgIndex !== -1) {
    const path = argv[dbArgIndex + 1];
    if (!path) {
      console.error(LINT_REPORT_USAGE);
      return 2;
    }
    // Read-only: a report must not migrate or otherwise write to the file it scans.
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      printReport(path, lintDb(db));
    } finally {
      db.close();
    }
  }
  if (goldenArgIndex !== -1) {
    const arg = argv[goldenArgIndex + 1];
    if (!arg) {
      console.error(LINT_REPORT_USAGE);
      return 2;
    }
    for (const path of arg.split(',')) {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isObj(raw) || !isObj(raw.digest) || !Array.isArray(raw.areas)) {
        console.error(`${path}: not a walkthrough-snapback-shaped golden file`);
        return 2;
      }
      printReport(path, lintGolden(raw as unknown as WalkthroughGolden));
    }
  }
  return 0;
}
