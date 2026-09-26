#!/usr/bin/env node
// Builds a single-executable (Node SEA) `digest` binary: server + CLI, with apps/web/dist
// embedded as SEA assets and extracted to a temp dir at startup (see sea-entry.mjs). Spike for
// DIG-32 — see docs/packaging.md for what works, sizes, and open questions.
//
// Prerequisite: `pnpm install --frozen-lockfile && pnpm -r build` (builds apps/web/dist and
// typechecks the workspace; this script bundles from *source* .ts via esbuild, not from each
// package's tsc dist output, so a `pnpm -r build` skip only affects whether apps/web/dist exists).
//
// esbuild comes from the lockfile (vite's dependency, already vetted); postject does not — it is
// fetched into .cache/packaging/tools/ on demand and is NOT added to package.json or the lockfile
// (Board decision per DIG-32). Requires network access to the npm registry on first run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const CACHE = join(ROOT, '.cache/packaging');
const TOOLS_DIR = join(CACHE, 'tools');
const WEB_DIST = join(ROOT, 'apps/web/dist');
const ENTRY = join(ROOT, 'scripts/packaging/sea-entry.mjs');
const BUNDLE = join(CACHE, 'digest-bundle.cjs');
const SEA_CONFIG = join(CACHE, 'sea-config.json');
const BLOB = join(CACHE, 'sea-prep.blob');
const MANIFEST = join(CACHE, 'web-manifest.json');
const POSTJECT_VERSION = '1.0.0-alpha.6';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const outPath = process.argv[2] ?? join(ROOT, 'dist-sea', `digest-${process.platform}-${process.arch}`);

function log(msg) {
  console.log(`[build-sea] ${msg}`);
}

function findEsbuildBin() {
  const pnpmDir = join(ROOT, 'node_modules/.pnpm');
  const entry = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
  if (!entry) throw new Error('esbuild not found in node_modules/.pnpm — run `pnpm install` first');
  return join(pnpmDir, entry, 'node_modules/esbuild/bin/esbuild');
}

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function ensurePostject() {
  const bin = join(TOOLS_DIR, 'node_modules/.bin/postject');
  if (existsSync(bin)) return bin;
  log(`postject not found in .cache/ — installing ${POSTJECT_VERSION} there (not in the workspace lockfile)`);
  mkdirSync(TOOLS_DIR, { recursive: true });
  writeFileSync(join(TOOLS_DIR, 'package.json'), JSON.stringify({ name: 'digestit-packaging-tools', private: true }));
  execFileSync('npm', ['install', '--prefix', TOOLS_DIR, `postject@${POSTJECT_VERSION}`, '--no-save', '--no-audit', '--no-fund'], {
    stdio: 'inherit',
  });
  if (!existsSync(bin)) throw new Error('postject install did not produce the expected binary');
  return bin;
}

if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.error(`apps/web/dist/index.html not found — run \`pnpm -r build\` first (looked in ${WEB_DIST})`);
  process.exit(1);
}

mkdirSync(CACHE, { recursive: true });
mkdirSync(join(ROOT, 'dist-sea'), { recursive: true });

log('bundling CLI + server entry with esbuild...');
const esbuild = findEsbuildBin();
execFileSync(
  esbuild,
  [ENTRY, '--bundle', '--platform=node', '--format=cjs', '--target=node24', `--outfile=${BUNDLE}`, '--external:node:*'],
  { stdio: 'inherit' },
);

log('collecting apps/web/dist assets...');
const webFiles = walkFiles(WEB_DIST);
const manifest = webFiles.map((f) => relative(WEB_DIST, f));
writeFileSync(MANIFEST, JSON.stringify(manifest));

const assets = { 'web-manifest.json': MANIFEST };
for (const f of webFiles) assets[`web/${relative(WEB_DIST, f)}`] = f;

writeFileSync(
  SEA_CONFIG,
  JSON.stringify(
    {
      main: BUNDLE,
      output: BLOB,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  ),
);

log(`generating SEA blob (${manifest.length} web assets embedded)...`);
rmSync(BLOB, { force: true });
execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { stdio: 'inherit', cwd: CACHE });

log(`copying node binary -> ${outPath}`);
mkdirSync(resolve(outPath, '..'), { recursive: true });
execFileSync('node', ['-e', `require('fs').copyFileSync(process.execPath, ${JSON.stringify(outPath)})`], { stdio: 'inherit' });

if (process.platform === 'darwin') {
  log('macOS: removing existing signature before injection (codesign --remove-signature)');
  try {
    execFileSync('codesign', ['--remove-signature', outPath], { stdio: 'inherit' });
  } catch (e) {
    log(`codesign --remove-signature failed (continuing): ${e instanceof Error ? e.message : e}`);
  }
}

log('injecting SEA blob with postject...');
const postject = ensurePostject();
const postjectArgs = [outPath, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
execFileSync(postject, postjectArgs, { stdio: 'inherit' });

chmodSync(outPath, 0o755);

if (process.platform === 'darwin') {
  log('macOS: re-signing with an ad hoc signature (codesign -s -)');
  try {
    execFileSync('codesign', ['-s', '-', outPath], { stdio: 'inherit' });
  } catch (e) {
    log(`codesign -s - failed (continuing, binary may not run unmodified on macOS): ${e instanceof Error ? e.message : e}`);
  }
}

log(`done: ${outPath}`);
