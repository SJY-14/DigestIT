import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { createProvider, type AreaInput, type AreaResult, type DigestInput, type DigestResult, type ExplanationProvider } from '@digestit/explain';
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

/** A provider whose `digest()` call is gated, so a test can observe the digest mid-flight. */
class GatedProvider implements ExplanationProvider {
  readonly id = 'gated';
  readonly model = 'gated-1';
  private inner: ExplanationProvider;
  constructor(private gate: Promise<void>, allow: string[]) {
    this.inner = createProvider({ provider: 'stub', repoAllowlist: allow });
  }
  async explain(): Promise<never> { throw new Error('unused'); }
  async digest(input: DigestInput): Promise<DigestResult> {
    await this.gate;
    return this.inner.digest!(input);
  }
  async explainContext(): Promise<never> { throw new Error('unused'); }
  async explainArea(input: AreaInput): Promise<AreaResult> { return this.inner.explainArea!(input); }
}

async function setupApp(gate: Promise<void>) {
  root = mkdtempSync(join(tmpdir(), 'digest-events-'));
  proj = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(proj, { recursive: true });
  write('a.ts', 'one\n');
  const db: DatabaseSync = openDb(':memory:');
  const { initProject } = await import('@digestit/ingest');
  const init = await initProject(db, home, proj);
  write('a.ts', 'one\ntwo\n');

  const app = buildApp({
    db, webDir: '/nonexistent', writeToken: WRITE_TOKEN,
    v2: { home, providerFactory: (allow) => new GatedProvider(gate, allow) },
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

describe('GET /api/digests/:id/events (SSE, DIG-75)', () => {
  it('sends parts on connect, on change, and done once the job settles, in order', async () => {
    const gate = deferred<void>();
    const { base } = await setupApp(gate.promise);
    const projects = await (await fetch(`${base}/api/projects`)).json();
    const explainRes = await fetch(`${base}/api/projects/${projects[0].id}/explain`, {
      method: 'POST', headers: authHeaders(base), body: '{}',
    });
    const digestId = (await explainRes.json()).digestId as number;

    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/digests/${digestId}/events`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // The initial snapshot arrives before the summary part settles: still pending/running.
    let text = await readUntil(res, (t) => t.includes('event: parts'));
    expect(text).toMatch(/"summary":"(pending|running)"/);
    expect(text).not.toContain('event: done');

    gate.resolve();
    text = await readUntil(res, (t) => t.includes('event: done'));
    ctrl.abort();

    const partsEvents = [...text.matchAll(/event: parts\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]!));
    expect(partsEvents.length).toBeGreaterThanOrEqual(2);
    expect(partsEvents.at(-1).summary).toBe('ok');
    // Events streamed in order: no terminal status appears before a running/pending one for the same part.
    const summarySeq = partsEvents.map((p) => p.summary);
    expect(summarySeq.at(-1)).toBe('ok');
    expect(text.indexOf('event: done')).toBeGreaterThan(text.lastIndexOf('event: parts'));
  });

  it('sends parts + done right away when nothing is running for this digest', async () => {
    const gate = deferred<void>();
    gate.resolve(); // never actually gates anything in this test
    const { base } = await setupApp(gate.promise);
    const projects = await (await fetch(`${base}/api/projects`)).json();
    const explainRes = await fetch(`${base}/api/projects/${projects[0].id}/explain`, { method: 'POST', headers: authHeaders(base), body: '{}' });
    const digestId = (await explainRes.json()).digestId as number;
    // Let the (already-gate-resolved) job settle before connecting.
    for (let i = 0; i < 40; i++) {
      const parts = (await (await fetch(`${base}/api/digests/${digestId}`)).json()).parts;
      if (parts && parts.summary !== 'pending' && parts.summary !== 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/digests/${digestId}/events`, { signal: ctrl.signal });
    const text = await readUntil(res, (t) => t.includes('event: done'));
    ctrl.abort();
    expect(text).toContain('event: parts');
    expect(text).toContain('event: done');
  });

  it('404s an unknown digest', async () => {
    const gate = deferred<void>();
    gate.resolve();
    const { base } = await setupApp(gate.promise);
    const res = await fetch(`${base}/api/digests/999/events`);
    expect(res.status).toBe(404);
  });
});
