import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import type { AreaWalkthrough, DigestL2Content, L0Content, L1Content } from '@digestit/core';
import { aggregateHits, lintAreaWalkthrough, lintDb, lintDigestLevels, lintGolden, type WalkthroughGolden } from './lint-report.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = (name: string): WalkthroughGolden => JSON.parse(readFileSync(join(here, '../test/golden', name), 'utf8')) as WalkthroughGolden;

describe('lintDigestLevels / lintAreaWalkthrough / aggregateHits', () => {
  it('counts hits by rule and by level', () => {
    const l0: L0Content = { text: 'This change introduces a retry flag.' };
    const l1: L1Content = { userVisible: true, bullets: ['Retries are seamless now.'] };
    const l2: DigestL2Content = { items: [], notAnalysed: [] };
    const digestHits = lintDigestLevels(l0, l1, l2, 'en');
    const walk: AreaWalkthrough = { overview: 'Retries happen seamlessly in the background.', steps: [], check: [] };
    const areaHits = lintAreaWalkthrough(walk, 'en');
    const counts = aggregateHits([...digestHits, ...areaHits]);
    expect(counts.total).toBe(3);
    expect(counts.byLevel).toEqual({ l0: 1, l1: 1, l3: 1 });
    expect(counts.byRule['opener-this-x']).toBe(1);
    expect(counts.byRule['marketing-seamless']).toBe(2);
  });

  it('is 0 for clean prose', () => {
    const l0: L0Content = { text: 'Uploads now retry a failed request up to three times.' };
    const l1: L1Content = { userVisible: true, bullets: ['A new --retries flag controls the count.'] };
    const l2: DigestL2Content = { items: [], notAnalysed: [] };
    expect(aggregateHits(lintDigestLevels(l0, l1, l2, 'en')).total).toBe(0);
  });
});

describe('lintGolden', () => {
  it('matches the same 2-hit finding as the manual audit for the English sample, 0 for Korean', () => {
    const en = golden('walkthrough-snapback.sample.en.json');
    const ko = golden('walkthrough-snapback.sample.ko.json');
    const enReport = lintGolden(en);
    expect(enReport.counts.total).toBe(2);
    expect(enReport.counts.byRule['opener-this-x']).toBe(2);
    expect(enReport.repeatedOpeners).toBe(2);
    expect(lintGolden(ko).counts.total).toBe(0);
  });
});

function seedMinimalDigest(db: DatabaseSync, language: 'en' | 'ko' = 'en'): number {
  db.prepare("INSERT INTO repo (id, name, path, language) VALUES (1, 'DigestIT', '/x', ?)").run(language);
  const r = db.prepare("INSERT INTO change_unit (repo_id, kind, head_sha, title) VALUES (1, 'digest', 'sha1', 'digest')").run();
  const id = Number(r.lastInsertRowid);
  db.prepare(
    'INSERT INTO checkpoint (repo_id, seq, shadow_sha, tree_sha, taken_at, reason) VALUES (1, 1, ?, ?, ?, ?)',
  ).run('shadow1', 'tree1', new Date().toISOString(), 'init');
  db.prepare(
    'INSERT INTO checkpoint (repo_id, seq, shadow_sha, tree_sha, taken_at, reason) VALUES (1, 2, ?, ?, ?, ?)',
  ).run('shadow2', 'tree2', new Date().toISOString(), 'explain');
  db.prepare(
    'INSERT INTO digest (change_unit_id, repo_id, from_checkpoint_id, to_checkpoint_id, created_at, language) VALUES (?, 1, 1, 2, ?, ?)',
  ).run(id, new Date().toISOString(), language);
  const at = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO explanation (change_unit_id, level, content, status, provider, model, prompt_version, input_hash, created_at)
     VALUES (?, ?, ?, 'ok', 'stub', 'stub-1', 'd3', 'h', ?)`,
  );
  insert.run(id, 0, JSON.stringify({ text: 'This change introduces a retry flag.' }), at);
  insert.run(id, 1, JSON.stringify({ userVisible: true, bullets: ['A new flag controls the count.'] }), at);
  insert.run(id, 2, JSON.stringify({ items: [], notAnalysed: [] }), at);
  return id;
}

describe('lintDb', () => {
  it('finds the hit in a seeded digest row, using the digest language', () => {
    const db = openDb(':memory:');
    seedMinimalDigest(db);
    const report = lintDb(db);
    expect(report.counts.byRule['opener-this-x']).toBe(1);
  });

  it('is 0 when nothing is stored', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'DigestIT', '/x')").run();
    expect(lintDb(db).counts.total).toBe(0);
  });
});
