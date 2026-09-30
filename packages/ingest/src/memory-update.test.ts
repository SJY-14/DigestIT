import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import type { AreaMemory } from '@digestit/core';
import { findProject, initProject, type ProjectRow } from './project.js';
import { listMemoryItems } from './memory.js';
import { updateProjectMemory } from './memory-update.js';

let root: string;
let proj: string;
let home: string;
let db: DatabaseSync;

const write = (name: string, content: string) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'digest-memory-update-'));
  proj = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(proj, { recursive: true });
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('updateProjectMemory', () => {
  it('extracts areas and terms from a real checkpoint and reports counts', async () => {
    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\n`);
    write('lib/util.ts', `import { add } from '../src/index.js';\nexport function double(x: number) { return add(x, x); }\n`);
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;

    const result = await updateProjectMemory(db, home, project, 'manual', () => new Date('2026-09-30T00:00:00.000Z'));
    expect(result.areasChanged).toBe(2);
    const areas = listMemoryItems(db, project.id, { kind: 'area' });
    expect(areas.map((a) => a.key).sort()).toEqual(['lib', 'src']);
    const terms = listMemoryItems(db, project.id, { kind: 'term' });
    expect(terms.map((t) => t.key).sort()).toEqual(['add', 'double']);
  });

  it('finishes on a clone of this repo in under 5 seconds', async () => {
    const repoRoot = new URL('../../..', import.meta.url).pathname; // the monorepo worktree root
    const init = await initProject(db, home, repoRoot, { name: 'digestit' });
    const registered = findProject(db, String(init.repoId)) as ProjectRow;
    const start = performance.now();
    const result = await updateProjectMemory(db, home, registered, 'manual');
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(5000);
    expect(result.areasChanged).toBeGreaterThan(0);
  });

  it('a second run with no file changes touches no areas (only changed areas get a new revision)', async () => {
    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\n`);
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    await updateProjectMemory(db, home, project, 'init', () => new Date('2026-09-30T00:00:00.000Z'));
    const v1 = listMemoryItems(db, project.id, { kind: 'area' }).find((a) => a.key === 'src')!.version;

    const second = await updateProjectMemory(db, home, project, 'manual', () => new Date('2026-10-01T00:00:00.000Z'));
    expect(second.areasChanged).toBe(0);
    expect(listMemoryItems(db, project.id, { kind: 'area' }).find((a) => a.key === 'src')!.version).toBe(v1);
  });

  it('only the area whose files changed gets a new revision on an incremental update', async () => {
    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\n`);
    write('lib/util.ts', `export function noop() {}\n`);
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    await updateProjectMemory(db, home, project, 'init', () => new Date('2026-09-30T00:00:00.000Z'));
    const libV1 = listMemoryItems(db, project.id, { kind: 'area' }).find((a) => a.key === 'lib')!.version;

    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n`);
    const result = await updateProjectMemory(db, home, project, 'manual', () => new Date('2026-10-01T00:00:00.000Z'));
    expect(result.areasChanged).toBe(1);
    const areas = listMemoryItems(db, project.id, { kind: 'area' });
    expect((areas.find((a) => a.key === 'src')!.content as AreaMemory).exports.map((e) => e.name).sort()).toEqual(['add', 'sub']);
    expect(areas.find((a) => a.key === 'lib')!.version).toBe(libV1); // untouched
  });

  it('a deleted area goes stale, not hidden or dropped', async () => {
    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\n`);
    write('lib/util.ts', `export function noop() {}\n`);
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    await updateProjectMemory(db, home, project, 'init', () => new Date('2026-09-30T00:00:00.000Z'));

    rmSync(join(proj, 'lib'), { recursive: true, force: true });
    const result = await updateProjectMemory(db, home, project, 'manual', () => new Date('2026-10-01T00:00:00.000Z'));
    expect(result.areasStale).toBe(1);
    expect(listMemoryItems(db, project.id, { kind: 'area' }).find((a) => a.key === 'lib')!.status).toBe('stale');
  });

  it('a denylisted file never surfaces in an extracted area\'s doc, exports or provenance', async () => {
    write('.env', 'API_KEY=super-secret-value-should-never-appear\n');
    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\n`);
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    await updateProjectMemory(db, home, project, 'init', () => new Date('2026-09-30T00:00:00.000Z'));
    const dump = JSON.stringify(listMemoryItems(db, project.id));
    expect(dump).not.toContain('.env');
    expect(dump).not.toContain('super-secret-value-should-never-appear');
  });

  it('redacts a token found in a README doc paragraph before it is ever stored', async () => {
    write('src/README.md', 'Talks to the API using sk-ant-abcdefghijklmnopqrstuvwxyz for auth.\n');
    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\n`);
    const init = await initProject(db, home, proj);
    const project = findProject(db, String(init.repoId)) as ProjectRow;
    await updateProjectMemory(db, home, project, 'init', () => new Date('2026-09-30T00:00:00.000Z'));
    const src = listMemoryItems(db, project.id, { kind: 'area' }).find((a) => a.key === 'src')!.content as AreaMemory;
    expect(src.doc).not.toContain('sk-ant-');
    expect(src.doc).toContain('[REDACTED]');
  });
});
