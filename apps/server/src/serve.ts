import { openDb } from '@digestit/core';
import { buildApp } from './app.js';

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

export async function startServer(opts: { dbPath?: string; port?: number; webDir?: string } = {}) {
  const db = openDb(opts.dbPath);
  const app = buildApp({ db, webDir: opts.webDir });
  await app.listen({ host: DEFAULT_HOST, port: opts.port ?? resolvePort() });
  return app;
}
