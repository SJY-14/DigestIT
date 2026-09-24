#!/usr/bin/env node
import { openDb } from '@digestit/core';
import { ingestRepo } from './ingest.js';
import { routeDigest } from './route.js';

const handled = await routeDigest(process.argv.slice(2));
if (handled !== undefined) process.exit(handled);
const [, path, ...rest] = process.argv.slice(2);
const dbFlag = rest.indexOf('--db');
const db = openDb(dbFlag >= 0 ? rest[dbFlag + 1] : process.env.DIGESTIT_DB);
try {
  const r = await ingestRepo(db, path!);
  console.log(`ingested ${path}: +${r.commitsAdded} commits, +${r.fileChangesAdded} file changes, ${r.refsUpdated} ref updates`);
} catch (e) {
  console.error(`ingest failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
} finally {
  db.close();
}
