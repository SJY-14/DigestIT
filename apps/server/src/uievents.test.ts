import { openDb } from '@digestit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function make(uiEvents?: { ratePerSec?: number; burst?: number; now?: () => number }) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'r', '/x'), (2, 'r2', '/y')").run();
  db.prepare("INSERT INTO commit_ (sha, repo_id, author_name, authored_at, committed_at, message) VALUES ('c1', 1, 'a', 't', 't', 'm')").run();
  db.prepare("INSERT INTO commit_ (sha, repo_id, author_name, authored_at, committed_at, message) VALUES ('c2', 2, 'a', 't', 't', 'm')").run();
  db.prepare("INSERT INTO change_unit (id, repo_id, head_sha, title) VALUES (1, 1, 'c1', 't'), (2, 2, 'c2', 't')").run();
  db.prepare(
    `INSERT INTO work_unit (id, repo_id, key, kind, title, state, tip_sha, base_sha, first_commit_at, last_commit_at)
     VALUES (1, 1, 'DIG-1', 'issue', 'One', 'handoff', 'c1', 'c0', '2026-09-24T10:00:00Z', '2026-09-24T10:00:00Z')`,
  ).run();
  const routes: string[] = [];
  const app = buildApp({ db, webDir: '/nonexistent', uiEvents, onRoute: (m, u) => routes.push(`${m} ${u}`) });
  apps.push(app);
  return { app, db, routes };
}

const good = { origin: 'http://localhost:4780', host: 'localhost:4780', 'x-digestit': '1', 'content-type': 'application/json' };
const post = (app: ReturnType<typeof make>['app'], payload: unknown, headers: Record<string, string> = good) =>
  app.inject({ method: 'POST', url: '/api/ui-events', headers, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
const count = (db: ReturnType<typeof make>['db']) =>
  (db.prepare("SELECT count(*) AS n FROM unit_event").get() as { n: number }).n;

describe('POST /api/ui-events', () => {
  it('is the only non-GET/HEAD route', () => {
    const { routes } = make();
    const writes = routes.filter((r) => !/^(GET|HEAD) /.test(r));
    expect(writes).toEqual(['POST /api/ui-events']);
  });

  it('other methods on it and other paths stay 405', async () => {
    const { app } = make();
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect((await app.inject({ method, url: '/api/ui-events', headers: good })).statusCode).toBe(405);
    }
    expect((await app.inject({ method: 'POST', url: '/api/metrics', headers: good, payload: '{}' })).statusCode).toBe(405);
    expect((await app.inject({ method: 'POST', url: '/api/nope', headers: good, payload: '{}' })).statusCode).toBe(405);
  });

  it('appends opened / level_viewed / reviewed events with server time', async () => {
    const { app, db } = make();
    expect((await post(app, { workUnitId: 1, changeId: 1, kind: 'opened' })).statusCode).toBe(201);
    const lv = await post(app, { workUnitId: 1, kind: 'level_viewed', level: 3, ms: 5000 });
    expect(lv.statusCode).toBe(201);
    expect((await post(app, { workUnitId: 1, kind: 'reviewed' })).statusCode).toBe(201);
    const rows = db.prepare('SELECT repo_id, work_unit_id, change_unit_id, kind, at, detail FROM unit_event ORDER BY id').all() as Record<string, unknown>[];
    expect(rows.map((r) => r.kind)).toEqual(['opened', 'level_viewed', 'reviewed']);
    expect(rows[0]).toMatchObject({ repo_id: 1, work_unit_id: 1, change_unit_id: 1 });
    expect(rows[1]!.detail).toBe('{"level":3,"ms":5000}');
    expect(Number.isNaN(Date.parse(rows[0]!.at as string))).toBe(false);
  });

  it('feeds /api/metrics', async () => {
    const { app, db } = make();
    db.prepare("INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (1, 1, 'landed', '2026-09-24T10:00:00Z')").run();
    await post(app, { workUnitId: 1, kind: 'opened' });
    await post(app, { workUnitId: 1, kind: 'level_viewed', level: 0 });
    await post(app, { workUnitId: 1, kind: 'reviewed' });
    const u = (await app.inject('/api/metrics')).json().units[0];
    expect(u).toMatchObject({ decidedBy: 'reviewed', levelsViewedBeforeDeciding: [0], reopens: 0 });
    expect(u.timeToOpenSec).toBeGreaterThan(0);
    expect(u.timeToDecideSec).toBeGreaterThan(0);
  });

  describe('rejections (nothing is written)', () => {
    const run = async (name: string, status: number, fn: (m: ReturnType<typeof make>) => Promise<{ statusCode: number }>) => {
      const m = make();
      expect((await fn(m)).statusCode, name).toBe(status);
      expect(count(m.db), name).toBe(0);
    };
    const ok = { workUnitId: 1, kind: 'opened' };

    it('bad or missing Origin', async () => {
      await run('foreign', 403, (m) => post(m.app, ok, { ...good, origin: 'http://evil.example' }));
      await run('port', 403, (m) => post(m.app, ok, { ...good, origin: 'http://localhost:9999' }));
      await run('missing', 403, (m) => post(m.app, ok, { host: good.host, 'x-digestit': '1', 'content-type': good['content-type'] }));
      await run('null', 403, (m) => post(m.app, ok, { ...good, origin: 'null' }));
    });
    it('cross-site Sec-Fetch-Site', async () => {
      for (const site of ['cross-site', 'same-site', 'none']) {
        await run(site, 403, (m) => post(m.app, ok, { ...good, 'sec-fetch-site': site }));
      }
      const m = make();
      expect((await post(m.app, ok, { ...good, 'sec-fetch-site': 'same-origin' })).statusCode).toBe(201);
    });
    it('missing X-DigestIT header', async () => {
      const { 'x-digestit': _omit, ...h } = good;
      await run('missing', 403, (m) => post(m.app, ok, h));
      await run('wrong', 403, (m) => post(m.app, ok, { ...good, 'x-digestit': '0' }));
    });
    it('wrong content type', async () => {
      await run('text', 415, (m) => post(m.app, JSON.stringify(ok), { ...good, 'content-type': 'text/plain' }));
      await run('form', 415, (m) => post(m.app, 'a=b', { ...good, 'content-type': 'application/x-www-form-urlencoded' }));
      await run('none', 415, (m) => {
        const { 'content-type': _ct, ...h } = good;
        return post(m.app, JSON.stringify(ok), h);
      });
    });
    it('oversized body', async () => {
      await run('big', 413, (m) => post(m.app, { ...ok, pad: 'x'.repeat(5000) }));
    });
    it('unknown or server-derived kind', async () => {
      for (const kind of ['landed', 'explained', 'merged', 'handoff', 'delete', '']) {
        await run(kind, 400, (m) => post(m.app, { workUnitId: 1, kind }));
      }
      await run('missing', 400, (m) => post(m.app, { workUnitId: 1 }));
    });
    it('unknown unit / change', async () => {
      await run('unit', 404, (m) => post(m.app, { workUnitId: 99, kind: 'opened' }));
      await run('change', 404, (m) => post(m.app, { workUnitId: 1, changeId: 99, kind: 'opened' }));
      await run('other repo change', 404, (m) => post(m.app, { workUnitId: 1, changeId: 2, kind: 'opened' }));
    });
    it('malformed payloads', async () => {
      await run('json', 400, (m) => post(m.app, '{nope'));
      await run('array', 400, (m) => post(m.app, '[]'));
      await run('extra field', 400, (m) => post(m.app, { ...ok, extra: 1 }));
      await run('string id', 400, (m) => post(m.app, { workUnitId: '1', kind: 'opened' }));
      await run('level missing', 400, (m) => post(m.app, { workUnitId: 1, kind: 'level_viewed' }));
      await run('level range', 400, (m) => post(m.app, { workUnitId: 1, kind: 'level_viewed', level: 4 }));
      await run('detail on opened', 400, (m) => post(m.app, { workUnitId: 1, kind: 'opened', level: 1 }));
    });
  });

  it('rate limits with 429 after the burst, then refills', async () => {
    let t = 0;
    const { app, db } = make({ ratePerSec: 20, burst: 50, now: () => t });
    const ok = { workUnitId: 1, kind: 'opened' };
    for (let i = 0; i < 50; i++) expect((await post(app, ok)).statusCode).toBe(201);
    const limited = await post(app, ok);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(count(db)).toBe(50);
    t += 100; // 2 tokens
    expect((await post(app, ok)).statusCode).toBe(201);
    expect((await post(app, ok)).statusCode).toBe(201);
    expect((await post(app, ok)).statusCode).toBe(429);
  });

  it('rejected requests do not consume rate-limit tokens', async () => {
    const { app } = make({ burst: 2, ratePerSec: 0, now: () => 0 });
    for (let i = 0; i < 5; i++) await post(app, { workUnitId: 1, kind: 'opened' }, { ...good, origin: 'http://evil.example' });
    expect((await post(app, { workUnitId: 1, kind: 'opened' })).statusCode).toBe(201);
  });
});
