# Operations

How the operator runs DigestIT on the server and publishes it over the
tailnet. See [architecture.md §6](architecture.md#6-security-posture) for the
reasoning behind the allowlist + token.

## Running locally (loopback, reads open, writes need the token)

No extra env vars needed. The server only answers requests whose `Host`
header is `localhost`/`127.0.0.1`/`[::1]` (any port). Reads (the dashboard,
`/api/projects`, `/api/digests/*`, the SSE stream, …) stay unauthenticated on
loopback — fine for a laptop or a dev box nobody else can reach.

Writes are different (v2, docs/direction-v2.md §4): registering a project,
**Explain**, a lazy L3 click and a context refresh all spend the shared LLM
budget, so they always require a token, even on plain loopback with no
`DIGESTIT_ALLOWED_HOSTS` configured — another local user on a shared host, or
just a stray browser tab, could otherwise spend it. The first time `digest
serve` runs, it creates `$DIGESTIT_HOME/token` (mode `0600`) and prints the
login URL once, to the terminal only:

```sh
pnpm digest serve                       # http://127.0.0.1:4780
```
```
login URL: http://127.0.0.1:4780/?token=<token>
```

Visiting that URL once sets the session cookie the same way the tailnet flow
below does (§3); after that, the dashboard's own Explain/refresh buttons work
without any extra step. Re-running `serve` reuses the same token file, so the
URL is only printed again if that file is deleted. `digest init <path>` (the
CLI) needs no token — running it is the consent to send that project's
(redacted) code to the provider.

```sh
pnpm digest watch <repo-path>           # separate process, next to serve
```

`digest watch <repo-path>` polls the repo, ingests new commits and (unless
`--no-explain`) generates explanations. Useful flags:

```sh
pnpm digest watch <repo-path> \
  --db <file>            # default $DIGESTIT_DB
  --provider <name>      # stub | claude-code, default $DIGESTIT_PROVIDER or stub
  --allow <repo,...>     # repo allowlist, default $DIGESTIT_ALLOWLIST or DigestIT
  --budget <n>            # LLM calls/day, default $DIGESTIT_DAILY_BUDGET
  --no-explain            # track and link only, no LLM calls
```

## Publishing over the tailnet (port 4780)

The bind address is always `127.0.0.1` — that is not configurable. Tailscale
serve maps the tailnet hostname to that loopback port; the tailnet ACL should
allow only the owner's device to reach it. Because other local users may
share the host, loopback alone stops being an access boundary once
the server is reachable off-box, so this mode also requires a token.

### 1. Create the token

```sh
pnpm digest token init \
  --host dashboard.example.ts.net:4780 \
  --file /path/outside/the/repo/digestit-token   # e.g. ~/.digestit/token
```

This writes a fresh random token to `--file` (mode `0600`, owner read/write
only — it writes a new file and renames it over any existing one, so the
token is never written into a file with looser permissions) and prints a one-time login URL:

```
login URL: http://dashboard.example.ts.net:4780/?token=<token>
```

Keep the token file outside the repo. Copy the login URL over a channel you
already trust (e.g. type it directly into the browser on the owner's
machine, or paste it through an existing `tailscale ssh` session) — treat it
like a password: don't paste it into chat, an issue, or a commit.

### 2. Start the server with the allowlist + token

```sh
DIGESTIT_ALLOWED_HOSTS=dashboard.example.ts.net:4780 \
DIGESTIT_TOKEN_FILE=/path/outside/the/repo/digestit-token \
DIGESTIT_DB=/path/to/digestit.sqlite \
pnpm digest serve
```

`DIGESTIT_ALLOWED_HOSTS` is a comma-separated list of `host[:port]` values
accepted in addition to loopback; any other `Host` header still gets `421`.
If `DIGESTIT_ALLOWED_HOSTS` is set but `DIGESTIT_TOKEN_FILE` is missing,
unreadable, not mode `0600`, or empty, `digest serve` refuses to start —
this is intentional (fail closed), not a bug.

Run `digest watch` the same way, pointed at the repo to track:

```sh
DIGESTIT_DB=/path/to/digestit.sqlite pnpm digest watch /path/to/DigestIT --allow DigestIT
```

`digest watch` never binds a port and has no allowlist/token of its own — it
only writes to the same SQLite file `serve` reads from.

### 3. Log in from the browser

Visit the login URL from step 1 once. The server validates the token,
sets an `HttpOnly`, `SameSite=Strict`, `Path=/` `digestit_session` cookie
(no `Secure` attribute — the tailnet transport is plain HTTP over
WireGuard, already encrypted at that layer), and redirects to `/` with the
query string stripped so the token doesn't end up in browser history for
that URL. After that, every route — static assets, `/api/*`, the SSE
stream, `POST /api/ui-events`, and the v2 write routes (project
registration, Explain, L3 clicks, context refresh) — accepts either that
cookie or an `Authorization: Bearer <token>` header; anything else gets
`401` with no data. `DIGESTIT_ALLOWED_HOSTS` folds the loopback-only
write-token described above into this same one: once it is set, no separate
`$DIGESTIT_HOME/token` file is created.

The v2 write routes also require `Content-Type: application/json` and an
`Origin` matching the request's `Host` (CSRF); the dashboard already sends
both, so this only matters if you are scripting against the API directly.

### Registering a project from the dashboard

`POST /api/projects` (the dashboard's "add a project" flow) only succeeds
for a path under one of the directories listed in `DIGESTIT_PROJECT_ROOTS`
(comma-separated, realpath'd at startup so a symlink cannot point outside an
allowed root); unset or a path outside every root gets `403`. This is a
browser-facing restriction only — `digest init <path>` from the CLI can
still register any path, since running it is itself the consent.

### Rotating the token

Re-run `digest token init` with the same `--file` (it overwrites the file,
still `0600`) and restart `digest serve` — it reads the token file once at
startup. The old token, and any browser session cookie set from it, stops
working immediately on restart. Send the new login URL to the operator the
same way as before.

On plain loopback (no `DIGESTIT_ALLOWED_HOSTS`), rotate the write-only token
the same way: delete `$DIGESTIT_HOME/token` and restart `digest serve` — it
mints a fresh one and prints the login URL again.

## The project graph cache

`GET /api/digests/:id/graph` keeps a small in-memory LRU (default 50 entries,
one per `(digest, expand)` pair) inside the running `serve` process — a
digest's checkpoint tree never changes, so a repeat request for the same
folders is free. It holds no secrets (same data as the response body) and
resets on restart; no operator action needed.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `DIGESTIT_DB` | `serve`, `watch`, `explain` | SQLite file path (default: package default, see `openDb`) |
| `DIGESTIT_HOME` | `serve`, and any `project`/`digest`/`explain` CLI command | Data dir for `digestit.sqlite`, per-project shadow stores and the write-token file (default `$XDG_DATA_HOME/digestit` or `~/.local/share/digestit`; ignored if `--db`/`DIGESTIT_DB` is set, or in dev/tests where `.cache/digestit.sqlite` exists) |
| `DIGESTIT_PORT` | `serve` | Port to bind (default `4780`); host is always `127.0.0.1` |
| `DIGESTIT_ALLOWED_HOSTS` | `serve` | Comma-separated `host[:port]` allowed besides loopback; unset = loopback only. Reads stay unauthenticated; writes always need a token regardless (see above) |
| `DIGESTIT_TOKEN_FILE` | `serve`, `token init` (as a default for `--file`) | Path to the `0600` access-token file; mandatory once `DIGESTIT_ALLOWED_HOSTS` is set, and doubles as the write token |
| `DIGESTIT_PROJECT_ROOTS` | `serve` | Comma-separated directories `POST /api/projects` (dashboard registration) may register under; unset or outside every root: `403`. Does not restrict `digest init` |
| `DIGESTIT_PROVIDER` | `watch`, `explain`, `serve` (v2 Explain/L3/context) | `stub` \| `claude-code` |
| `DIGESTIT_ALLOWLIST` | `watch`, `explain` | Repos the LLM provider is allowed to see (v2 routes always scope this to the one project being explained) |
| `DIGESTIT_DAILY_BUDGET` | `watch`, `explain`, `serve` | LLM calls/day cap, shared across the CLI and the v2 write routes |
| `DIGESTIT_CLAUDE_BIN` / `DIGESTIT_CLAUDE_MODEL` | `watch`, `explain`, `serve` | `claude-code` provider config |

Never commit a token file or paste a token/login URL into an issue, commit
message, or chat. The `DIGESTIT_TOKEN_FILE`/`DIGESTIT_ALLOWED_HOSTS` token
grants full read access to the dashboard for as long as the file exists; the
plain-loopback write token (above) grants only the ability to spend the LLM
budget on a registered project, but is still a credential to protect the
same way.
