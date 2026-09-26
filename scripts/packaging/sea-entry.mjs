// Bundled by esbuild into one CJS file for the Node SEA build (see build-sea.mjs and
// docs/packaging.md). Mirrors bin/digest.js's dispatch, but:
//  - `serve` always resolves an explicit webDir (SEA has no on-disk apps/web/dist to default to;
//    assets are embedded and extracted to a temp dir on first run, see extractWebAssets below).
//  - everything imports straight from workspace *source* (.ts) so the spike doesn't depend on
//    each package's tsc dist output; esbuild transpiles it during the bundle step.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import sea from 'node:sea';

import { openDb } from '../../packages/core/src/db.ts';
import { ingestRepo } from '../../packages/ingest/src/ingest.ts';
import { routeDigest, INGEST_USAGE } from '../../packages/ingest/src/route.ts';
import { runTokenCli } from '../../apps/server/src/auth.ts';
import { startServer, resolvePort } from '../../apps/server/src/serve.ts';
import { SERVE_USAGE } from '../../apps/server/src/servecli.ts';

// Extracts the embedded apps/web/dist tree to a fresh temp dir and returns its path. Assets are
// looked up by a flat "web/<relPath>" key (SEA has no directory listing API), driven by a
// manifest asset (JSON array of relPaths) embedded alongside them by build-sea.mjs.
function extractWebAssets() {
  const manifestRaw = sea.getAsset('web-manifest.json', 'utf8');
  const manifest = JSON.parse(manifestRaw);
  if (manifest.length === 0) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'digestit-web-'));
  for (const relPath of manifest) {
    const buf = Buffer.from(sea.getRawAsset(`web/${relPath}`));
    const dest = join(dir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
  }
  return dir;
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd] = argv;

  if (cmd === 'serve') {
    const webDir = sea.isSea() ? extractWebAssets() : undefined;
    let values;
    try {
      ({ values } = parseArgs({ args: argv.slice(1), options: { port: { type: 'string' }, db: { type: 'string' } } }));
    } catch (e) {
      console.error(`${e instanceof Error ? e.message : String(e)}\n${SERVE_USAGE}`);
      process.exit(2);
    }
    try {
      const port = values.port !== undefined ? resolvePort({ DIGESTIT_PORT: values.port }) : undefined;
      const app = await startServer({ dbPath: values.db ?? process.env.DIGESTIT_DB, port, webDir });
      console.log(`DigestIT listening on ${JSON.stringify(app.server.address())}${webDir ? ` (web assets: ${webDir})` : ' (no web assets embedded)'}`);
    } catch (e) {
      console.error(`serve failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    return; // stay alive on the open socket, same as bin/digest.js
  }

  if (cmd === 'token') {
    process.exit(runTokenCli(argv));
  }

  const handled = await routeDigest(argv);
  if (handled !== undefined) process.exit(handled);

  const [, path, ...rest] = argv;
  const dbFlag = rest.indexOf('--db');
  const db = openDb(dbFlag >= 0 ? rest[dbFlag + 1] : process.env.DIGESTIT_DB);
  try {
    const r = await ingestRepo(db, path);
    console.log(`ingested ${path}: +${r.commitsAdded} commits, +${r.fileChangesAdded} file changes, ${r.refsUpdated} ref updates`);
  } catch (e) {
    console.error(`ingest failed: ${e instanceof Error ? e.message : String(e)}\n${INGEST_USAGE}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
