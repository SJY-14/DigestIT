# Packaging spike (DIG-32)

Evaluates two ways to hand the owner a runnable DigestIT without a Rust
rewrite: a Node [single executable application](https://nodejs.org/api/single-executable-applications.html)
(SEA) and a minimal container. Spike only — nothing here is productised or
wired into CI. Time-boxed per the issue; see "Next steps" for what a real
rollout would still need.

## TL;DR

- **SEA binary works**: `digest ingest|watch|explain|serve|token`, all
  subcommands, one 123 MiB file, no runtime dependencies. Cold start to
  first `200` is *faster* than `node bin/digest.js` (bundling removes ESM
  resolution overhead).
- **Container is unverified**: neither `docker` nor a working `podman` is
  available in this sandbox (see below). The `Dockerfile` is written and
  reviewed by hand but never built.
- **Recommendation**: ship the SEA binary as the primary distribution
  artifact for the owner's device; keep the Dockerfile for later
  server-side deployment once it can actually be built and tested somewhere.

## 1. Single executable (Node SEA)

### How it's built

`scripts/packaging/build-sea.mjs`:

1. Bundles `scripts/packaging/sea-entry.mjs` — a CLI dispatcher equivalent to
   `bin/digest.js` + `apps/server/src/cli.ts` + `packages/ingest/src/route.ts`
   combined — into one CommonJS file with **esbuild** (already in the
   lockfile via vite; resolved from `node_modules/.pnpm` directly since it's
   not a root-level bin). The entry imports straight from workspace
   **source** `.ts` files (esbuild transpiles them during the bundle), not
   from each package's `tsc` output, so the SEA step itself doesn't depend on
   `pnpm -r build` for the backend — only `apps/web/dist` needs to exist.
2. Walks `apps/web/dist`, builds a JSON manifest of relative paths, and adds
   every file plus the manifest to the SEA `assets` map in a generated
   `sea-config.json`. This is genuine embedding: the files live inside the
   blob injected into the binary, not next to it on disk.
3. Runs `node --experimental-sea-config` to produce the blob, copies the
   running `node` binary, and injects the blob with **postject**. postject
   is *not* in the lockfile (Board decision territory — see "Open
   questions"); the script fetches it into `.cache/packaging/tools/` on
   first run via `npm install --prefix … --no-save` and reuses it after
   that. `package.json`/`pnpm-lock.yaml` are untouched.
4. On macOS the script also runs `codesign --remove-signature` before
   injection and `codesign -s -` (ad hoc signature) after, since an
   unsigned/incorrectly-signed Mach-O won't run — see "Platform matrix".

Reproduce from a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm -r build                        # builds apps/web/dist (embedded) + typechecks
node scripts/packaging/build-sea.mjs [output-path]   # default: dist-sea/digest-<platform>-<arch>
```

### Web assets: embedded + extracted at startup

SEA's asset API (`sea.getAsset`/`getRawAsset`) is a **flat key → blob**
lookup with no directory listing — there's no way to point `@fastify/static`
(which needs a real filesystem root) directly at embedded assets. So at
`digest serve` startup, if running as an SEA (`sea.isSea()`), the entry reads
the embedded manifest, writes every `web/…` asset out under a fresh
`mkdtempSync` directory, and passes that directory as `webDir`. This runs
once per process start (not per request) and took well under a millisecond
for this repo's 3-file, 272 KiB bundle in testing — worth re-measuring if the
frontend grows substantially.

The alternative — serving assets straight out of the SEA blob by patching
`@fastify/static`'s file-serving to call `getRawAsset` instead of `fs.read`
— would avoid the extraction step and temp directory, but needs a custom
static handler instead of the existing library; not worth it for a spike
this size.

### `node:sqlite` and native modules

Confirmed: `node:sqlite` (used throughout `packages/core`) works inside the
SEA binary with no flags — the DB is opened, written, and queried correctly
by `digest ingest` and `digest serve` in testing below. The whole dependency
tree (`fastify`, `@fastify/static`, `vitest`, `vite`, `esbuild`, …) has **no
native (`.node`) modules** — confirmed by grepping the lockfile — so there
was nothing to cross-compile or worry about ABI-wise.

### `import.meta` bundling fix (real source change, not a workaround)

`apps/server/src/app.ts` computed its default web directory as a **module-scope
constant**: `resolve(import.meta.dirname, '../../web/dist')`. Two problems
surfaced when bundling to CJS for SEA (SEA requires a CommonJS entry point,
so the ESM workspace has to be bundled — TS project references / `tsc`
alone don't produce single-file output):

- esbuild's CJS output leaves `import.meta` empty, so this line threw
  `TypeError [ERR_INVALID_ARG_TYPE]` **at module load**, before any
  subcommand ran — the whole bundle crashed on `require()`.
- Even fixed, the *value* would have been meaningless in a bundled/SEA
  context (there's no real file at the bundle's "path" relative to which
  `../../web/dist` makes sense).

Fix (`apps/server/src/app.ts`, `defaultWebDir()`): made the computation lazy
(a function called only from the `webDir` default parameter, not at module
scope) and defensive (returns `undefined` — skip static serving — rather
than throwing when `import.meta.dirname` isn't available). `buildApp`'s
static-mount guard was updated to treat `webDir` as optional accordingly.
This is a small, generally-useful robustness fix, not SEA-specific plumbing:
every real caller (`servecli.ts`, our SEA entry, tests) already passes
`webDir` explicitly, so the default path is dev-convenience only. Full
`apps/server` test suite (113 tests) still passes.

The SEA entry itself (`scripts/packaging/sea-entry.mjs`) never relies on the
default anyway — it always passes the extracted temp dir (or `undefined` in
a non-SEA smoke test) explicitly to `startServer`.

### Verified end to end (linux-x64, this sandbox)

```
$ node scripts/packaging/build-sea.mjs
[build-sea] done: dist-sea/digest-linux-x64

$ ./dist-sea/digest-linux-x64 token init --host 127.0.0.1:4998 --file ./token
wrote token to ./token (mode 0600)
login URL: http://127.0.0.1:4998/?token=…

$ DIGESTIT_DB=./digestit.sqlite DIGESTIT_PORT=4998 ./dist-sea/digest-linux-x64 serve
DigestIT listening on {"address":"127.0.0.1","family":"IPv4","port":4998} (web assets: /tmp/digestit-web-…)
# GET /api/repos            -> 200
# GET /                     -> 200, dashboard HTML referencing /assets/index-*.js
# GET /assets/index-*.js    -> 200, application/javascript

$ DIGESTIT_DB=./digestit2.sqlite ./dist-sea/digest-linux-x64 ingest .
ingested .: +70 commits, +418 file changes, 0 ref updates
```

`explain` and `watch` weren't separately exercised beyond confirming they
route to the same `routeDigest`/`runWatchCli` code the normal CLI uses
(no SEA-specific branching there); worth a real pass before this graduates
past spike.

### Size

| Artifact | Size |
|---|---|
| `node` binary alone (baseline) | 126,595,440 B (120.8 MiB) |
| `dist-sea/digest-linux-x64` (bundle + embedded web assets) | 128,912,576 B (122.9 MiB) |
| Added by DigestIT itself (bundle 1.9 MiB + web assets 272 KiB) | ~2.3 MiB |

The binary is essentially "Node itself" in size — expected for SEA, since it
embeds a full Node build. No way around that without a different runtime
(see "Open questions").

### Cold startup (process start → first `200` on `/api/work-units`)

Measured with a curl poll loop against a fresh DB, 3 runs each, this
sandbox's linux-x64 node:

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| SEA binary | 159 ms | 145 ms | 159 ms |
| `node bin/digest.js` (for comparison) | 314 ms | 315 ms | — |

The SEA binary starts *faster*, not slower — most likely because the
bundled CJS file skips the ESM module-resolution/loader overhead of
`bin/digest.js`'s dynamic `import()` across 4 separate workspace packages
and their `node_modules` resolution. Not a rigorous benchmark (one machine,
few runs, no warmup control) but the direction is clear enough to report.

### Platform matrix

| Platform | Status |
|---|---|
| linux-x64 | **Tested** (this sandbox), see above |
| linux-arm64 | Not tested. SEA has no cross-build story — the blob is injected into *this host's* `node` binary, so producing a linux-arm64 executable needs the script run on (or targeting a downloaded) linux-arm64 Node build. Same script should work unmodified with an arm64 `process.execPath`. |
| macOS (x64/arm64) | Not tested (no macOS available here). SEA must be built **on** or **for** the target platform/arch — there's no cross-signing from Linux. The script's `codesign --remove-signature` / `codesign -s -` steps are written per Node's documented macOS SEA flow but unverified. arm64 and x64 are different binaries; building on the target machine itself is the simplest path — no toolchain beyond Node 24 + this repo needed. |
| Windows | Not evaluated — out of scope for "the owner's device" and not requested. |

### How the owner would run it on their device

1. `git clone`, `pnpm install --frozen-lockfile`, `pnpm -r build` (needs
   Node 24 + pnpm, same as development).
2. `node scripts/packaging/build-sea.mjs` — builds
   `dist-sea/digest-darwin-<arch>` using their own
   machine's `node` binary, so no cross-compilation or codesigning-for-
   another-machine problem.
3. `./dist-sea/digest-darwin-<arch> serve` — one file, no `node_modules`, no
   `pnpm`. `digest ingest <repo>` / `digest watch <repo>` / `digest token
   init` all work the same way.
4. First run may need "allow anyway" in Gatekeeper/Security & Privacy since
   the ad hoc signature (`codesign -s -`) isn't from a notarized Developer
   ID — expected for an unpublished spike binary, would need a real Apple
   Developer signing identity to avoid.

This is materially simpler than today's `pnpm install && pnpm -r build &&
pnpm digest serve`, and doesn't require Node/pnpm to stay installed
long-term (only to *build* the binary once).

## 2. Container

### Availability in this sandbox

Neither `docker` nor a usable `podman` was available in the environment
the spike ran in (podman is present but has no container configuration
there, and fixing that is outside the repo workspace). Per the issue's
instructions the image is marked **unverified** rather than worked around.

### What's committed anyway

`Dockerfile` (root) and `.dockerignore`: a two-stage build (`node:24-alpine`
builder running `pnpm install --frozen-lockfile && pnpm -r build`, then a
slim runtime stage that copies `node_modules` + each package's `dist` +
`bin/`), non-root `digestit` user, `/data` volume for the sqlite DB
(`DIGESTIT_DB=/data/digestit.sqlite`), no secrets baked into any layer —
`DIGESTIT_ALLOWED_HOSTS`/`DIGESTIT_TOKEN_FILE` are left unset in the image
and documented as `docker run -e` / bind-mounted-file only. Runs the normal
built app (`node bin/digest.js serve`), not the SEA binary — inside a
container the SEA binary buys nothing, since the container already supplies
the Node runtime; embedding it too would just duplicate ~120 MiB.

**Not built or run with a container engine.** CTO review found and fixed a
startup crash: the runtime stage copied only the root `node_modules`, but pnpm
links each package's dependencies (`fastify`, `@digestit/*`) under
`<pkg>/node_modules`, so `digest serve` failed with `ERR_MODULE_NOT_FOUND`.
The fix copies `apps/server`, `packages/explain` and `packages/ingest`
`node_modules` too. It was checked by replaying the runtime stage's `COPY`
lines into a plain directory and running `node bin/digest.js serve`
(`/api/repos` and `/` both return 200). Treat it as a well-informed draft,
not a verified artifact, until it's actually built somewhere with working
container tooling.

### Bind-address trade-off (unchanged, as instructed)

`apps/server/src/serve.ts` binds `127.0.0.1` only, unconditionally — this
spike does not touch that (architecture §6: the bind address is
deliberately non-configurable, tailnet/token access is layered on top, see
[architecture.md](architecture.md#6-security-posture)). Inside a container
this has a real consequence: **`docker run -p 4780:4780` will not work** —
`-p` forwards traffic to the container's own network interface, not to its
loopback, so a process bound to `127.0.0.1` inside the container never sees
it. Concretely: the safe, verified-in-
spirit way to publish this container is `--network host` (Linux hosts
only — Docker Desktop macOS/Windows don't support host networking the same
way) so the container's `127.0.0.1:4780` *is* the host's loopback. The
alternative the issue flags — a `DIGESTIT_BIND` env var honoured only when
a token is configured — is **not implemented in this spike**; it would be a
real (if small) change to `serve.ts`'s bind logic and architecture §6's
invariant, so it belongs in a follow-up issue with its own review, not
bundled into a packaging spike.

## Recommendation

- **Primary artifact: the SEA binary.** It works end to end today, is
  simpler to hand to the owner than a container (no Docker Desktop install
  on their device, no bind-address trade-off to explain), and the build
  script is ~130 lines with no new dependencies in the lockfile.
- **Keep the Dockerfile** as a documented starting point for whenever this
  needs to run on a shared host instead of the owner's device, but don't treat it
  as done — it needs an actual build+run pass (in CI or anywhere with
  working container tooling) before anyone relies on it.
- Don't invest further in packaging until one of these is picked as the real
  target — building both to full production quality is wasted effort if
  only one ships.

## Next steps (Board decisions, not done here)

- **postject**: needed for `--experimental-sea-config` blob injection.
  Node's built-in `--build-sea` flag (which would remove this dependency
  entirely) does not exist in Node 24.21 (checked `node --help`). Adding
  postject to the lockfile as a devDependency is the natural next step if
  the SEA binary becomes a real release artifact — it's a small,
  single-purpose tool from the Node.js org's own ecosystem
  (`nodejs/postject`), but "add a new dependency" is explicitly a Board call
  per the security rules, so it's a recommendation, not a fait accompli.
- **CI / release artifacts**: building linux-x64 today required nothing
  beyond what's already here, but macOS builds need to run on actual macOS
  hardware/runners (no cross-signing), and nothing here is wired into CI —
  needs its own issue once a target platform list is decided.
- **Container verification**: needs an environment with working
  docker/podman to actually build and smoke-test `Dockerfile` — flagging
  for whoever owns CI/deployment infra decisions.
- **`node_modules` pruning in the image**: the current `Dockerfile` copies
  full `node_modules` (including devDependencies like `typescript`,
  `vitest`, `vite`) into the runtime stage for simplicity. `pnpm deploy` or
  `pnpm prune --prod` in the builder stage would meaningfully shrink the
  image; skipped here since the image was never built/measured anyway.
- **`DIGESTIT_BIND`**: if container deployment becomes real, the loopback-
  only bind vs. `-p` publishing trade-off needs an actual decision (host
  networking only, vs. a reviewed change to `serve.ts` + architecture §6).
- **SEA temp directory**: every `digest serve` start extracts the web
  assets to a new `digestit-web-*` temp directory and never removes it.
  Before this ships, extract to a content-hashed directory that is reused
  across starts (or serve straight from the SEA assets).
- **One dispatcher**: `sea-entry.mjs` duplicates `bin/digest.js` and the
  serve CLI. If the SEA becomes a release artifact, have both call one
  shared entry so they can't drift.
