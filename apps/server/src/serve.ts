import { openDb } from '@digestit/core';
import { buildApp } from './app.js';
import { resolveAccess } from './auth.js';

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

/**
 * Resolves DIGESTIT_ALLOWED_HOSTS / DIGESTIT_TOKEN_FILE and opens the DB + builds the app, but
 * does not bind a port yet — so a misconfigured token fails before any socket is opened.
 */
export function prepareServer(opts: { dbPath?: string; webDir?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = opts.env ?? process.env;
  const { allowedHosts, auth } = resolveAccess(env);
  const db = openDb(opts.dbPath);
  return buildApp({ db, webDir: opts.webDir, allowedHosts, auth });
}

export async function startServer(opts: { dbPath?: string; port?: number; webDir?: string; env?: NodeJS.ProcessEnv } = {}) {
  const app = prepareServer(opts);
  await app.listen({ host: DEFAULT_HOST, port: opts.port ?? resolvePort(opts.env ?? process.env) });
  return app;
}
