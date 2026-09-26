import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDir0700, openProjectDb, projectDataDir, resolveDbPath, resolveHome } from './datahome.js';

describe('resolveHome / resolveDbPath', () => {
  it('uses a real path for an explicit --db override', () => {
    expect(resolveHome('/tmp/x/digestit.sqlite')).toBe('/tmp/x');
    expect(resolveDbPath('/tmp/x/digestit.sqlite')).toBe('/tmp/x/digestit.sqlite');
  });

  it('gives ":memory:" its own fresh temp home instead of resolving cwd', () => {
    const home1 = resolveHome(':memory:');
    const home2 = resolveHome(':memory:');
    expect(resolveDbPath(':memory:')).toBe(':memory:');
    expect(home1).not.toBe(process.cwd());
    expect(home1).not.toBe(home2); // each call gets its own dir, callers don't collide
    expect(statSync(home1).isDirectory()).toBe(true);
    rmSync(home1, { recursive: true, force: true });
    rmSync(home2, { recursive: true, force: true });
  });
});

describe('openProjectDb', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it('opens an in-memory db under its own temp home, without touching cwd', () => {
    const { db, home, dbPath } = openProjectDb(':memory:');
    dirs.push(home);
    expect(dbPath).toBe(':memory:');
    expect(home).not.toBe(process.cwd());
    expect(existsSync(home)).toBe(true);
    expect(db.prepare('PRAGMA user_version').get()).toBeTruthy();
    db.close();
  });

  it('creates the home dir 0700 for a real --db path', () => {
    const root = mkdtempSync(join(tmpdir(), 'digestit-datahome-'));
    dirs.push(root);
    const dbPath = join(root, 'sub', 'digestit.sqlite');
    const { db, home } = openProjectDb(dbPath);
    expect(home).toBe(join(root, 'sub'));
    expect(statSync(home).mode & 0o777).toBe(0o700);
    db.close();
  });
});

describe('ensureDir0700 / projectDataDir', () => {
  it('creates parents and forces 0700 regardless of umask', () => {
    const root = mkdtempSync(join(tmpdir(), 'digestit-datahome-'));
    try {
      const dir = join(root, 'a', 'b');
      ensureDir0700(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scopes each project under home/projects/<id>', () => {
    expect(projectDataDir('/home/x', 3)).toBe('/home/x/projects/3');
  });
});
