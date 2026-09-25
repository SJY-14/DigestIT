# Operations

How the operator runs DigestIT on the server and publishes it over the
tailnet. See [architecture.md §6](architecture.md#6-security-posture) for the
reasoning behind the allowlist + token.

## Running locally (loopback only, no token)

No extra env vars needed. The server only answers requests whose `Host`
header is `localhost`/`127.0.0.1`/`[::1]` (any port), and stays unauthenticated
— fine for a laptop or a dev box nobody else can reach.

```sh
pnpm digest serve                       # http://127.0.0.1:4780
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
only — the command re-chmods it even if the path already existed with looser
permissions) and prints a one-time login URL:

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
stream, `POST /api/ui-events` — accepts either that cookie or an
`Authorization: Bearer <token>` header; anything else gets `401` with no
data.

### Rotating the token

Re-run `digest token init` with the same `--file` (it overwrites the file,
still `0600`) and restart `digest serve` — it reads the token file once at
startup. The old token, and any browser session cookie set from it, stops
working immediately on restart. Send the new login URL to the operator the
same way as before.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `DIGESTIT_DB` | `serve`, `watch`, `explain` | SQLite file path (default: package default, see `openDb`) |
| `DIGESTIT_PORT` | `serve` | Port to bind (default `4780`); host is always `127.0.0.1` |
| `DIGESTIT_ALLOWED_HOSTS` | `serve` | Comma-separated `host[:port]` allowed besides loopback; unset = loopback only, no token required |
| `DIGESTIT_TOKEN_FILE` | `serve`, `token init` (as a default for `--file`) | Path to the `0600` access-token file; mandatory once `DIGESTIT_ALLOWED_HOSTS` is set |
| `DIGESTIT_PROVIDER` | `watch`, `explain` | `stub` \| `claude-code` |
| `DIGESTIT_ALLOWLIST` | `watch`, `explain` | Repos the LLM provider is allowed to see |
| `DIGESTIT_DAILY_BUDGET` | `watch`, `explain` | LLM calls/day cap |
| `DIGESTIT_CLAUDE_BIN` / `DIGESTIT_CLAUDE_MODEL` | `watch`, `explain` | `claude-code` provider config |

Never commit a token file or paste a token/login URL into an issue, commit
message, or chat — it grants full read access to the dashboard for as long
as the token file exists.
