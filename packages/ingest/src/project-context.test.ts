import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { StubProvider, buildProjectMap, contextSourceHash, createProvider, type DigestSummaryInput } from '@digestit/explain';
import { findProject, initProject, updateProjectLanguage, type ProjectRow } from './project.js';
import { explainProject, retryDigest } from './explain-job.js';
import { buildContext, ensureContext, latestContextText } from './project-context.js';

let root: string;
let proj: string;
let home: string;
let db: DatabaseSync;
const write = (name: string, content: string) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};
const provider = createProvider({ provider: 'stub', repoAllowlist: ['project'] });
const contextRows = () => (db.prepare('SELECT count(*) AS n FROM project_context').get() as { n: number }).n;
const at = (iso: string) => () => new Date(iso);

async function setup(): Promise<ProjectRow> {
  write('README.md', '# Demo\nA small demo.\n');
  write('src/a.ts', 'export const a = 1;\n');
  const init = await initProject(db, home, proj, { name: 'project' });
  return findProject(db, String(init.repoId)) as ProjectRow;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'digest-context-'));
  proj = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(proj, { recursive: true });
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('project context', () => {
  it('builds from the checkpoint tree, not the live folder, and never reads denylisted files', async () => {
    write('.env', 'TOKEN=not-a-real-value\n');
    const row = await setup();
    write('src/late.ts', 'export const late = 1;\n'); // after the checkpoint: not in the map
    const r = await buildContext(db, home, row, provider, { budget: 40 });
    expect(r.outcome).toBe('ok');
    const stored = db.prepare('SELECT from_files AS n FROM project_context').get() as { n: number };
    expect(stored.n).toBe(2);
    expect(latestContextText(db, row.id)).toBeTruthy();
  });

  it('ensureContext builds once, then only on a structural change, at most once a day', async () => {
    const row = await setup();
    const opts = (iso: string) => ({ budget: 40, now: at(iso) });
    expect(await ensureContext(db, home, row, provider, opts('2026-01-01T10:00:00Z'))).not.toBeNull();
    expect(contextRows()).toBe(1);

    // A plain code edit is not structural: the Explain's own refresh check builds nothing.
    write('src/a.ts', 'export const a = 2;\n');
    await explainProject(db, home, row, provider, { budget: 40, now: at('2026-01-02T08:00:00Z') });
    expect(contextRows()).toBe(1);
    expect(await ensureContext(db, home, row, provider, opts('2026-01-02T08:30:00Z'))).toBeNull();

    // A README change is structural, but the last build was < 24 h ago: the Explain skips it too.
    write('README.md', '# Demo\nNow a bigger demo.\n');
    await explainProject(db, home, row, provider, { budget: 40, now: at('2026-01-02T09:00:00Z') });
    expect(contextRows()).toBe(1);
    expect(await ensureContext(db, home, row, provider, opts('2026-01-02T12:00:00Z'))).not.toBeNull();
    expect(contextRows()).toBe(2);
  });

  it('a later Explain refreshes a structurally stale context in the background of its own job', async () => {
    const row = await setup();
    expect(await ensureContext(db, home, row, provider, { budget: 40, now: at('2026-01-01T10:00:00Z') })).not.toBeNull();
    write('README.md', '# Demo\nNow a bigger demo.\n');
    const r = await explainProject(db, home, row, provider, { budget: 40, now: at('2026-01-02T12:00:00Z') });
    expect(contextRows()).toBe(2);
    const calls = db.prepare("SELECT count(DISTINCT job_id) AS jobs, count(*) AS n FROM explain_call WHERE part = 'context'").get() as { jobs: number; n: number };
    expect(calls).toEqual({ jobs: 1, n: 1 });
    expect(r.report!.parts.some((x) => x.part === 'context')).toBe(false);
  });

  it('ensureContext rebuilds after a language change, even inside the daily throttle (DIG-49)', async () => {
    let row = await setup();
    const opts = (iso: string) => ({ budget: 40, now: at(iso) });
    expect(await ensureContext(db, home, row, provider, opts('2026-01-01T10:00:00Z'))).not.toBeNull();
    expect(await ensureContext(db, home, row, provider, opts('2026-01-01T10:05:00Z'))).toBeNull();

    updateProjectLanguage(db, row.id, 'ko');
    row = findProject(db, String(row.id)) as ProjectRow;
    expect(await ensureContext(db, home, row, provider, opts('2026-01-01T10:10:00Z'))).not.toBeNull();
    const last = () => db.prepare('SELECT source_hash AS h, content FROM project_context ORDER BY id DESC LIMIT 1').get() as { h: string; content: string };
    // Once rebuilt in the new language, the throttle applies again.
    expect(await ensureContext(db, home, row, provider, opts('2026-01-01T10:15:00Z'))).toBeNull();
    expect(contextRows()).toBe(2);

    // A row from before languages existed holds the bare map hash and counts as English.
    const map = buildProjectMap(['README.md', 'src/a.ts'], (p) => (p === 'README.md' ? '# Demo\nA small demo.\n' : null));
    expect(last().h).toBe(contextSourceHash(map, 'ko'));
    db.prepare('UPDATE project_context SET source_hash = ?').run(map.sourceHash);
    expect(await ensureContext(db, home, row, provider, opts('2026-01-01T10:20:00Z'))).not.toBeNull();
    updateProjectLanguage(db, row.id, 'en');
    row = findProject(db, String(row.id)) as ProjectRow;
    db.prepare('UPDATE project_context SET source_hash = ?').run(map.sourceHash);
    expect(await ensureContext(db, home, row, provider, opts('2026-01-01T10:25:00Z'))).toBeNull();
  });

  it('a digest records the project language, and a retry keeps it after the project changes language', async () => {
    let row = await setup();
    const languages: string[] = [];
    class Spy extends StubProvider {
      override explainDigestSummary(input: DigestSummaryInput) {
        languages.push(input.language);
        return super.explainDigestSummary(input);
      }
    }
    updateProjectLanguage(db, row.id, 'ko');
    row = findProject(db, String(row.id)) as ProjectRow;
    write('src/b.ts', 'export const b = 1;\n');
    // No budget left: the digest is recorded (in Korean) but not explained yet.
    const r = await explainProject(db, home, row, new Spy(), { budget: 0 });
    expect(r.outcome).toBe('budget');
    const stored = db.prepare('SELECT language FROM digest WHERE change_unit_id = ?').get(r.digestId!) as { language: string };
    expect(stored.language).toBe('ko');
    updateProjectLanguage(db, row.id, 'en');
    await retryDigest(db, home, r.digestId!, new Spy(), { budget: 40 });
    expect(languages).toEqual(['ko']);
  });

  it('a first Explain grounds its parts on the map of the new checkpoint', async () => {
    const row = await setup();
    write('docs/new.md', '# New\n');
    const seen: (string | undefined)[] = [];
    class Spy extends StubProvider {
      override explainDigestSummary(input: DigestSummaryInput) {
        seen.push(input.context);
        return super.explainDigestSummary(input);
      }
    }
    const r = await explainProject(db, home, row, new Spy(), { budget: 40 });
    expect(r.noChanges).toBe(false);
    expect(seen[0]).toContain('docs/new.md');
  });
});
