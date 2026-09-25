import { openDb } from '@digestit/core';
import { describe, expect, it } from 'vitest';
import { buildFixture } from './fixture.js';

describe('buildFixture', () => {
  it('is deterministic for a given seed', () => {
    const now = new Date('2026-09-26T00:00:00Z');
    const a = openDb(':memory:');
    const b = openDb(':memory:');
    const ia = buildFixture(a, { seed: 7, days: 30, now });
    const ib = buildFixture(b, { seed: 7, days: 30, now });
    expect(ia).toEqual(ib);
    const dumpEvents = (db: typeof a) => db.prepare('SELECT * FROM unit_event ORDER BY id').all();
    expect(dumpEvents(a)).toEqual(dumpEvents(b));
    const dumpFiles = (db: typeof a) => db.prepare('SELECT * FROM file_change ORDER BY change_unit_id, path').all();
    expect(dumpFiles(a)).toEqual(dumpFiles(b));
  });

  it('a different seed produces a different dataset', () => {
    const now = new Date('2026-09-26T00:00:00Z');
    const a = openDb(':memory:');
    const b = openDb(':memory:');
    buildFixture(a, { seed: 1, days: 30, now });
    buildFixture(b, { seed: 2, days: 30, now });
    const dump = (db: typeof a) => db.prepare('SELECT * FROM commit_ ORDER BY sha').all();
    expect(dump(a)).not.toEqual(dump(b));
  });

  it('produces commits, file changes, and work units spanning several areas', () => {
    const db = openDb(':memory:');
    const info = buildFixture(db, { seed: 3, days: 90, now: new Date('2026-09-26T00:00:00Z') });
    expect(info.commitCount).toBeGreaterThan(50);
    expect(info.fileChangeCount).toBeGreaterThan(100);
    expect(info.workUnitIds.length).toBeGreaterThan(10);

    const areas = db.prepare("SELECT DISTINCT substr(path, 1, instr(path || '/', '/') - 1) AS top FROM file_change").all();
    expect((areas as { top: string }[]).length).toBeGreaterThan(3);

    const states = db.prepare('SELECT DISTINCT state FROM work_unit').all() as { state: string }[];
    expect(new Set(states.map((s) => s.state)).size).toBeGreaterThan(1);

    const kinds = db.prepare('SELECT DISTINCT kind FROM unit_event').all() as { kind: string }[];
    for (const k of ['landed', 'opened', 'level_viewed', 'reviewed']) {
      expect(kinds.map((r) => r.kind)).toContain(k);
    }
    expect((db.prepare('SELECT count(*) AS n FROM explain_call').get() as { n: number }).n).toBeGreaterThan(0);
  });

  it('foreign_key_check passes on the generated data', () => {
    const db = openDb(':memory:');
    buildFixture(db, { seed: 5, days: 90 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
