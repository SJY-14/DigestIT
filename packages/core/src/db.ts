import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH = resolve(process.cwd(), '.cache/digestit.sqlite');

/** Ordered migrations; index + 1 is the schema version (PRAGMA user_version). */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE repo (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    path        TEXT NOT NULL,
    head_sha    TEXT,
    ingested_at TEXT
  );
  CREATE TABLE commit_ (
    sha          TEXT PRIMARY KEY,
    repo_id      INTEGER NOT NULL REFERENCES repo(id),
    parents      TEXT NOT NULL DEFAULT '[]',
    author_name  TEXT NOT NULL,
    authored_at  TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    message      TEXT NOT NULL,
    branch_refs  TEXT NOT NULL DEFAULT '[]',
    is_merge     INTEGER NOT NULL DEFAULT 0 CHECK (is_merge IN (0, 1)),
    stats        TEXT NOT NULL DEFAULT '{"files":0,"additions":0,"deletions":0}'
  );
  CREATE INDEX commit_repo_time ON commit_(repo_id, committed_at);
  CREATE TABLE change_unit (
    id       INTEGER PRIMARY KEY,
    repo_id  INTEGER NOT NULL REFERENCES repo(id),
    kind     TEXT NOT NULL DEFAULT 'commit' CHECK (kind IN ('commit')),
    head_sha TEXT NOT NULL,
    base_sha TEXT,
    title    TEXT NOT NULL,
    UNIQUE (repo_id, kind, head_sha)
  );
  CREATE TABLE file_change (
    change_unit_id  INTEGER NOT NULL REFERENCES change_unit(id),
    path            TEXT NOT NULL,
    old_path        TEXT,
    status          TEXT NOT NULL CHECK (status IN ('A','M','D','R','B')),
    additions       INTEGER NOT NULL DEFAULT 0,
    deletions       INTEGER NOT NULL DEFAULT 0,
    patch           TEXT,
    filtered_reason TEXT CHECK (filtered_reason IS NULL OR
                    filtered_reason IN ('lockfile','binary','generated','too_large')),
    PRIMARY KEY (change_unit_id, path)
  );
  CREATE TABLE explanation (
    change_unit_id INTEGER NOT NULL REFERENCES change_unit(id),
    level          INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
    content        TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('ok','pending','error','truncated')),
    provider       TEXT NOT NULL,
    model          TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    input_hash     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (change_unit_id, level, prompt_version)
  );
  `,
];

export function migrate(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return version;
}

/** Opens (creating parent dirs) and migrates the DB. Use ':memory:' for tests. */
export function openDb(path: string = DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}
