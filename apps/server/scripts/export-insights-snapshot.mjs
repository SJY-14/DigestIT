#!/usr/bin/env node
// Regenerates the fixtures/insights-90d.json snapshot from the deterministic 90-day fixture
// (docs/milestone-3.md, M3-1). Frontend (M3-4..7) and briefing (M3-2) work can read this file
// directly instead of standing up a server; re-run after any change to fixture.ts or insights.ts:
//
//   pnpm --filter @digestit/server build && node apps/server/scripts/export-insights-snapshot.mjs
//
// Imports the built dist output (like bin/digest.js does), not src, so this only ever reflects
// what actually shipped.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@digestit/core';
import { buildFixture, computeAreas, computeDigest, computeDrill } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../fixtures/insights-90d.json');
const now = new Date('2026-09-26T00:00:00Z'); // fixed, so the snapshot is reproducible byte-for-byte

const db = openDb(':memory:');
const info = buildFixture(db, { seed: 42, days: 90, now });

const windows = ['7d', '30d', '90d'];
const snapshot = {
  generatedAt: now.toISOString(),
  fixture: { seed: 42, days: 90, repoId: info.repoId, workUnitIds: info.workUnitIds },
  areas: Object.fromEntries(windows.map((window) => [window, computeAreas(db, { window, now })])),
  digest: Object.fromEntries(windows.map((window) => [window, computeDigest(db, { window, now })])),
  drillSample: computeDrill(db, { area: 'apps/web', window: '30d', now }),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`wrote ${outPath}`);
