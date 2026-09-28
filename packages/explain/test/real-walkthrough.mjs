// Real-provider sample for the L3 walkthrough (DIG-48): explains the walkthrough-snapback fixture
// (a digest, then every area's walkthrough) in each given language, and writes
// test/golden/walkthrough-snapback.claude.<lang>.json. area.test.ts checks those goldens against the
// validators when they exist.
//
// Needs a logged-in `claude` CLI and sends the fixture diff (a synthetic project, no real code) to
// Anthropic through the claude-code provider:
//   pnpm -r build && node packages/explain/test/real-walkthrough.mjs en ko
// Set DIGESTIT_CLAUDE_BIN / DIGESTIT_CLAUDE_MODEL to pick the binary and model.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@digestit/core';
import { ClaudeCodeProvider, explainArea, explainDigest } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE = join(here, 'fixtures/walkthrough-snapback.json');

/** Runs the digest and every area walkthrough for one language; returns what the dashboard would store. */
export async function runSample(provider, language, log = console.log) {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const db = openDb(':memory:');
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, ?, '/project')").run(fixture.repoName);
  const id = Number(db.prepare("INSERT INTO change_unit (repo_id, kind, head_sha, title) VALUES (1, 'digest', 'shadow', 'digest')").run().lastInsertRowid);
  for (const f of fixture.files) {
    db.prepare('INSERT INTO file_change (change_unit_id, path, status, additions, deletions, patch) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, f.path, f.status, f.additions, f.deletions, f.patch);
  }
  const digest = await explainDigest(db, id, provider, { budget: 100, language });
  log(language, 'digest', digest.outcome, digest.calls, digest.detail ?? '');
  const levels = Object.fromEntries(
    db.prepare('SELECT level, content FROM explanation').all().map((r) => [r.level, JSON.parse(r.content)]),
  );
  const areas = [];
  for (const item of levels[2]?.items ?? []) {
    const r = await explainArea(db, id, item.id, provider, { budget: 100, language });
    log(language, 'area', item.id, r.outcome, r.calls, r.detail ?? '');
    const row = db.prepare('SELECT content FROM area_explanation WHERE area_id = ?').get(item.id);
    areas.push({ id: item.id, outcome: r.outcome, calls: r.calls, walkthrough: JSON.parse(row.content) });
  }
  return {
    language,
    provider: { id: provider.id, model: provider.model },
    digest: { outcome: digest.outcome, calls: digest.calls, l0: levels[0], l1: levels[1], l2: levels[2] },
    areas,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = new ClaudeCodeProvider({
    bin: process.env.DIGESTIT_CLAUDE_BIN, model: process.env.DIGESTIT_CLAUDE_MODEL, timeoutMs: 600_000,
  });
  for (const language of process.argv.slice(2)) {
    const result = await runSample(provider, language);
    writeFileSync(join(here, `golden/walkthrough-snapback.claude.${language}.json`), JSON.stringify(result, null, 1) + '\n');
  }
}
