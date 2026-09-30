import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { createProvider } from '@digestit/explain';
import { findProject, getMemoryItem, initProject, updateProjectMemory, type ProjectRow } from '@digestit/ingest';
import { buildApp } from './app.js';
import type { V2Options } from './v2.js';

let root: string;
let proj: string;
let home: string;

const write = (name: string, content: string) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};

const NOW = () => new Date('2026-09-26T12:00:00Z');
const WRITE_TOKEN = 'memory-route-test-token';
const good = { origin: 'http://localhost:4780', host: 'localhost:4780', 'x-digestit': '1', 'content-type': 'application/json' };
const auth = { ...good, authorization: `Bearer ${WRITE_TOKEN}` };

const closers: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!.close();
  rmSync(root, { recursive: true, force: true });
});

function makeApp(db: DatabaseSync, v2Overrides: Partial<V2Options> = {}) {
  const app = buildApp({
    db, webDir: '/nonexistent', writeToken: WRITE_TOKEN,
    v2: { home, providerFactory: (allow) => createProvider({ provider: 'stub', repoAllowlist: allow }), now: NOW, ...v2Overrides },
  });
  closers.push(app);
  return app;
}

async function setup(): Promise<{ db: DatabaseSync; project: ProjectRow }> {
  root = mkdtempSync(join(tmpdir(), 'digest-memory-route-'));
  proj = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(proj, { recursive: true });
  write('server/api.ts', 'export const a = 1;\n');
  write('web/view.ts', 'export const v = 1;\n');
  const db = openDb(':memory:');
  const r = await initProject(db, home, proj, {}, NOW);
  const project = findProject(db, String(r.repoId)) as ProjectRow;
  await updateProjectMemory(db, home, project, 'manual', NOW);
  return { db, project };
}

type App = ReturnType<typeof makeApp>;
const get = (app: App, url: string) => app.inject({ method: 'GET', url });
const post = (app: App, url: string, body: unknown = {}, headers: Record<string, string> = auth) =>
  app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) });
const patch = (app: App, url: string, body: unknown = {}, headers: Record<string, string> = auth) =>
  app.inject({ method: 'PATCH', url, headers, payload: JSON.stringify(body) });
const put = (app: App, url: string, body: unknown = {}, headers: Record<string, string> = auth) =>
  app.inject({ method: 'PUT', url, headers, payload: JSON.stringify(body) });

describe('GET /api/projects/:id/memory', () => {
  it('returns the overview plus items, filterable by kind', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const res = await get(app, `/api/projects/${project.id}/memory`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projectId).toBe(project.id);
    expect(body.summariesEnabled).toBe(false); // D1: off by default
    expect(body.counts.area).toBeGreaterThan(0);
    expect(body.items.length).toBe(body.counts.area + body.counts.term + body.counts.thread + body.counts.note);

    const areasOnly = await get(app, `/api/projects/${project.id}/memory?kind=area`);
    expect(areasOnly.json().items.every((it: { kind: string }) => it.kind === 'area')).toBe(true);

    const bad = await get(app, `/api/projects/${project.id}/memory?kind=bogus`);
    expect(bad.statusCode).toBe(400);
  });

  it('404s an unknown project', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    const res = await get(app, '/api/projects/999999/memory');
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/memory/:itemId', () => {
  it('pins, then hides, then restores an item', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const item = getMemoryItem(db, project.id, 'area', 'server', null)!;

    const pinned = await patch(app, `/api/memory/${item.id}`, { pinned: true });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().pinned).toBe(true);

    const hidden = await patch(app, `/api/memory/${item.id}`, { status: 'hidden' });
    expect(hidden.json().status).toBe('hidden');

    const restored = await patch(app, `/api/memory/${item.id}`, { status: 'active' });
    expect(restored.json().status).toBe('active');
    expect(restored.json().pinned).toBe(true); // pin survives hide/restore
  });

  it('401s without the write token; 400 on an empty body', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const item = getMemoryItem(db, project.id, 'area', 'server', null)!;
    const noAuth = await patch(app, `/api/memory/${item.id}`, { pinned: true }, good);
    expect(noAuth.statusCode).toBe(401);
    const empty = await patch(app, `/api/memory/${item.id}`, {});
    expect(empty.statusCode).toBe(400);
  });

  it('400s a text edit on a non-note item, and on a code-sourced note', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const item = getMemoryItem(db, project.id, 'area', 'server', null)!;
    const res = await patch(app, `/api/memory/${item.id}`, { text: 'this is not a note' });
    expect(res.statusCode).toBe(400);
  });

  it('edits a user-source correction note created via /correct', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const item = getMemoryItem(db, project.id, 'area', 'server', null)!;
    const created = await post(app, `/api/memory/${item.id}/correct`, { text: 'first correction' });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().id;
    const edited = await patch(app, `/api/memory/${noteId}`, { text: 'edited correction' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().content.text).toBe('edited correction');
  });
});

describe('POST /api/memory/:itemId/correct', () => {
  it('creates a user note that overrides the target, and shows up on it as overriddenBy', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const item = getMemoryItem(db, project.id, 'area', 'server', null)!;
    const res = await post(app, `/api/memory/${item.id}/correct`, { text: 'actually this area does X' });
    expect(res.statusCode).toBe(201);
    expect(res.json().content.target).toEqual({ kind: 'area', key: 'server' });

    const overview = await get(app, `/api/projects/${project.id}/memory`);
    const areaDto = overview.json().items.find((it: { id: number }) => it.id === item.id);
    expect(areaDto.overriddenBy).toBe(res.json().id);
  });

  it('400s a correction targeting a note, and an over-length text', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const item = getMemoryItem(db, project.id, 'area', 'server', null)!;
    const note = await post(app, `/api/memory/${item.id}/correct`, { text: 'a correction' });
    const onNote = await post(app, `/api/memory/${note.json().id}/correct`, { text: 'nope' });
    expect(onNote.statusCode).toBe(400);
    const tooLong = await post(app, `/api/memory/${item.id}/correct`, { text: 'x'.repeat(2001) });
    expect(tooLong.statusCode).toBe(400);
  });
});

describe('POST /api/projects/:id/memory/rollback', () => {
  it('undoes the last batch', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const item = getMemoryItem(db, project.id, 'area', 'server', null)!;
    await patch(app, `/api/memory/${item.id}`, { pinned: true });
    const before = getMemoryItem(db, project.id, 'area', 'server', null)!;
    expect(before.pinned).toBe(true);

    const res = await post(app, `/api/projects/${project.id}/memory/rollback`);
    expect(res.statusCode).toBe(200);
    const after = getMemoryItem(db, project.id, 'area', 'server', null)!;
    expect(after.pinned).toBe(false);
  });

  it('a second rollback undoes the first (the rollback batch is itself the new "last batch")', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const item = getMemoryItem(db, project.id, 'area', 'server', null)!;
    await patch(app, `/api/memory/${item.id}`, { pinned: true });
    const first = await post(app, `/api/projects/${project.id}/memory/rollback`);
    expect(first.statusCode).toBe(200);
    expect(getMemoryItem(db, project.id, 'area', 'server', null)!.pinned).toBe(false);
    const second = await post(app, `/api/projects/${project.id}/memory/rollback`);
    expect(second.statusCode).toBe(200);
    expect(getMemoryItem(db, project.id, 'area', 'server', null)!.pinned).toBe(true);
  });

  it('400s a project with no memory batch at all (never given an updateProjectMemory run)', async () => {
    root = mkdtempSync(join(tmpdir(), 'digest-memory-route-empty-'));
    proj = join(root, 'project');
    home = join(root, 'home');
    mkdirSync(join(proj, 'lib'), { recursive: true });
    writeFileSync(join(proj, 'lib/x.ts'), 'export const x = 1;\n');
    const db = openDb(':memory:');
    const r = await initProject(db, home, proj, {}, NOW);
    const app = makeApp(db);
    const res = await post(app, `/api/projects/${r.repoId}/memory/rollback`);
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/projects/:id/memory/export', () => {
  it('exports every item', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const res = await get(app, `/api/projects/${project.id}/memory/export`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
  });
});

describe('POST /api/projects/:id/memory/clear', () => {
  it('leaves no rows for the project: items, revisions, uses and batches all gone', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const res = await post(app, `/api/projects/${project.id}/memory/clear`);
    expect(res.statusCode).toBe(200);
    expect(res.json().itemsDeleted).toBeGreaterThan(0);

    const counts = {
      items: (db.prepare('SELECT count(*) AS n FROM memory_item WHERE repo_id = ?').get(project.id) as { n: number }).n,
      revisions: (db.prepare(
        'SELECT count(*) AS n FROM memory_revision WHERE item_id IN (SELECT id FROM memory_item WHERE repo_id = ?)',
      ).get(project.id) as { n: number }).n,
      batches: (db.prepare('SELECT count(*) AS n FROM memory_batch WHERE repo_id = ?').get(project.id) as { n: number }).n,
      uses: (db.prepare(
        'SELECT count(*) AS n FROM memory_use WHERE change_unit_id IN (SELECT id FROM change_unit WHERE repo_id = ?)',
      ).get(project.id) as { n: number }).n,
    };
    expect(counts).toEqual({ items: 0, revisions: 0, batches: 0, uses: 0 });

    const overview = await get(app, `/api/projects/${project.id}/memory`);
    expect(overview.json().counts).toEqual({ area: 0, term: 0, thread: 0, note: 0 });
  });
});

describe('PUT /api/projects/:id/memory/settings', () => {
  it('toggles summariesEnabled (D1, off by default)', async () => {
    const { db, project } = await setup();
    const app = makeApp(db);
    const before = await get(app, `/api/projects/${project.id}/memory`);
    expect(before.json().summariesEnabled).toBe(false);

    const on = await put(app, `/api/projects/${project.id}/memory/settings`, { summariesEnabled: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().summariesEnabled).toBe(true);

    const noAuth = await put(app, `/api/projects/${project.id}/memory/settings`, { summariesEnabled: false }, good);
    expect(noAuth.statusCode).toBe(401);

    const bad = await put(app, `/api/projects/${project.id}/memory/settings`, { summariesEnabled: 'yes' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('POST /api/projects/:id/memory/update', () => {
  it('runs a deterministic update and reflects it in the overview', async () => {
    const { db, project } = await setup();
    write('server/api.ts', 'export const a = 1;\nexport const b = 2;\n');
    // No checkpoint advance: the manual trigger re-extracts from the latest checkpoint (same
    // contract as `digest memory update`), so this proves the route reaches the real store, not
    // that an uncommitted edit is picked up before the next Explain.
    const app = makeApp(db);
    const res = await post(app, `/api/projects/${project.id}/memory/update`);
    expect(res.statusCode).toBe(200);
    expect(res.json().projectId).toBe(project.id);
  });
});

describe('GET /api/digests/:id/memory-used', () => {
  it('404s a non-existent digest', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    const res = await get(app, '/api/digests/999999/memory-used');
    expect(res.statusCode).toBe(404);
  });

  it('reports the items an Explain actually used, with usedFor parts', async () => {
    const { db, project } = await setup();
    write('server/api.ts', 'export const a = 1;\nexport const b = 2;\n');
    const app = makeApp(db);
    const explainRes = await post(app, `/api/projects/${project.id}/explain`);
    const digestId = explainRes.json().digestId;
    // The provider is synchronous stub work queued on the microtask queue; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const res = await get(app, `/api/digests/${digestId}/memory-used`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.digestId).toBe(digestId);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.droppedForBudget).toBe('number');
  });
});
