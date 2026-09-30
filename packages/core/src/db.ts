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
  // v2 (DIG-33, docs/direction-v2.md): projects, shadow checkpoints, digests, lazy per-area L3 and
  // project context. change_unit and explain_call are rebuilt only to widen their CHECKs.
  `
  ALTER TABLE repo ADD COLUMN mode TEXT NOT NULL DEFAULT 'history' CHECK (mode IN ('history','project'));
  ALTER TABLE repo ADD COLUMN context_path TEXT;
  ALTER TABLE repo ADD COLUMN created_at TEXT;

  CREATE TABLE change_unit_new (
    id       INTEGER PRIMARY KEY,
    repo_id  INTEGER NOT NULL REFERENCES repo(id),
    kind     TEXT NOT NULL DEFAULT 'commit' CHECK (kind IN ('commit','range','digest')),
    head_sha TEXT NOT NULL,
    base_sha TEXT,
    title    TEXT NOT NULL
  );
  INSERT INTO change_unit_new SELECT id, repo_id, kind, head_sha, base_sha, title FROM change_unit;
  DROP TABLE change_unit;
  ALTER TABLE change_unit_new RENAME TO change_unit;
  CREATE UNIQUE INDEX change_unit_commit ON change_unit(repo_id, head_sha) WHERE kind = 'commit';
  CREATE UNIQUE INDEX change_unit_range ON change_unit(repo_id, head_sha, COALESCE(base_sha, '')) WHERE kind = 'range';
  CREATE UNIQUE INDEX change_unit_digest ON change_unit(repo_id, head_sha) WHERE kind = 'digest';

  CREATE TABLE explain_call_new (
    id             INTEGER PRIMARY KEY,
    at             TEXT NOT NULL,
    change_unit_id INTEGER REFERENCES change_unit(id),
    reason         TEXT NOT NULL CHECK (reason IN
                   ('merged','handoff','rollup','backfill','manual','digest','area','context')),
    duration_ms    INTEGER NOT NULL DEFAULT 0,
    outcome        TEXT NOT NULL CHECK (outcome IN ('ok','error','budget'))
  );
  INSERT INTO explain_call_new SELECT id, at, change_unit_id, reason, duration_ms, outcome FROM explain_call;
  DROP TABLE explain_call;
  ALTER TABLE explain_call_new RENAME TO explain_call;
  CREATE INDEX explain_call_at ON explain_call(at);
  CREATE INDEX explain_call_unit ON explain_call(change_unit_id, at);

  CREATE TABLE checkpoint (
    id          INTEGER PRIMARY KEY,
    repo_id     INTEGER NOT NULL REFERENCES repo(id),
    seq         INTEGER NOT NULL,
    shadow_sha  TEXT NOT NULL,
    tree_sha    TEXT NOT NULL,
    taken_at    TEXT NOT NULL,
    reason      TEXT NOT NULL CHECK (reason IN ('init','explain','manual')),
    user_head   TEXT,
    user_branch TEXT,
    skipped     TEXT NOT NULL DEFAULT '[]',
    UNIQUE (repo_id, seq)
  );
  CREATE TABLE digest (
    change_unit_id     INTEGER PRIMARY KEY REFERENCES change_unit(id),
    repo_id            INTEGER NOT NULL REFERENCES repo(id),
    from_checkpoint_id INTEGER NOT NULL REFERENCES checkpoint(id),
    to_checkpoint_id   INTEGER NOT NULL UNIQUE REFERENCES checkpoint(id),
    created_at         TEXT NOT NULL,
    stats              TEXT NOT NULL DEFAULT '{"files":0,"additions":0,"deletions":0}'
  );
  CREATE INDEX digest_repo_created ON digest(repo_id, created_at);
  CREATE TABLE area_explanation (
    change_unit_id INTEGER NOT NULL REFERENCES change_unit(id),
    area_id        TEXT NOT NULL,
    content        TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('ok','pending','error','truncated')),
    provider       TEXT NOT NULL,
    model          TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    input_hash     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (change_unit_id, area_id, prompt_version)
  );
  CREATE TABLE project_context (
    id                INTEGER PRIMARY KEY,
    repo_id           INTEGER NOT NULL REFERENCES repo(id),
    checkpoint_id     INTEGER REFERENCES checkpoint(id),
    content           TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('ok','pending','error','truncated')),
    source_hash       TEXT NOT NULL,
    user_context_hash TEXT,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_version    TEXT NOT NULL,
    created_at        TEXT NOT NULL
  );
  CREATE INDEX project_context_repo ON project_context(repo_id, created_at);
  `,
  // DIG-39 (API v2): ContextStatusDto.fromFiles has no source in migration 6's project_context
  // row, since the built ProjectMap itself is never persisted (only its content/status/hashes).
  `
  ALTER TABLE project_context ADD COLUMN from_files INTEGER;
  `,
  // DIG-49 (UX v3 language setting): explanation language, per project and recorded per digest so
  // one digest never mixes languages even after the project setting changes.
  `
  ALTER TABLE repo ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','ko'));
  ALTER TABLE digest ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','ko'));
  `,
  // DIG-65 (AI-tell lint): AI-tell hits left after the one style retry, per stored row. Internal
  // only (never shown in the UI) — a report metric, not part of any content JSON.
  `
  ALTER TABLE explanation ADD COLUMN style_warnings INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE area_explanation ADD COLUMN style_warnings INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE project_context ADD COLUMN style_warnings INTEGER NOT NULL DEFAULT 0;
  `,
  // DIG-73 (fast Explain, docs/explain-speed.md): one explain_job per user action (Explain, area
  // L3, context refresh, digest retry) so the daily budget counts actions, not calls; per-call
  // timing split (CLI start-up, time to first token, generation) and token counts; the digest's
  // deterministic areas, stored so they stay stable if the grouping rules change later.
  `
  CREATE TABLE explain_job (
    id             INTEGER PRIMARY KEY,
    repo_id        INTEGER REFERENCES repo(id),
    change_unit_id INTEGER REFERENCES change_unit(id),
    kind           TEXT NOT NULL CHECK (kind IN ('explain','retry','area','context')),
    area_id        TEXT,
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    prep_ms        INTEGER
  );
  CREATE INDEX explain_job_started ON explain_job(started_at);
  CREATE INDEX explain_job_unit ON explain_job(change_unit_id, started_at);
  ALTER TABLE explain_call ADD COLUMN job_id INTEGER REFERENCES explain_job(id);
  ALTER TABLE explain_call ADD COLUMN part TEXT;
  ALTER TABLE explain_call ADD COLUMN model TEXT;
  ALTER TABLE explain_call ADD COLUMN effort TEXT;
  ALTER TABLE explain_call ADD COLUMN startup_ms INTEGER;
  ALTER TABLE explain_call ADD COLUMN ttft_ms INTEGER;
  ALTER TABLE explain_call ADD COLUMN gen_ms INTEGER;
  ALTER TABLE explain_call ADD COLUMN input_tokens INTEGER;
  ALTER TABLE explain_call ADD COLUMN output_tokens INTEGER;
  CREATE INDEX explain_call_job ON explain_call(job_id);
  ALTER TABLE digest ADD COLUMN areas TEXT;
  `,
  // DIG-87 (UX cycle 2, soft project remove): a removed project keeps its rows and shadow repo --
  // it is just hidden from listings and per-project routes -- and comes back with its history if
  // the same root is registered again.
  `
  ALTER TABLE repo ADD COLUMN removed_at TEXT;
  `,
  // DIG-100 (Milestone 4, docs/milestone-4-memory.md): project memory. `memory_item` is one row per
  // (repo, kind, key, language) -- language is part of the key only so a prose-bearing item (a term
  // meaning, a thread title) can exist once per language; `content` carries the full MemoryContent
  // shape (packages/core/src/memory.ts) as the contract, not a column per field, since the shape
  // differs by kind and is expected to grow. `memory_revision` keeps every version for rollback,
  // grouped by the `memory_batch` that wrote it. `memory_use` is per (job, part, item) so a job's
  // memory slice is diagnosable the same way `explain_call` diagnoses its provider calls.
  // `explain_job.kind` is widened (rebuilt: SQLite cannot alter a CHECK) to add 'memory', for the
  // background summary job of docs/milestone-4-memory.md §4.
  `
  CREATE TABLE memory_batch (
    id            INTEGER PRIMARY KEY,
    repo_id       INTEGER NOT NULL REFERENCES repo(id),
    trigger       TEXT NOT NULL CHECK (trigger IN
                  ('init','after-explain','idle','daily','manual','user','rollback')),
    checkpoint_id INTEGER REFERENCES checkpoint(id),
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    changed       INTEGER NOT NULL DEFAULT 0,
    calls         INTEGER NOT NULL DEFAULT 0,
    rolled_back   INTEGER NOT NULL DEFAULT 0 CHECK (rolled_back IN (0, 1))
  );
  CREATE INDEX memory_batch_repo ON memory_batch(repo_id, started_at);

  CREATE TABLE memory_item (
    id           INTEGER PRIMARY KEY,
    repo_id      INTEGER NOT NULL REFERENCES repo(id),
    kind         TEXT NOT NULL CHECK (kind IN ('area','term','thread','note')),
    key          TEXT NOT NULL,
    language     TEXT CHECK (language IS NULL OR language IN ('en','ko')),
    content      TEXT NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('user','code','digest','summary')),
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','hidden')),
    pinned       INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    provenance   TEXT NOT NULL DEFAULT '{}',
    confirmed_at TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    version      INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX memory_item_unique ON memory_item(repo_id, kind, key, COALESCE(language, ''));
  CREATE INDEX memory_item_repo_kind ON memory_item(repo_id, kind, status);

  CREATE TABLE memory_revision (
    id         INTEGER PRIMARY KEY,
    item_id    INTEGER NOT NULL REFERENCES memory_item(id),
    version    INTEGER NOT NULL,
    batch_id   INTEGER NOT NULL REFERENCES memory_batch(id),
    content    TEXT NOT NULL,
    source     TEXT NOT NULL,
    status     TEXT NOT NULL,
    pinned     INTEGER NOT NULL,
    provenance TEXT NOT NULL,
    at         TEXT NOT NULL,
    UNIQUE (item_id, version)
  );
  CREATE INDEX memory_revision_batch ON memory_revision(batch_id);

  CREATE TABLE memory_use (
    job_id  INTEGER NOT NULL REFERENCES explain_job(id),
    part    TEXT NOT NULL,
    item_id INTEGER NOT NULL REFERENCES memory_item(id),
    version INTEGER NOT NULL,
    PRIMARY KEY (job_id, part, item_id)
  );

  ALTER TABLE repo ADD COLUMN memory_summaries INTEGER NOT NULL DEFAULT 0 CHECK (memory_summaries IN (0, 1));

  CREATE TABLE explain_job_new (
    id             INTEGER PRIMARY KEY,
    repo_id        INTEGER REFERENCES repo(id),
    change_unit_id INTEGER REFERENCES change_unit(id),
    kind           TEXT NOT NULL CHECK (kind IN ('explain','retry','area','context','memory')),
    area_id        TEXT,
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    prep_ms        INTEGER
  );
  INSERT INTO explain_job_new SELECT id, repo_id, change_unit_id, kind, area_id, started_at, finished_at, prep_ms FROM explain_job;
  DROP TABLE explain_job;
  ALTER TABLE explain_job_new RENAME TO explain_job;
  CREATE INDEX explain_job_started ON explain_job(started_at);
  CREATE INDEX explain_job_unit ON explain_job(change_unit_id, started_at);
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
