import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDb } from './db.js';

const tables = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

describe('migrate', () => {
  it('creates the architecture tables', () => {
    const db = openDb(':memory:');
    expect(tables(db)).toEqual(['area_explanation', 'change_unit', 'checkpoint', 'commit_', 'digest', 'explain_call', 'explanation', 'file_change', 'project_context', 'repo', 'rollup', 'unit_commit', 'unit_event', 'work_unit', 'worktree_state']);
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

  it('migrates a populated v2 database to v3 preserving rows and constraints', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of MIGRATIONS.slice(0, 2)) db.exec(m);
    db.exec('PRAGMA user_version = 2');
    db.exec(`INSERT INTO repo(name,path) VALUES('r','/r');
      INSERT INTO change_unit(id,repo_id,head_sha,title) VALUES(7,1,'a','t');
      INSERT INTO file_change(change_unit_id,path,status) VALUES(7,'p','M');
      INSERT INTO explanation VALUES(7,0,'{}','ok','stub','m','v1','h','now');
      INSERT INTO unit_event(repo_id,change_unit_id,kind,at) VALUES(1,7,'landed','now');`);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(n('SELECT id AS n FROM change_unit')).toBe(7);
    expect(n('SELECT count(*) AS n FROM file_change WHERE change_unit_id = 7')).toBe(1);
    expect(n('SELECT count(*) AS n FROM explanation WHERE change_unit_id = 7')).toBe(1);
    expect(n('SELECT count(*) AS n FROM unit_event WHERE change_unit_id = 7')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(() => db.exec("INSERT INTO change_unit(repo_id,head_sha,title) VALUES(1,'a','dup')")).toThrow();
  });
  it('v6 (direction v2): migrates populated v5 data and enforces the digest constraints', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of MIGRATIONS.slice(0, 5)) db.exec(m);
    db.exec('PRAGMA user_version = 5');
    db.exec(`INSERT INTO repo(name,path) VALUES('r','/r');
      INSERT INTO change_unit(id,repo_id,kind,head_sha,title) VALUES(3,1,'range','h','t');
      INSERT INTO explain_call(at,change_unit_id,reason,outcome) VALUES('now',3,'handoff','ok');`);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(n("SELECT count(*) AS n FROM explain_call WHERE change_unit_id = 3 AND reason = 'handoff'")).toBe(1);
    expect(db.prepare('SELECT mode FROM repo').get()).toEqual({ mode: 'history' });

    db.exec(`INSERT INTO repo(name,path,mode) VALUES('p','/p','project');
      INSERT INTO checkpoint(repo_id,seq,shadow_sha,tree_sha,taken_at,reason) VALUES(2,1,'s1','t1','now','init');
      INSERT INTO checkpoint(repo_id,seq,shadow_sha,tree_sha,taken_at,reason) VALUES(2,2,'s2','t2','now','explain');
      INSERT INTO change_unit(id,repo_id,kind,head_sha,base_sha,title) VALUES(10,2,'digest','s2','s1','Digest 1');
      INSERT INTO digest(change_unit_id,repo_id,from_checkpoint_id,to_checkpoint_id,created_at) VALUES(10,2,1,2,'now');
      INSERT INTO area_explanation VALUES(10,'api','{}','ok','stub','m','a1','h','now');
      INSERT INTO explain_call(at,change_unit_id,reason,outcome) VALUES('now',10,'area','ok');`);
    expect(() => db.exec("INSERT INTO repo(name,path,mode) VALUES('x','/x','bogus')")).toThrow();
    expect(() => db.exec("INSERT INTO checkpoint(repo_id,seq,shadow_sha,tree_sha,taken_at,reason) VALUES(2,2,'s','t','now','init')")).toThrow();
    expect(() => db.exec("INSERT INTO change_unit(repo_id,kind,head_sha,title) VALUES(2,'digest','s2','dup')")).toThrow();
    expect(() => db.exec("INSERT INTO area_explanation VALUES(10,'api','{}','ok','stub','m','a1','h','now')")).toThrow();
    expect(() => db.exec("INSERT INTO explain_call(at,reason,outcome) VALUES('now','bogus','ok')")).toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
