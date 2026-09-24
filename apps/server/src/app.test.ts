import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@digestit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { DEFAULT_HOST, DEFAULT_PORT, resolvePort, startServer } from './serve.js';

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'r', '/x')").run();
  for (let i = 1; i <= 5; i++) {
    const sha = `sha${i}`;
    db.prepare(
      `INSERT INTO commit_ (sha, repo_id, parents, author_name, authored_at, committed_at, message)
       VALUES (?, 1, ?, 'a', ?, ?, ?)`,
    ).run(sha, JSON.stringify(i > 1 ? [`sha${i - 1}`] : []), `2026-01-0${i}`, `2026-01-0${i}`, `msg ${i}\n\nbody`);
    db.prepare("INSERT INTO change_unit (id, repo_id, head_sha, title) VALUES (?, 1, ?, ?)").run(i, sha, `msg ${i}`);
  }
  db.prepare("INSERT INTO file_change (change_unit_id, path, status, patch) VALUES (5, 'a.ts', 'M', '@@ -1 +1 @@')").run();
  db.prepare(
    `INSERT INTO explanation VALUES (5, 0, '{"text":"why"}', 'ok', 'stub', 'm', 'v1', 'h', '2026-02-01')`,
  ).run();
  db.prepare(
    `INSERT INTO explanation VALUES (5, 3, '{"annotations":[]}', 'ok', 'stub', 'm', 'v1', 'h', '2026-02-01')`,
  ).run();
  return db;
}

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
const make = (webDir?: string) => {
  const app = buildApp({ db: seed(), webDir: webDir ?? '/nonexistent' });
  apps.push(app);
  return app;
};

describe('api', () => {
  it('lists repos', async () => {
    const res = await make().inject('/api/repos');
    expect(res.json().repos).toHaveLength(1);
  });

  it('paginates the timeline newest-first with cursors and includes L0', async () => {
    const app = make();
    const p1 = (await app.inject('/api/repos/1/timeline?limit=2')).json();
    expect(p1.commits.map((c: { sha: string }) => c.sha)).toEqual(['sha5', 'sha4']);
    expect(p1.commits[0].l0).toEqual({ status: 'ok', content: { text: 'why' } });
    expect(p1.commits[1].l0.status).toBe('pending');
    const p2 = (await app.inject(`/api/repos/1/timeline?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.commits.map((c: { sha: string }) => c.sha)).toEqual(['sha3', 'sha2']);
    const p3 = (await app.inject(`/api/repos/1/timeline?limit=2&cursor=${p2.nextCursor}`)).json();
    expect(p3.commits.map((c: { sha: string }) => c.sha)).toEqual(['sha1']);
    expect(p3.nextCursor).toBeNull();
  });

  it('rejects bad cursor/limit and 404s unknown ids', async () => {
    const app = make();
    expect((await app.inject('/api/repos/1/timeline?cursor=zzz')).statusCode).toBe(400);
    expect((await app.inject('/api/repos/1/timeline?limit=0')).statusCode).toBe(400);
    expect((await app.inject('/api/repos/9/timeline')).statusCode).toBe(404);
    expect((await app.inject('/api/changes/99')).statusCode).toBe(404);
    expect((await app.inject('/api/changes/99/explanations/0')).statusCode).toBe(404);
    expect((await app.inject('/api/changes/5/explanations/4')).statusCode).toBe(404);
    expect((await app.inject('/api/nope')).statusCode).toBe(404);
  });

  it('returns change metadata and explanations, pending when not generated', async () => {
    const app = make();
    const change = (await app.inject('/api/changes/5')).json();
    expect(change.files).toHaveLength(1);
    expect(change.commit.message).toContain('body');
    expect((await app.inject('/api/changes/5/explanations/0')).json()).toMatchObject({ status: 'ok', content: { text: 'why' } });
    const pending = await app.inject('/api/changes/5/explanations/1');
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ status: 'pending', content: null });
    const l3 = (await app.inject('/api/changes/5/explanations/3')).json();
    expect(l3.files[0].patch).toBe('@@ -1 +1 @@');
  });

  it('has no write endpoints', async () => {
    const app = make();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await app.inject({ method, url: '/api/repos' })).statusCode).toBe(405);
    }
  });

  it('serves the web bundle with SPA fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(dir, 'index.html'), '<html>ui</html>');
    const app = make(dir);
    expect((await app.inject('/')).body).toContain('ui');
    expect((await app.inject('/changes/5')).body).toContain('ui');
    expect((await app.inject('/api/nope')).statusCode).toBe(404);
  });
});

describe('serve', () => {
  it('defaults to port 4780 and validates DIGESTIT_PORT', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(4780);
    expect(resolvePort({ DIGESTIT_PORT: '5000' })).toBe(5000);
    expect(() => resolvePort({ DIGESTIT_PORT: 'x' })).toThrow();
  });

  it('binds loopback only', async () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    const app = await startServer({ dbPath: ':memory:', port: 0, webDir: '/nonexistent' });
    apps.push(app);
    expect(app.server.address()).toMatchObject({ address: '127.0.0.1' });
  });
});
