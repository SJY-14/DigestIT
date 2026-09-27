import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { createProvider } from '@digestit/explain';
import { explainProject, findProject, initProject, type ProjectRow } from './project.js';
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
    expect(await ensureContext(db, home, row, provider, opts('2026-01-01T10:00:00Z'))).toBe(true);
    expect(contextRows()).toBe(1);

    // A plain code edit is not structural.
    write('src/a.ts', 'export const a = 2;\n');
    await explainProject(db, home, row, provider, { budget: 40, now: at('2026-01-02T10:00:00Z') });
    expect(await ensureContext(db, home, row, provider, opts('2026-01-02T11:00:00Z'))).toBe(false);

    // A README change is structural, but the last build was < 24 h ago.
    write('README.md', '# Demo\nNow a bigger demo.\n');
    await explainProject(db, home, row, provider, { budget: 40, now: at('2026-01-02T12:00:00Z') });
    expect(await ensureContext(db, home, row, provider, opts('2026-01-02T09:00:00Z'))).toBe(false); // 23 h after the build
    expect(await ensureContext(db, home, row, provider, opts('2026-01-02T12:00:00Z'))).toBe(true);
    expect(contextRows()).toBe(2);
  });

  it('explainProject resolves a function context after recording the new checkpoint', async () => {
    const row = await setup();
    write('docs/new.md', '# New\n');
    let seenSeq = 0;
    const r = await explainProject(db, home, row, provider, {
      budget: 40,
      context: async () => {
        seenSeq = (db.prepare('SELECT max(seq) AS s FROM checkpoint').get() as { s: number }).s;
        return undefined;
      },
    });
    expect(r.noChanges).toBe(false);
    expect(seenSeq).toBe(2);
  });
});
