import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { createProvider } from '@digestit/explain';
import { ensureDir0700, initProject, projectDataDir } from '@digestit/ingest';
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
const WRITE_TOKEN = 'v2-test-token';
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
    v2: {
      home,
      providerFactory: (allow) => createProvider({ provider: 'stub', repoAllowlist: allow }),
      now: NOW,
      ...v2Overrides,
    },
  });
  closers.push(app);
  return app;
}

async function setup() {
  root = mkdtempSync(join(tmpdir(), 'digest-v2-'));
  proj = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(proj, { recursive: true });
  write('README.md', '# demo\n');
  write('src/a.ts', 'export const a = 1;\n');
  const db = openDb(':memory:');
  const r = await initProject(db, home, proj, {}, NOW);
  return { db, repoId: r.repoId };
}

type App = ReturnType<typeof makeApp>;
const get = (app: App, url: string) => app.inject({ method: 'GET', url });
const post = (app: App, url: string, body: unknown = {}, headers: Record<string, string> = auth) =>
  app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) });

describe('GET /api/projects', () => {
  it('lists a registered project with a "none" context and zero digests', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await get(app, '/api/projects');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual([{
      id: repoId, name: 'project', rootPath: proj,
      context: { status: 'none', builtAt: null, fromFiles: null, hasUserContext: false },
      lastCheckpointAt: NOW().toISOString(),
      digestCount: 0,
    }]);
  });

  it('404s an unknown or non-project repo id', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    expect((await get(app, '/api/projects/999/status')).statusCode).toBe(404);
  });
});

describe('GET /api/projects/:id/status', () => {
  it('reports pending changes, budget and explaining: false, with no LLM call', async () => {
    const { db, repoId } = await setup();
    write('src/b.ts', 'export const b = 2;\n');
    const app = makeApp(db);
    const res = await get(app, `/api/projects/${repoId}/status`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pending.files).toBe(1);
    expect(body.budget).toMatchObject({ limit: 40, used: 0, remaining: 40 });
    expect(body.explaining).toBe(false);
    expect(body.project.id).toBe(repoId);
  });
});

describe('POST /api/projects (register)', () => {
  it('403s when DIGESTIT_PROJECT_ROOTS is unset', async () => {
    const { db } = await setup();
    const app = makeApp(db, { projectRoots: [] });
    const res = await post(app, '/api/projects', { rootPath: proj });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('project_roots_not_configured');
  });

  it('registers a project under an allowed root', async () => {
    const { db } = await setup();
    const other = join(root, 'other-project');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.txt'), 'x\n');
    const app = makeApp(db, { projectRoots: [root] });
    const res = await post(app, '/api/projects', { rootPath: other });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'other-project', rootPath: other });
  });

  it('403s a real path outside every configured root', async () => {
    const { db } = await setup();
    const outside = join(tmpdir(), `digest-v2-outside-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    try {
      const app = makeApp(db, { projectRoots: [join(root, 'allowed')] });
      const res = await post(app, '/api/projects', { rootPath: outside });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('root_not_allowed');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('400s a root path that does not exist', async () => {
    const { db } = await setup();
    const app = makeApp(db, { projectRoots: [root] });
    const res = await post(app, '/api/projects', { rootPath: join(root, 'nope') });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('root_not_found');
  });

  it('403s a symlink inside the allowed root that escapes to a real path outside it', async () => {
    const { db } = await setup();
    const allowedRoot = join(root, 'allowed');
    mkdirSync(allowedRoot, { recursive: true });
    const outside = join(root, 'secret');
    mkdirSync(outside, { recursive: true });
    const link = join(allowedRoot, 'escape');
    symlinkSync(outside, link);
    try {
      const app = makeApp(db, { projectRoots: [allowedRoot] });
      const res = await post(app, '/api/projects', { rootPath: link });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('root_not_allowed');
    } finally {
      unlinkSync(link);
    }
  });
});

describe('v2 write-route auth/CSRF', () => {
  it('401s a missing/wrong token', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await post(app, `/api/projects/${repoId}/explain`, {}, good);
    expect(res.statusCode).toBe(401);
    const wrong = await post(app, `/api/projects/${repoId}/explain`, {}, { ...good, authorization: 'Bearer nope' });
    expect(wrong.statusCode).toBe(401);
  });

  it('403s a cross-origin request', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await post(app, `/api/projects/${repoId}/explain`, {}, { ...auth, origin: 'http://evil.example:4780' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('bad_origin');
  });

  it('403s a same-origin request missing the custom header', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const { 'x-digestit': _drop, ...headers } = auth;
    const res = await post(app, `/api/projects/${repoId}/explain`, {}, headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('missing_header');
  });

  it('415s a non-JSON content type', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await post(app, `/api/projects/${repoId}/explain`, {}, { ...auth, 'content-type': 'text/plain' });
    expect(res.statusCode).toBe(415);
  });

  it('405s any other method on a v2 write path', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await app.inject({ method: 'PUT', url: `/api/projects/${repoId}/explain`, headers: auth });
    expect(res.statusCode).toBe(405);
  });

  it('falls back to plain 405 for v2 write paths when no writeToken is configured (v2 off)', async () => {
    const { db, repoId } = await setup();
    const app = buildApp({ db, webDir: '/nonexistent', v2: { home } });
    closers.push(app);
    const res = await post(app, `/api/projects/${repoId}/explain`, {}, auth);
    expect(res.statusCode).toBe(405);
  });
});

describe('POST /api/projects/:id/explain and the digest/area GETs', () => {
  it('404s an unknown project', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    expect((await post(app, '/api/projects/999/explain')).statusCode).toBe(404);
  });

  it('produces a digest, auto-builds context on the first Explain, and serves it back', async () => {
    const { db, repoId } = await setup();
    write('src/b.ts', 'export const b = 2;\n');
    const app = makeApp(db);

    const explainRes = await post(app, `/api/projects/${repoId}/explain`);
    expect(explainRes.statusCode).toBe(200);
    const explainBody = explainRes.json();
    expect(explainBody.noChanges).toBe(false);
    expect(explainBody.status).toBe('ok');
    const digestId: number = explainBody.digestId;
    expect(explainBody.budget.used).toBeGreaterThan(0);

    // First-Explain-ever auto-builds the project context (best-effort).
    const projects = (await get(app, '/api/projects')).json();
    expect(projects[0].context.status).toBe('ok');
    expect(projects[0].context.fromFiles).toBe(2); // README.md + src/a.ts tracked at checkpoint #1

    const detail = (await get(app, `/api/digests/${digestId}`)).json();
    expect(detail.projectId).toBe(repoId);
    expect(detail.status).toBe('ok');
    expect(detail.l0).toBeTruthy();
    expect(detail.l2.items.map((i: { id: string }) => i.id)).toEqual(['src']);
    expect(detail.files).toEqual([
      expect.objectContaining({ path: 'src/b.ts', status: 'A' }),
    ]);

    // Area not yet clicked: status 'none', no l3.
    const areaBefore = (await get(app, `/api/digests/${digestId}/areas/src`)).json();
    expect(areaBefore).toMatchObject({ digestId, areaId: 'src', status: 'none', l3: null });
    expect(areaBefore.files[0]).toMatchObject({ path: 'src/b.ts', patch: expect.any(String) });

    const areaExplain = await post(app, `/api/digests/${digestId}/areas/src/explain`);
    expect(areaExplain.statusCode).toBe(200);
    const areaAfter = areaExplain.json();
    expect(areaAfter.status).toBe('ok');
    expect(areaAfter.l3.why).toBeTruthy();

    expect((await get(app, `/api/digests/${digestId}/areas/nope`)).statusCode).toBe(404);
    expect((await get(app, '/api/digests/999')).statusCode).toBe(404);
  });

  it('reports no changes since last check without creating a digest', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await post(app, `/api/projects/${repoId}/explain`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ noChanges: true, digestId: null, status: null });
  });

  it('409s a project explain already running (held by a live lock file)', async () => {
    const { db, repoId } = await setup();
    write('src/b.ts', 'b\n');
    const app = makeApp(db);
    const dataDir = projectDataDir(home, repoId);
    ensureDir0700(dataDir);
    writeFileSync(join(dataDir, 'explain.lock'), String(process.pid));
    try {
      const res = await post(app, `/api/projects/${repoId}/explain`);
      expect(res.statusCode).toBe(409);
    } finally {
      unlinkSync(join(dataDir, 'explain.lock'));
    }
  });
});

describe('POST /api/digests/:id/explain (retry)', () => {
  it('re-runs L0-2 and returns the full digest detail', async () => {
    const { db, repoId } = await setup();
    write('src/b.ts', 'b\n');
    const app = makeApp(db);
    const digestId = (await post(app, `/api/projects/${repoId}/explain`)).json().digestId;
    const res = await post(app, `/api/digests/${digestId}/explain`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: digestId, status: 'ok' });
  });

  it('404s an unknown digest', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    expect((await post(app, '/api/digests/999/explain')).statusCode).toBe(404);
  });
});

describe('POST /api/projects/:id/context/refresh', () => {
  it('builds and stores a fresh context, readable back from project status', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await post(app, `/api/projects/${repoId}/context/refresh`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.fromFiles).toBe(2);
    expect(body.builtAt).toBe(NOW().toISOString());
    expect(body.hasUserContext).toBe(false);
  });
});

describe('GET /api/budget', () => {
  it('returns the shared daily budget', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    const res = await get(app, '/api/budget');
    expect(res.json()).toMatchObject({ limit: 40, used: 0, remaining: 40 });
  });
});

describe('GET /api/projects/:id/digests (pagination)', () => {
  it('lists newest first with cursor pagination', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    write('src/b.ts', 'b\n');
    const d1 = (await post(app, `/api/projects/${repoId}/explain`)).json().digestId;
    write('src/c.ts', 'c\n');
    const d2 = (await post(app, `/api/projects/${repoId}/explain`)).json().digestId;
    write('src/d.ts', 'd\n');
    const d3 = (await post(app, `/api/projects/${repoId}/explain`)).json().digestId;

    const page1 = (await get(app, `/api/projects/${repoId}/digests?limit=2`)).json();
    expect(page1.items.map((i: { id: number }) => i.id)).toEqual([d3, d2]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await get(app, `/api/projects/${repoId}/digests?limit=2&cursor=${page1.nextCursor}`)).json();
    expect(page2.items.map((i: { id: number }) => i.id)).toEqual([d1]);
    expect(page2.nextCursor).toBeNull();
  });

  it('400s a bad cursor', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    expect((await get(app, `/api/projects/${repoId}/digests?cursor=not-base64`)).statusCode).toBe(400);
  });
});

describe('GET /api/digests/:id/graph', () => {
  async function twoDigests() {
    const { db, repoId } = await setup();
    write('src/b.ts', 'b\n');
    const app = makeApp(db);
    const d1 = (await post(app, `/api/projects/${repoId}/explain`)).json().digestId;
    unlinkSync(join(proj, 'src/a.ts'));
    writeFileSync(join(proj, 'src/b.ts'), 'b2\n');
    const d2 = (await post(app, `/api/projects/${repoId}/explain`)).json().digestId;
    return { app, d1, d2 };
  }

  it('404s an unknown digest', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    expect((await get(app, '/api/digests/999/graph')).statusCode).toBe(404);
  });

  it('400s an expand value that is not a folder in the tree', async () => {
    const { app, d1 } = await twoDigests();
    const res = await get(app, `/api/digests/${d1}/graph?expand=not/a/dir`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_expand');
  });

  it('shows a deleted file as a node even though it is gone from the tree', async () => {
    const { app, d2 } = await twoDigests();
    const res = await get(app, `/api/digests/${d2}/graph`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const deleted = body.nodes.find((n: { id: string }) => n.id === 'f:src/a.ts');
    expect(deleted).toMatchObject({ status: 'D', changed: true });
    expect(body.digestId).toBe(d2);
  });

  it('accepts a valid expand and is served from cache on the next identical request', async () => {
    const { app, d1 } = await twoDigests();
    const first = await get(app, `/api/digests/${d1}/graph?expand=src`);
    expect(first.statusCode).toBe(200);
    const second = await get(app, `/api/digests/${d1}/graph?expand=src`);
    expect(second.json()).toEqual(first.json());
  });
});
