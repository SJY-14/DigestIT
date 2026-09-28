import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { createProvider } from '@digestit/explain';
import { ensureDir0700, initProject, projectDataDir } from '@digestit/ingest';
import { buildApp } from './app.js';
import { SESSION_COOKIE } from './auth.js';
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
const patch = (app: App, url: string, body: unknown = {}, headers: Record<string, string> = auth) =>
  app.inject({ method: 'PATCH', url, headers, payload: JSON.stringify(body) });

describe('GET /api/projects', () => {
  it('lists a registered project with a "none" context and zero digests', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await get(app, '/api/projects');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual([{
      id: repoId, name: 'project', rootPath: proj, language: 'en',
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
    expect(body.explainStartedAt).toBe(null);
    expect(body.project.id).toBe(repoId);
  });

  it('reports explainStartedAt from a live lock so a reload can still show elapsed time', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const dataDir = projectDataDir(home, repoId);
    ensureDir0700(dataDir);
    const startedAt = '2026-09-26T11:58:00.000Z';
    writeFileSync(join(dataDir, 'explain.lock'), JSON.stringify({ pid: process.pid, startedAt }));
    try {
      const res = await get(app, `/api/projects/${repoId}/status`);
      const body = res.json();
      expect(body.explaining).toBe(true);
      expect(body.explainStartedAt).toBe(startedAt);
    } finally {
      unlinkSync(join(dataDir, 'explain.lock'));
    }
  });
});

describe('GET /api/projects/:id/graph', () => {
  it('404s an unknown or non-project repo id', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    expect((await get(app, '/api/projects/999/graph')).statusCode).toBe(404);
  });

  it('builds a gray tree from the latest checkpoint with no digest yet', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await get(app, `/api/projects/${repoId}/graph`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.digestId).toBeNull();
    expect(body.totalFiles).toBe(2); // README.md + src/a.ts
    for (const n of body.nodes) {
      expect(n).toMatchObject({ changed: false, changedFiles: 0, additions: 0, deletions: 0, status: null, areaIds: [] });
    }
    // Nothing changed (no digest yet), so unchanged folders collapse the same way the digest
    // graph builder always folds a quiet subtree — this is the same builder, just fed no changes.
    const srcDir = body.nodes.find((n: { id: string }) => n.id === 'd:src');
    expect(srcDir).toMatchObject({ collapsed: true, fileCount: 1 });
    const readme = body.nodes.find((n: { id: string }) => n.id === 'f:README.md');
    expect(readme).toBeDefined();
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

  it('accepts a contextPath nested inside the registered project root', async () => {
    const { db } = await setup();
    const other = join(root, 'ctx-project');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.txt'), 'x\n');
    writeFileSync(join(other, 'NOTES.md'), 'notes\n');
    const app = makeApp(db, { projectRoots: [root] });
    const res = await post(app, '/api/projects', { rootPath: other, contextPath: join(other, 'NOTES.md') });
    expect(res.statusCode).toBe(201);
  });

  it('403s a contextPath outside the registered project root', async () => {
    const { db } = await setup();
    const other = join(root, 'ctx-project-2');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.txt'), 'x\n');
    const outsideNotes = join(root, 'OUTSIDE.md');
    writeFileSync(outsideNotes, 'secret notes\n');
    const app = makeApp(db, { projectRoots: [root] });
    const res = await post(app, '/api/projects', { rootPath: other, contextPath: outsideNotes });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('context_not_allowed');
  });

  it('403s a contextPath that is a symlink escaping the project root', async () => {
    const { db } = await setup();
    const other = join(root, 'ctx-project-3');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.txt'), 'x\n');
    const outsideNotes = join(root, 'OUTSIDE2.md');
    writeFileSync(outsideNotes, 'secret notes\n');
    const link = join(other, 'notes-link.md');
    symlinkSync(outsideNotes, link);
    try {
      const app = makeApp(db, { projectRoots: [root] });
      const res = await post(app, '/api/projects', { rootPath: other, contextPath: link });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('context_not_allowed');
    } finally {
      unlinkSync(link);
    }
  });

  it('400s a contextPath that does not exist', async () => {
    const { db } = await setup();
    const other = join(root, 'ctx-project-4');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.txt'), 'x\n');
    const app = makeApp(db, { projectRoots: [root] });
    const res = await post(app, '/api/projects', { rootPath: other, contextPath: join(other, 'nope.md') });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('context_not_found');
  });
});

describe('PATCH /api/projects/:id', () => {
  it('sets the project language and returns the updated project', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await patch(app, `/api/projects/${repoId}`, { language: 'ko' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: repoId, language: 'ko' });
    const again = await get(app, '/api/projects');
    expect(again.json()[0].language).toBe('ko');
  });

  it('400s an unknown language', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await patch(app, `/api/projects/${repoId}`, { language: 'fr' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_language');
  });

  it('400s a missing language', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await patch(app, `/api/projects/${repoId}`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_language');
  });

  it('404s an unknown project', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    const res = await patch(app, '/api/projects/999', { language: 'ko' });
    expect(res.statusCode).toBe(404);
  });

  it('401s without the write token, like the other v2 writes', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await patch(app, `/api/projects/${repoId}`, { language: 'ko' }, good);
    expect(res.statusCode).toBe(401);
  });

  it('a digest created after the language changes records the new language', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    await patch(app, `/api/projects/${repoId}`, { language: 'ko' });
    write('src/b.ts', 'export const b = 2;\n');
    const explainBody = (await post(app, `/api/projects/${repoId}/explain`)).json();
    const detail = (await get(app, `/api/digests/${explainBody.digestId}`)).json();
    expect(detail.language).toBe('ko');
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

  it('413s a body over the write route body limit', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const res = await post(app, `/api/projects/${repoId}/explain`, { junk: 'x'.repeat(20_000) });
    expect(res.statusCode).toBe(413);
  });
});

describe('GET /?token= bootstrap (loopback, writeToken only, no DIGESTIT_ALLOWED_HOSTS)', () => {
  it('sets a cookie good enough to authenticate a write, on a correct token', async () => {
    const { db, repoId } = await setup();
    const app = makeApp(db);
    const login = await app.inject({ method: 'GET', url: `/?token=${WRITE_TOKEN}` });
    expect(login.statusCode).toBe(302);
    expect(login.headers['set-cookie']).toContain(`${SESSION_COOKIE}=${WRITE_TOKEN}`);
    const cookie = (login.headers['set-cookie'] as string).split(';', 1)[0]!;
    const { authorization: _drop, ...withoutBearer } = auth;
    const res = await post(app, `/api/projects/${repoId}/explain`, {}, { ...withoutBearer, cookie });
    expect(res.statusCode).toBe(200);
  });

  it('401s a wrong token and sets no cookie', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/?token=wrong' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('reads stay open with no ?token= at all (no regression for plain GETs)', async () => {
    const { db } = await setup();
    const app = makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
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
    expect(projects[0].context.fromFiles).toBe(3); // built after the new checkpoint: README.md, src/a.ts, src/b.ts

    const detail = (await get(app, `/api/digests/${digestId}`)).json();
    expect(detail.projectId).toBe(repoId);
    expect(detail.status).toBe('ok');
    expect(detail.l0).toBeTruthy();
    expect(detail.language).toBe('en');

    const list = (await get(app, `/api/projects/${repoId}/digests`)).json();
    expect(list.items[0].language).toBe('en');
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
    expect(areaAfter.l3.overview).toBeTruthy();
    expect(areaAfter.l3.steps.length).toBeGreaterThan(0);

    // A row from the old why/design/risks/notes prompt (a1) is not shown: it reads as 'none' until regenerated.
    db.prepare('DELETE FROM area_explanation').run();
    db.prepare(
      `INSERT INTO area_explanation (change_unit_id, area_id, content, status, provider, model, prompt_version, input_hash, created_at)
       VALUES (?, 'src', '{"why":"x","design":"y","risks":[],"notes":[]}', 'ok', 'stub', 'stub-1', 'a1', 'h', '2026-09-01T00:00:00Z')`,
    ).run(digestId);
    expect((await get(app, `/api/digests/${digestId}/areas/src`)).json()).toMatchObject({ status: 'none', l3: null });

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

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('explanation language wiring (DIG-49)', () => {
  it('writes digests and context in the project language, area L3 in the digest\'s, and a change applies from the next Explain', async () => {
    const { db, repoId } = await setup();
    const seen: string[] = [];
    const app = makeApp(db, {
      providerFactory: (allow) => {
        const inner = createProvider({ provider: 'stub', repoAllowlist: allow });
        return {
          ...inner,
          digest: async (input) => (seen.push(`digest:${input.language}`), inner.digest!(input)),
          explainContext: async (input) => (seen.push(`context:${input.language}`), inner.explainContext!(input)),
          explainArea: async (input) => (seen.push(`area:${input.language}`), inner.explainArea!(input)),
        };
      },
    });
    expect((await patch(app, `/api/projects/${repoId}`, { language: 'ko' })).statusCode).toBe(200);
    write('src/b.ts', 'b\n');
    const first = (await post(app, `/api/projects/${repoId}/explain`)).json().digestId as number;
    expect(seen).toEqual(['context:ko', 'digest:ko']);
    expect((await get(app, `/api/digests/${first}`)).json().language).toBe('ko');

    // Back to English: the old digest stays Korean, including its area walkthrough.
    expect((await patch(app, `/api/projects/${repoId}`, { language: 'en' })).statusCode).toBe(200);
    seen.length = 0;
    expect((await post(app, `/api/digests/${first}/areas/src/explain`)).statusCode).toBe(200);
    expect(seen).toEqual(['area:ko']);

    // The next Explain rebuilds the context in English (the language changed, even though the
    // last build is minutes old) and writes the new digest in English.
    seen.length = 0;
    write('src/c.ts', 'c\n');
    const second = (await post(app, `/api/projects/${repoId}/explain`)).json().digestId as number;
    expect(seen).toEqual(['context:en', 'digest:en']);
    expect((await get(app, `/api/digests/${second}`)).json().language).toBe('en');
    expect((await get(app, `/api/digests/${first}`)).json().language).toBe('ko');
  });
});

describe('one-at-a-time in-process guards (area explain, context refresh)', () => {
  it('409s a second click on the same area while the first explainArea call is still running', async () => {
    const { db, repoId } = await setup();
    write('src/b.ts', 'b\n');
    const gate = deferred<void>();
    const app = makeApp(db, {
      providerFactory: (allow) => {
        const inner = createProvider({ provider: 'stub', repoAllowlist: allow });
        return { ...inner, explainArea: async (input) => (await gate.promise, inner.explainArea!(input)) };
      },
    });
    const digestId = (await post(app, `/api/projects/${repoId}/explain`)).json().digestId;
    const first = post(app, `/api/digests/${digestId}/areas/src/explain`);
    await new Promise((r) => setTimeout(r, 20));
    const second = await post(app, `/api/digests/${digestId}/areas/src/explain`);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('explain_running');
    gate.resolve();
    expect((await first).statusCode).toBe(200);
  });

  it('409s a second context refresh while the first is still running', async () => {
    const { db, repoId } = await setup();
    const gate = deferred<void>();
    const app = makeApp(db, {
      providerFactory: (allow) => {
        const inner = createProvider({ provider: 'stub', repoAllowlist: allow });
        return { ...inner, explainContext: async (input) => (await gate.promise, inner.explainContext!(input)) };
      },
    });
    const first = post(app, `/api/projects/${repoId}/context/refresh`);
    await new Promise((r) => setTimeout(r, 20));
    const second = await post(app, `/api/projects/${repoId}/context/refresh`);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('explain_running');
    gate.resolve();
    expect((await first).statusCode).toBe(200);
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

  it('accepts repeated ?expand= query params as an array', async () => {
    const { app, d2 } = await twoDigests();
    const res = await get(app, `/api/digests/${d2}/graph?expand=src&expand=`);
    expect(res.statusCode).toBe(200);
    const opened = res.json().nodes.find((n: { id: string }) => n.id === 'd:src');
    expect(opened.collapsed).toBe(false);
  });

  it('400s more than 20 expand values', async () => {
    const { app, d1 } = await twoDigests();
    const qs = Array.from({ length: 21 }, () => 'expand=src').join('&');
    const res = await get(app, `/api/digests/${d1}/graph?${qs}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('too_many_expand');
  });

  it('accepts a valid expand and is served from cache on the next identical request', async () => {
    const { app, d1 } = await twoDigests();
    const first = await get(app, `/api/digests/${d1}/graph?expand=src`);
    expect(first.statusCode).toBe(200);
    const second = await get(app, `/api/digests/${d1}/graph?expand=src`);
    expect(second.json()).toEqual(first.json());
  });
});
