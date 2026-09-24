#!/usr/bin/env node
import { openDb } from '@digestit/core';
import { ingestRepo } from './ingest.js';

const [cmd, path, ...rest] = process.argv.slice(2);
if (cmd !== 'ingest' || !path) {
  console.error('usage: digest ingest <path> [--db <file>]');
  process.exit(2);
}
const dbFlag = rest.indexOf('--db');
const db = openDb(dbFlag >= 0 ? rest[dbFlag + 1] : process.env.DIGESTIT_DB);
try {
  const r = await ingestRepo(db, path);
  console.log(`ingested ${path}: +${r.commitsAdded} commits, +${r.fileChangesAdded} file changes, ${r.refsUpdated} ref updates`);
} catch (e) {
  console.error(`ingest failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
} finally {
  db.close();
}
