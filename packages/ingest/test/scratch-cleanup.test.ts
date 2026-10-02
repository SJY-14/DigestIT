import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import { closeDbs, removeScratchDirs } from './scratch-cleanup.mjs';

describe('scratch-cleanup (DIG-118 item 4)', () => {
  it('removes a scratch dir holding an open WAL-mode db once the connection is closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'digestit-cleanup-test-'));
    const db = openDb(join(dir, 'digestit.sqlite'));
    db.exec("INSERT INTO repo (name, path, mode) VALUES ('p', '/path/to/p', 'project')");
    // WAL mode (see packages/core/src/db.ts) keeps -wal/-shm siblings next to the main file while
    // the connection is open -- the directory this kit removes is not just the one .sqlite file.
    expect(readdirSync(dir).some((f) => f.endsWith('-wal'))).toBe(true);

    closeDbs([db]);
    removeScratchDirs([dir]);

    expect(existsSync(dir)).toBe(false);
  });

  it('closeDbs tolerates a connection already closed, so one pipeline cleanup never aborts another', () => {
    const dir = mkdtempSync(join(tmpdir(), 'digestit-cleanup-test-'));
    const db = openDb(join(dir, 'digestit.sqlite'));
    db.close();
    expect(() => closeDbs([db])).not.toThrow();
    removeScratchDirs([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  it('removeScratchDirs is a no-op on a directory that was never created', () => {
    const dir = join(tmpdir(), 'digestit-cleanup-test-never-created');
    expect(() => removeScratchDirs([dir])).not.toThrow();
  });
});
