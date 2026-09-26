import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openProjectDb } from '@digestit/ingest';
import { buildApp } from './app.js';
import { resolveAccess, resolveOrCreateWriteToken } from './auth.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4780;

/** Port from DIGESTIT_PORT / argument; host is never configurable (loopback only, see architecture §6). */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DIGESTIT_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid DIGESTIT_PORT: ${raw}`);
  return port;
}

/** Positive-integer env value, or undefined when absent/malformed. */
function intEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * `DIGESTIT_PROJECT_ROOTS`: comma-separated directories a browser-initiated `POST /api/projects`
 * may register a project under (docs/direction-v2.md §4). Each is realpath'd once here so the
 * route's containment check (`v2.ts`) compares against the real location, not a symlink; an entry
 * that does not exist (a typo'd root) is dropped rather than failing the whole server to start.
 */
export function parseProjectRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.DIGESTIT_PROJECT_ROOTS;
  if (!raw) return [];
  const out: string[] = [];
  for (const p of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      out.push(realpathSync(resolve(p)));
    } catch {
      /* misconfigured root: skip rather than refuse to start */
    }
  }
  return out;
}

/**
 * Resolves DIGESTIT_ALLOWED_HOSTS / DIGESTIT_TOKEN_FILE and opens the DB + builds the app, but
 * does not bind a port yet — so a misconfigured token fails before any socket is opened.
 */
export function prepareServer(opts: { dbPath?: string; webDir?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = opts.env ?? process.env;
  const { allowedHosts, auth } = resolveAccess(env);
  const { db, home } = openProjectDb(opts.dbPath);
  // v2 writes always need a token, even with no DIGESTIT_ALLOWED_HOSTS configured (direction-v2.md
  // §4): reuse auth.token when the full gate is already on, else a dedicated write-token file.
  let writeToken = auth?.token;
  let loginUrl: string | null = null;
  if (!writeToken) {
    const r = resolveOrCreateWriteToken(join(home, 'token'));
    writeToken = r.token;
    if (r.created) loginUrl = r.token;
  }
  const app = buildApp({
    db, webDir: opts.webDir, allowedHosts, auth, writeToken,
    v2: { home, projectRoots: parseProjectRoots(env), budgetLimit: intEnv(env.DIGESTIT_DAILY_BUDGET) },
  });
  return { app, loginUrl };
}

export async function startServer(opts: { dbPath?: string; port?: number; webDir?: string; env?: NodeJS.ProcessEnv } = {}) {
  const { app, loginUrl } = prepareServer(opts);
  const port = opts.port ?? resolvePort(opts.env ?? process.env);
  await app.listen({ host: DEFAULT_HOST, port });
  if (loginUrl) {
    const addr = app.server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    // Terminal only, never through the (disabled) request logger or any file: a write token is a
    // credential, and this line is printed exactly once, the run the token file is first created.
    console.log(`login URL: http://${DEFAULT_HOST}:${actualPort}/?token=${loginUrl}`);
  }
  return app;
}
