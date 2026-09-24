import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDb } from './db.js';

const tables = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

describe('migrate', () => {
  it('creates the architecture tables', () => {
    const db = openDb(':memory:');
    expect(tables(db)).toEqual(['change_unit', 'commit_', 'explanation', 'file_change', 'repo', 'unit_event', 'worktree_state']);
  });

  it('is idempotent and records the version', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
  });

  it('creates missing parent dirs for a file DB', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'dig-')), 'a/b/test.sqlite'));
    expect(tables(db)).toContain('repo');
  });

  it('enforces unique (change_unit, level, prompt_version) and level range', () => {
    const db = openDb(':memory:');
    db.exec("INSERT INTO repo(name,path) VALUES('r','/r')");
    db.exec("INSERT INTO change_unit(repo_id,head_sha,title) VALUES(1,'a','t')");
    const ins = (level: number) =>
      db.exec(`INSERT INTO explanation VALUES(1,${level},'{}','ok','stub','m','v1','h','now')`);
    ins(0);
    expect(() => ins(0)).toThrow();
    expect(() => ins(4)).toThrow();
  });

  it('rejects invalid file_change status', () => {
    const db = openDb(':memory:');
    db.exec("INSERT INTO repo(name,path) VALUES('r','/r')");
    db.exec("INSERT INTO change_unit(repo_id,head_sha,title) VALUES(1,'a','t')");
    expect(() => db.exec("INSERT INTO file_change(change_unit_id,path,status) VALUES(1,'p','X')")).toThrow();
  });
});
