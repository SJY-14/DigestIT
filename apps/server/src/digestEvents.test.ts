import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type DigestPartsDto } from '@digestit/core';
import {
  StubProvider, type AreaInput, type AreaResult, type AreaStreamChunk, type ContextInput, type ContextResult,
  type DigestAreaTextInput, type DigestAreaTextResult, type DigestSummaryInput, type DigestSummaryResult,
} from '@digestit/explain';
import { buildApp } from './app.js';

let root: string;
let proj: string;
let home: string;

const write = (name: string, content: string) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};

const WRITE_TOKEN = 'digest-events-test-token';
const authHeaders = (base: string): Record<string, string> => ({
  origin: base, host: new URL(base).host, 'x-digestit': '1', 'content-type': 'application/json',
  authorization: `Bearer ${WRITE_TOKEN}`,
});

const closers: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!.close();
  rmSync(root, { recursive: true, force: true });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Gate = { promise: Promise<void>; resolve: () => void };

/** The stub provider with one gate per part (`summary`, `area:<id>`, `context`, `walkthrough`). */
class GatedProvider extends StubProvider {
  gates = new Map<string, Gate>();
  gate(part: string): Gate {
    if (!this.gates.has(part)) this.gates.set(part, deferred<void>() as Gate);
    return this.gates.get(part)!;
  }
  openAll(): void {
    for (const g of this.gates.values()) g.resolve();
    this.closed = false;
  }
  closed = true;
  private async pass(part: string): Promise<void> {
    if (this.closed || this.gates.has(part)) await this.gate(part).promise;
  }
  override async explainDigestSummary(input: DigestSummaryInput): Promise<DigestSummaryResult> {
    await this.pass('summary');
    return super.explainDigestSummary(input);
  }
  override async explainDigestAreaText(input: DigestAreaTextInput): Promise<DigestAreaTextResult> {
    await this.pass(`area:${input.area.id}`);
    return super.explainDigestAreaText(input);
  }
  override async explainContext(input: ContextInput): Promise<ContextResult> {
    await this.pass('context');
    return super.explainContext(input);
  }
  override async explainArea(input: AreaInput, onProgress?: (chunk: AreaStreamChunk) => void): Promise<AreaResult> {
    await this.pass('walkthrough');
    return super.explainArea(input, onProgress);
  }
}

async function setupApp(provider: GatedProvider) {
  root = mkdtempSync(join(tmpdir(), 'digest-events-'));
  proj = join(root, 'my-project');
  home = join(root, 'home');
  mkdirSync(proj, { recursive: true });
  write('server/api.ts', 'export const a = 1;\n');
  write('web/view.ts', 'export const v = 1;\n');
  const db: DatabaseSync = openDb(':memory:');
  const { initProject } = await import('@digestit/ingest');
  const init = await initProject(db, home, proj);
  write('server/api.ts', 'export const a = 2;\n');
  write('web/view.ts', 'export const v = 2;\n');

  const app = buildApp({
    db, webDir: '/nonexistent', writeToken: WRITE_TOKEN,
    v2: { home, providerFactory: () => provider },
  });
  closers.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  return { app, db, repoId: init.repoId, base };
}

async function readUntil(res: Response, pred: (text: string) => boolean, ms = 4000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (!pred(text) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 200))]);
    if (r && !r.done) text += dec.decode(r.value);
    else if (r?.done) break;
  }
  reader.releaseLock();
  return text;
}

const partsEvents = (text: string) => [...text.matchAll(/event: parts\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]!) as DigestPartsDto);
const settledOrder = (events: DigestPartsDto[]): string[] => {
  const order: string[] = [];
  for (const e of events) {
    const all: [string, string][] = [['summary', e.summary], ['context', e.context], ...Object.entries(e.areas).map(([k, v]) => [`area:${k}`, v] as [string, string])];
    for (const [k, v] of all) if (v !== 'pending' && v !== 'running' && !order.includes(k)) order.push(k);
  }
  return order;
};

async function startExplain(base: string): Promise<{ digestId: number; ms: number; body: Record<string, unknown> }> {
  const projects = await (await fetch(`${base}/api/projects`)).json();
  const t0 = Date.now();
  const res = await fetch(`${base}/api/projects/${projects[0].id}/explain`, { method: 'POST', headers: authHeaders(base), body: '{}' });
  const body = await res.json();
  return { digestId: body.digestId as number, ms: Date.now() - t0, body };
}

describe('GET /api/digests/:id/events (SSE, DIG-75)', () => {
  it('POST /explain returns pending before a slow provider answers; parts stream in order of completion, then done', async () => {
    const p = new GatedProvider();
    const { base } = await setupApp(p);
    const { digestId, ms, body } = await startExplain(base);
    expect(ms).toBeLessThan(1000);
    expect(body.status).toBe('pending');
    const detail = await (await fetch(`${base}/api/digests/${digestId}`)).json();
    expect(detail.areas.map((a: { id: string }) => a.id)).toEqual(['server', 'web']);
    expect(detail.files).toHaveLength(2);
    expect(detail.l0).toBeNull();

    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/digests/${digestId}/events`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    let text = await readUntil(res, (t) => t.includes('event: parts'));
    expect(partsEvents(text)[0]!.summary).toMatch(/pending|running/);

    // Release the parts in an order different from how they were queued.
    for (const part of ['area:web', 'context', 'summary', 'area:server']) {
      p.gate(part).resolve();
      text += await readUntil(res, (t) => settledOrder(partsEvents(t)).includes(part), 2000);
    }
    text += await readUntil(res, (t) => t.includes('event: done'));
    ctrl.abort();
    expect(settledOrder(partsEvents(text))).toEqual(['area:web', 'context', 'summary', 'area:server']);
    expect(partsEvents(text).at(-1)).toMatchObject({ summary: 'ok', context: 'ok', areas: { server: 'ok', web: 'ok' } });
    expect(text.indexOf('event: done')).toBeGreaterThan(text.lastIndexOf('event: parts'));
    const after = await (await fetch(`${base}/api/digests/${digestId}`)).json();
    expect(after.l2.items.map((it: { id: string }) => it.id)).toEqual(['server', 'web']);
    expect(after.parts.finishedAt).not.toBeNull();
  });

  it('409s a second Explain while parts are still running', async () => {
    const p = new GatedProvider();
    const { base } = await setupApp(p);
    const { digestId } = await startExplain(base);
    const projects = await (await fetch(`${base}/api/projects`)).json();
    const again = await fetch(`${base}/api/projects/${projects[0].id}/explain`, { method: 'POST', headers: authHeaders(base), body: '{}' });
    expect(again.status).toBe(409);
    const retry = await fetch(`${base}/api/digests/${digestId}/explain`, { method: 'POST', headers: authHeaders(base), body: '{}' });
    expect(retry.status).toBe(409);
    p.openAll();
  });

  it('streams an area L3 as area-progress, ends with done, and the POST returns at once', async () => {
    const p = new GatedProvider();
    p.openAll();
    const { base } = await setupApp(p);
    const { digestId } = await startExplain(base);
    const ctrl0 = new AbortController();
    await readUntil(await fetch(`${base}/api/digests/${digestId}/events`, { signal: ctrl0.signal }), (t) => t.includes('event: done'));
    ctrl0.abort();

    const walk = p.gate('walkthrough');
    const t0 = Date.now();
    const post = await fetch(`${base}/api/digests/${digestId}/areas/server/explain`, { method: 'POST', headers: authHeaders(base), body: '{}' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await post.json()).status).toBe('pending');
    const dup = await fetch(`${base}/api/digests/${digestId}/areas/server/explain`, { method: 'POST', headers: authHeaders(base), body: '{}' });
    expect(dup.status).toBe(409);

    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/digests/${digestId}/events`, { signal: ctrl.signal });
    let text = await readUntil(res, (t) => t.includes('event: parts'));
    expect(text).not.toContain('event: done');
    walk.resolve();
    text += await readUntil(res, (t) => t.includes('event: done'));
    ctrl.abort();
    const progress = [...text.matchAll(/event: area-progress\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]!));
    expect(progress.at(-1)).toMatchObject({ areaId: 'server', done: true });
    expect(progress.at(-1).steps.length).toBeGreaterThan(0);
    const area = await (await fetch(`${base}/api/digests/${digestId}/areas/server`)).json();
    expect(area.status).toBe('ok');
  });

  it('sends parts + done right away when nothing is running for this digest', async () => {
    const p = new GatedProvider();
    p.openAll();
    const { base } = await setupApp(p);
    const { digestId } = await startExplain(base);
    for (let i = 0; i < 40; i++) {
      const parts = (await (await fetch(`${base}/api/digests/${digestId}`)).json()).parts;
      if (parts && parts.finishedAt) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/digests/${digestId}/events`, { signal: ctrl.signal });
    const text = await readUntil(res, (t) => t.includes('event: done'));
    ctrl.abort();
    expect(text).toContain('event: parts');
    expect(text).toContain('event: done');
  });

  it('the digest graph shows the deterministic areas while the LLM parts are still pending', async () => {
    const p = new GatedProvider();
    const { base } = await setupApp(p);
    const { digestId } = await startExplain(base);
    const graph = await (await fetch(`${base}/api/digests/${digestId}/graph`)).json();
    const node = (id: string) => graph.nodes.find((n: { id: string }) => n.id === id);
    expect(node('f:server/api.ts').areaIds).toEqual(['server']);
    expect(node('f:web/view.ts').areaIds).toEqual(['web']);
    p.openAll();
  });

  it('404s an unknown digest', async () => {
    const p = new GatedProvider();
    p.openAll();
    const { base } = await setupApp(p);
    const res = await fetch(`${base}/api/digests/999/events`);
    expect(res.status).toBe(404);
  });
});
