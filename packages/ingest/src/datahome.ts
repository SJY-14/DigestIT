import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DB_PATH, openDb } from '@digestit/core';

/** True when the dev/test DB (`.cache/digestit.sqlite`, relative to `cwd`) already exists. */
const usesDevDb = (): boolean => existsSync(DEFAULT_DB_PATH);

/**
 * DigestIT's data dir: holds `digestit.sqlite` and `projects/<id>/`.
 * `.cache/digestit.sqlite` (if present) wins, so dev and tests are unaffected. Otherwise
 * `$DIGESTIT_HOME`, else `$XDG_DATA_HOME/digestit`, else `~/.local/share/digestit`.
 */
export function resolveHome(dbOverride?: string): string {
  if (dbOverride) return dirname(resolve(dbOverride));
  if (usesDevDb()) return dirname(DEFAULT_DB_PATH);
  if (process.env.DIGESTIT_HOME) return resolve(process.env.DIGESTIT_HOME);
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? resolve(xdg, 'digestit') : join(homedir(), '.local', 'share', 'digestit');
}

export function resolveDbPath(dbOverride?: string): string {
  if (dbOverride) return resolve(dbOverride);
  if (usesDevDb()) return DEFAULT_DB_PATH;
  return join(resolveHome(), 'digestit.sqlite');
}

/** `mkdir -p` at 0700, forced regardless of umask (existing dirs are re-chmod'd too). */
export function ensureDir0700(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function projectDataDir(home: string, repoId: number): string {
  return join(home, 'projects', String(repoId));
}

/** Opens the DB under the resolved home (creating it 0700/0600) and returns both. */
export function openProjectDb(dbOverride?: string): { db: DatabaseSync; home: string; dbPath: string } {
  const home = resolveHome(dbOverride);
  const dbPath = resolveDbPath(dbOverride);
  ensureDir0700(home);
  const db = openDb(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  return { db, home, dbPath };
}
