import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@digestit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, isAllowedHost } from './app.js';
import { SESSION_COOKIE } from './auth.js';
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

  it('orders by UTC instant, not the offset-bearing committed_at string', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'r', '/x')").run();
    const ins = db.prepare(
      "INSERT INTO commit_ (sha, repo_id, author_name, authored_at, committed_at, message) VALUES (?, 1, 'a', ?, ?, 'm')",
    );
    ins.run('kst', '2026-09-25T00:01:13+09:00', '2026-09-25T00:01:13+09:00'); // 15:01Z
    ins.run('utc', '2026-09-24T15:30:00Z', '2026-09-24T15:30:00Z');
    ins.run('old', '2026-09-24T09:00:00-05:00', '2026-09-24T09:00:00-05:00'); // 14:00Z
    const app = buildApp({ db, webDir: '/nonexistent' });
    apps.push(app);
    const p1 = (await app.inject('/api/repos/1/timeline?limit=1')).json();
    const p2 = (await app.inject(`/api/repos/1/timeline?limit=2&cursor=${p1.nextCursor}`)).json();
    expect([...p1.commits, ...p2.commits].map((c: { sha: string }) => c.sha)).toEqual(['utc', 'kst', 'old']);
    expect(p2.nextCursor).toBeNull();
  });

  it('sets a strict CSP and hardening headers', async () => {
    const res = await make().inject('/api/repos');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
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

describe('isAllowedHost', () => {
  it('allows loopback always, and allowlisted hosts case-insensitively', () => {
    const allowed = new Set(['dashboard.example.ts.net:4780']);
    expect(isAllowedHost('127.0.0.1:4780', allowed)).toBe(true);
    expect(isAllowedHost('localhost', allowed)).toBe(true);
    expect(isAllowedHost('dashboard.example.ts.net:4780', allowed)).toBe(true);
    expect(isAllowedHost('dashboard.example.ts.net:4780', allowed)).toBe(true);
    expect(isAllowedHost('evil.example:4780', allowed)).toBe(false);
    expect(isAllowedHost(undefined, allowed)).toBe(false);
  });
});

describe('allowed hosts + access token', () => {
  const TOKEN = 'test-token-value';
  const HOST = 'dashboard.example.ts.net:4780';

  const makeGated = (webDir?: string) => {
    const app = buildApp({
      db: seed(),
      webDir: webDir ?? '/nonexistent',
      allowedHosts: [HOST],
      auth: { token: TOKEN },
    });
    apps.push(app);
    return app;
  };

  it('421s any Host not loopback or allowlisted, auth aside', async () => {
    const app = makeGated();
    const res = await app.inject({ url: '/api/repos', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(421);
  });

  it('401s every route type without a credential once a token is configured, even for loopback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(dir, 'index.html'), '<html>ui</html>');
    const app = makeGated(dir);
    const noCred = { host: HOST };
    expect((await app.inject({ url: '/api/repos', headers: noCred })).statusCode).toBe(401);
    expect((await app.inject({ url: '/', headers: noCred })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/stream', headers: noCred })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/ui-events', headers: noCred, payload: {} })).statusCode,
    ).toBe(401);
    // Loopback is not a boundary once a token is required: another local job can also reach it.
    expect((await app.inject({ url: '/api/repos', headers: { host: '127.0.0.1:4780' } })).statusCode).toBe(401);
  });

  it('sets a cookie and redirects to / without the query string on a valid ?token= visit', async () => {
    const app = makeGated();
    const res = await app.inject({ url: `/?token=${TOKEN}`, headers: { host: HOST } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = res.headers['set-cookie'];
    expect(cookie).toContain(`${SESSION_COOKIE}=${TOKEN}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
  });

  it('401s a bad ?token= visit without leaking whether the format was right', async () => {
    const app = makeGated();
    const res = await app.inject({ url: '/?token=wrong', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('accepts the session cookie set by the token visit', async () => {
    const app = makeGated();
    const headers = { host: HOST, cookie: `${SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ url: '/api/repos', headers })).statusCode).toBe(200);
  });

  it('accepts Authorization: Bearer <token> as an alternative to the cookie', async () => {
    const app = makeGated();
    const headers = { host: HOST, authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ url: '/api/repos', headers })).statusCode).toBe(200);
  });

  it('rejects a wrong cookie or bearer token', async () => {
    const app = makeGated();
    expect(
      (await app.inject({ url: '/api/repos', headers: { host: HOST, cookie: `${SESSION_COOKIE}=nope` } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/api/repos', headers: { host: HOST, authorization: 'Bearer nope' } })).statusCode,
    ).toBe(401);
  });

  it('leaves loopback-only requests unauthenticated when no allowedHosts/token is configured', async () => {
    const app = make();
    expect((await app.inject('/api/repos')).statusCode).toBe(200);
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

  it('refuses to start when DIGESTIT_ALLOWED_HOSTS is set without a valid token file', async () => {
    await expect(
      startServer({ dbPath: ':memory:', port: 0, webDir: '/nonexistent', env: { DIGESTIT_ALLOWED_HOSTS: 'h:4780' } }),
    ).rejects.toThrow(/DIGESTIT_TOKEN_FILE/);
  });

  it('starts and requires the token when properly configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'digestit-token-'));
    const file = join(dir, 'token');
    writeFileSync(file, 'good-token\n', { mode: 0o600 });
    const app = await startServer({
      dbPath: ':memory:',
      port: 0,
      webDir: '/nonexistent',
      env: { DIGESTIT_ALLOWED_HOSTS: 'h:4780', DIGESTIT_TOKEN_FILE: file },
    });
    apps.push(app);
    expect((await app.inject({ url: '/api/repos', headers: { host: 'h:4780' } })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/repos', headers: { host: 'h:4780', authorization: 'Bearer good-token' } }))
        .statusCode,
    ).toBe(200);
  });
});
