import { openDb } from '@digestit/core';
import { describe, expect, it } from 'vitest';
import { buildFixture } from './fixture.js';
import { computeAreas, computeDigest, computeDrill, type Window } from './insights.js';

// M3-1 acceptance: every insights endpoint p95 < 300 ms on the 90-day fixture (T2-b is the
// fallback — aggregate tables instead of SQL-on-read — and switching to it is a CTO call).
// Timed against the pure query functions directly: `registerInsights` memoises identical
// requests on PRAGMA data_version, which would hide the real per-query cost behind cache hits.
const P95_BUDGET_MS = 300;
const RUNS = 20;
const WINDOWS: Window[] = ['7d', '30d', '90d'];

function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

function timed(fn: () => unknown): number {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return p95(samples);
}

describe('insights perf (90-day fixture)', () => {
  const now = new Date('2026-09-26T00:00:00Z');
  const db = openDb(':memory:');
  const info = buildFixture(db, { seed: 42, days: 90, now });

  it('computeAreas stays under budget for every window', () => {
    for (const window of WINDOWS) {
      const p = timed(() => computeAreas(db, { window, now }));
      console.log(`computeAreas(${window}) p95=${p.toFixed(1)}ms`);
      expect(p).toBeLessThan(P95_BUDGET_MS);
    }
  });

  it('computeDigest stays under budget for every window', () => {
    for (const window of WINDOWS) {
      const p = timed(() => computeDigest(db, { window, now }));
      console.log(`computeDigest(${window}) p95=${p.toFixed(1)}ms`);
      expect(p).toBeLessThan(P95_BUDGET_MS);
    }
  });

  it('computeDrill stays under budget', () => {
    const p = timed(() => computeDrill(db, { area: 'apps/web', window: '90d', now }));
    console.log(`computeDrill(area+window) p95=${p.toFixed(1)}ms`);
    expect(p).toBeLessThan(P95_BUDGET_MS);
    const idsP = timed(() => computeDrill(db, { ids: info.workUnitIds }));
    console.log(`computeDrill(ids, n=${info.workUnitIds.length}) p95=${idsP.toFixed(1)}ms`);
    expect(idsP).toBeLessThan(P95_BUDGET_MS);
  });
});
