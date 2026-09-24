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
  // M2-1: watch mode. work_unit_id is nullable until work units exist (DIG-14).
  `
  CREATE TABLE unit_event (
    id             INTEGER PRIMARY KEY,
    repo_id        INTEGER NOT NULL REFERENCES repo(id),
    work_unit_id   INTEGER,
    change_unit_id INTEGER REFERENCES change_unit(id),
    kind           TEXT NOT NULL CHECK (kind IN
                   ('landed','explained','opened','level_viewed','reviewed','merged')),
    at             TEXT NOT NULL,
    detail         TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX unit_event_repo_at ON unit_event(repo_id, at);
  CREATE UNIQUE INDEX unit_event_landed ON unit_event(change_unit_id) WHERE kind = 'landed';
  CREATE TABLE worktree_state (
    repo_id    INTEGER NOT NULL REFERENCES repo(id),
    path       TEXT NOT NULL,
    branch     TEXT,
    head_sha   TEXT,
    files      INTEGER NOT NULL,
    additions  INTEGER NOT NULL,
    deletions  INTEGER NOT NULL,
    untracked  INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, path)
  );
  `,
  // M2-2: work units. change_unit and unit_event are rebuilt (SQLite cannot alter a CHECK) to allow
  // kind 'range' and the state-transition events 'handoff'/'resumed'; ids and rows are preserved.
  `
  CREATE TABLE work_unit (
    id                   INTEGER PRIMARY KEY,
    repo_id              INTEGER NOT NULL REFERENCES repo(id),
    key                  TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('issue','branch')),
    title                TEXT NOT NULL,
    state                TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','handoff','merged')),
    tip_sha              TEXT NOT NULL,
    base_sha             TEXT,
    first_commit_at      TEXT NOT NULL,
    last_commit_at       TEXT NOT NULL,
    merged_at            TEXT,
    latest_range_unit_id INTEGER,
    UNIQUE (repo_id, key)
  );
  CREATE TABLE unit_commit (
    work_unit_id INTEGER NOT NULL REFERENCES work_unit(id),
    sha          TEXT NOT NULL,
    PRIMARY KEY (work_unit_id, sha)
  );
  CREATE INDEX unit_commit_sha ON unit_commit(sha);

  CREATE TABLE change_unit_new (
    id       INTEGER PRIMARY KEY,
    repo_id  INTEGER NOT NULL REFERENCES repo(id),
    kind     TEXT NOT NULL DEFAULT 'commit' CHECK (kind IN ('commit','range')),
    head_sha TEXT NOT NULL,
    base_sha TEXT,
    title    TEXT NOT NULL
  );
  INSERT INTO change_unit_new SELECT id, repo_id, kind, head_sha, base_sha, title FROM change_unit;
  DROP TABLE change_unit;
  ALTER TABLE change_unit_new RENAME TO change_unit;
  CREATE UNIQUE INDEX change_unit_commit ON change_unit(repo_id, head_sha) WHERE kind = 'commit';
  CREATE UNIQUE INDEX change_unit_range ON change_unit(repo_id, head_sha, COALESCE(base_sha, '')) WHERE kind = 'range';

  CREATE TABLE unit_event_new (
    id             INTEGER PRIMARY KEY,
    repo_id        INTEGER NOT NULL REFERENCES repo(id),
    work_unit_id   INTEGER REFERENCES work_unit(id),
    change_unit_id INTEGER REFERENCES change_unit(id),
    kind           TEXT NOT NULL CHECK (kind IN
                   ('landed','explained','opened','level_viewed','reviewed','merged','handoff','resumed')),
    at             TEXT NOT NULL,
    detail         TEXT NOT NULL DEFAULT '{}'
  );
  INSERT INTO unit_event_new SELECT id, repo_id, work_unit_id, change_unit_id, kind, at, detail FROM unit_event;
  DROP TABLE unit_event;
  ALTER TABLE unit_event_new RENAME TO unit_event;
  CREATE INDEX unit_event_repo_at ON unit_event(repo_id, at);
  CREATE INDEX unit_event_unit ON unit_event(work_unit_id, at);
  CREATE UNIQUE INDEX unit_event_landed ON unit_event(change_unit_id) WHERE kind = 'landed';
  `,
  // M2-3: explain scheduler. One row per provider call (or per unit left pending by the daily budget).
  `
  CREATE TABLE explain_call (
    id             INTEGER PRIMARY KEY,
    at             TEXT NOT NULL,
    change_unit_id INTEGER REFERENCES change_unit(id),
    reason         TEXT NOT NULL CHECK (reason IN ('merged','handoff','rollup','backfill','manual')),
    duration_ms    INTEGER NOT NULL DEFAULT 0,
    outcome        TEXT NOT NULL CHECK (outcome IN ('ok','error','budget'))
  );
  CREATE INDEX explain_call_at ON explain_call(at);
  CREATE INDEX explain_call_unit ON explain_call(change_unit_id, at);
  `,
  // M2-3b: hourly roll-up over the units that moved in a window (text-only, L0/L1).
  `
  CREATE TABLE rollup (
    id            INTEGER PRIMARY KEY,
    repo_id       INTEGER REFERENCES repo(id),
    window_start  TEXT NOT NULL,
    window_end    TEXT NOT NULL,
    work_unit_ids TEXT NOT NULL DEFAULT '[]',
    content       TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL
  );
  CREATE INDEX rollup_window_end ON rollup(window_end);
  `,
];

export function migrate(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  if (version >= MIGRATIONS.length) return version;
  // Table rebuilds (SQLite's documented 12-step procedure) need foreign keys off; the pragma is a
  // no-op inside a transaction, so set it first and verify with foreign_key_check before COMMIT.
  const fk = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (; version < MIGRATIONS.length; version++) {
      db.exec('BEGIN');
      try {
        db.exec(MIGRATIONS[version]!);
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length > 0) throw new Error(`migration ${version + 1}: foreign_key_check failed (${bad.length} rows)`);
        db.exec(`PRAGMA user_version = ${version + 1}`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${fk ? 'ON' : 'OFF'}`);
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
