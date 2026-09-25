import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@digestit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function make() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'r', '/x')").run();
  db.prepare(
    `INSERT INTO work_unit (id, repo_id, key, kind, title, state, tip_sha, first_commit_at, last_commit_at)
     VALUES (1, 1, 'DIG-1', 'issue', 'w', 'active', 'x', '2026-09-01', '2026-09-01')`,
  ).run();
  db.prepare("INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (1, 1, 'landed', '2026-09-01T10:00:00Z')").run();
  const app = buildApp({ db, webDir: '/nonexistent' });
  apps.push(app);
  return { app, db };
}

describe('GET /api/insights/areas', () => {
  it('rejects missing/bad window, root, measure, includeFiltered, repoId', async () => {
    const { app } = make();
    expect((await app.inject('/api/insights/areas')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/areas?window=6d')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/areas?window=7d&root=/apps')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/areas?window=7d&root=apps/..')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/areas?window=7d&measure=bytes')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/areas?window=7d&includeFiltered=yes')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/areas?window=7d&repoId=x')).statusCode).toBe(400);
  });

  it('returns the shape on a valid request', async () => {
    const { app } = make();
    const res = await app.inject('/api/insights/areas?window=7d');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ window: '7d', bucketKind: 'day', measure: 'units' });
    expect(Array.isArray(body.buckets)).toBe(true);
    expect(Array.isArray(body.areas)).toBe(true);
  });
});

describe('GET /api/insights/digest', () => {
  it('rejects missing/bad window and repoId', async () => {
    const { app } = make();
    expect((await app.inject('/api/insights/digest')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/digest?window=nope')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/digest?window=30d&repoId=x')).statusCode).toBe(400);
  });

  it('returns the shape on a valid request', async () => {
    const { app } = make();
    const res = await app.inject('/api/insights/digest?window=30d');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window).toBe('30d');
    expect(Array.isArray(body.perDay)).toBe(true);
    expect(Array.isArray(body.backlog)).toBe(true);
    expect(Array.isArray(body.explainCalls)).toBe(true);
    expect(body.latency.current).toHaveProperty('n');
  });
});

describe('GET /api/insights/drill', () => {
  it('400s with no recognised mode and on bad params', async () => {
    const { app } = make();
    expect((await app.inject('/api/insights/drill')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/drill?day=2026-09-01&metric=nope')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/drill?week=2026-08-31&bucket=nope')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/drill?day=bad-day&metric=landed')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/drill?ids=abc')).statusCode).toBe(400);
    expect((await app.inject('/api/insights/drill?window=7d')).statusCode).toBe(400); // window alone, no area
    const tooMany = Array.from({ length: 501 }, (_, i) => i + 1).join(',');
    expect((await app.inject(`/api/insights/drill?ids=${tooMany}`)).statusCode).toBe(400);
    expect((await app.inject('/api/insights/drill?area=apps&includeFiltered=yes')).statusCode).toBe(400);
  });

  it('returns work-unit summaries in the /api/work-units shape', async () => {
    const { app } = make();
    const res = await app.inject('/api/insights/drill?ids=1');
    expect(res.statusCode).toBe(200);
    const unit = res.json().workUnits[0];
    expect(unit).toMatchObject({ id: 1, key: 'DIG-1', kind: 'issue', state: 'active' });
    expect(unit).toHaveProperty('l0');
    expect(unit).toHaveProperty('pendingBudget');
    expect(unit).toHaveProperty('dirty');
  });
});

describe('access control (architecture §6) applies to the new routes', () => {
  it('rejects a non-loopback Host with 421', async () => {
    const { app } = make();
    const res = await app.inject({ url: '/api/insights/digest?window=7d', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(421);
  });

  it('rejects non-GET/HEAD with 405 (read-only surface)', async () => {
    const { app } = make();
    const res = await app.inject({ method: 'POST', url: '/api/insights/digest?window=7d' });
    expect(res.statusCode).toBe(405);
  });
});

describe('memoisation on PRAGMA data_version', () => {
  // PRAGMA data_version only reflects writes from OTHER connections (same behaviour live.ts's SSE
  // relies on, see live.test.ts): the app's own writes on its own connection never bump it, so this
  // needs a second connection onto the same file, standing in for `digest watch`.
  it('serves a cached response until another connection writes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'insights-memo-')), 'd.sqlite');
    const db = openDb(path);
    db.prepare("INSERT INTO repo (id, name, path) VALUES (1, 'r', '/x')").run();
    db.prepare(
      `INSERT INTO work_unit (id, repo_id, key, kind, title, state, tip_sha, first_commit_at, last_commit_at)
       VALUES (1, 1, 'DIG-1', 'issue', 'w', 'active', 'x', '2026-09-01', '2026-09-01')`,
    ).run();
    db.prepare("INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (1, 1, 'landed', '2026-09-02T09:00:00Z')").run();
    const app = buildApp({ db, webDir: '/nonexistent', insights: { now: () => new Date('2026-09-08T00:00:00Z') } });
    apps.push(app);

    const before = await app.inject('/api/insights/digest?window=7d');
    expect(before.json().perDay.find((d: { day: string }) => d.day === '2026-09-02').landed).toBe(1);

    const writer = openDb(path); // a separate connection, standing in for `digest watch`
    writer.prepare("INSERT INTO unit_event (repo_id, work_unit_id, kind, at) VALUES (1, 1, 'reviewed', '2026-09-02T10:00:00Z')").run();
    writer.close();

    const after = await app.inject('/api/insights/digest?window=7d');
    const day = after.json().perDay.find((d: { day: string }) => d.day === '2026-09-02');
    expect(day.decided).toBe(1); // only visible once the cache was invalidated by the version bump
  });

  it('recomputes when the UTC day rolls over even if the DB is idle', async () => {
    const { db } = make();
    let clock = new Date('2026-09-08T23:00:00Z');
    const app = buildApp({ db, webDir: '/nonexistent', insights: { now: () => clock } });
    apps.push(app);
    expect((await app.inject('/api/insights/digest?window=7d')).json().buckets.at(-1)).toBe('2026-09-08');
    clock = new Date('2026-09-09T01:00:00Z');
    expect((await app.inject('/api/insights/digest?window=7d')).json().buckets.at(-1)).toBe('2026-09-09');
  });
});
