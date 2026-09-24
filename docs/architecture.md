# DigestIT MVP architecture

**MVP goal:** ingest this repo's own git history → generate L0–L3 explanations
per commit → show a timeline where clicking a commit lets the user pick the
level. Level definitions: [abstraction-levels.md](abstraction-levels.md).
Work breakdown: [roadmap.md](roadmap.md).

## 1. Decisions needing Board sign-off

| # | Decision | Recommendation | Alternatives |
|---|---|---|---|
| D1 | Stack | TypeScript end-to-end, pnpm workspaces, SQLite via Node 24 built-in `node:sqlite`, Fastify API, React + Vite UI | Python backend (splits the codebase); Postgres (needs a service to run) |
| D2 | Where explanations are generated (**code leaves the server**) | **B: Claude Code headless (`claude -p`) on this server** for the MVP, limited to allowlisted repos (initially only DigestIT) | A: Anthropic API via SDK; C: local model; D: offline stub only |
| D3 | Exposure | Bind to `127.0.0.1` only, no auth in the MVP, access via SSH port-forward | Reverse proxy with SSO (after MVP, only if needed) |

### D2 options in detail

All providers sit behind one `ExplanationProvider` interface, so this decision
can be reversed later without changing the rest of the system.

| Option | Data leaves server? | New secret / egress? | Quality | Cost / ops |
|---|---|---|---|---|
| **A. Anthropic API** (`@anthropic-ai/sdk`, structured JSON output) | Yes → Anthropic | Yes: API key + `api.anthropic.com` egress | High | Pay per token; fastest, easy to batch |
| **B. Claude Code headless** (`claude -p --output-format json`, no tools enabled) | Yes → Anthropic (same path the agents already use for this repo) | No: reuses the existing Claude Code install and auth | High | Slower per call; uses the existing plan's quota |
| **C. Local model** (e.g. Ollama) | No | No (model download once) | Noticeably lower for L0/L1 | Needs GPU/CPU capacity; extra dependency |
| **D. Stub** (commit message + diffstat, deterministic) | No | No | Placeholder only | Free; used for tests and dev in every case |

**Why B:** for the MVP we only process DigestIT's own code, which the agents
already send to Anthropic through Claude Code. So B adds no new data flow, no
new secret, and no new egress rule. Move to A when throughput matters. Any
repo other than DigestIT needs a separate Board decision (enforced by a repo
allowlist in config).

## 2. Components

```
git repo ──► ingest ──► SQLite ◄── explain (worker) ──► ExplanationProvider (B / A / C / D)
                          ▲
                          └── api (Fastify, 127.0.0.1) ◄── web (React timeline)
```

pnpm workspace layout:

| Package | Role |
|---|---|
| `packages/core` | Shared types, SQLite schema + migrations, config loading |
| `packages/ingest` | Runs the local `git` CLI (`git log`, `git show --numstat --patch`), parses the output into commits, file changes and hunks; incremental (skips SHAs it already has) |
| `packages/explain` | Diff preparation (filter, budget, redact) → provider → validate against level limits → cache |
| `apps/server` | Read-only REST API + CLI entry points (`digest ingest`, `digest explain`) |
| `apps/web` | Timeline dashboard + explanation panel with level picker |

Dependencies are kept to well-known packages (typescript, vitest, fastify,
react, vite, plus `@anthropic-ai/sdk` only if D2 = A), pinned in
`pnpm-lock.yaml`, and install scripts are disabled except for allowlisted packages.

## 3. Data model

```
repo          (id, name, path, head_sha, ingested_at)
commit        (sha PK, repo_id, parents[], author_name, authored_at, committed_at,
               message, branch_refs[], is_merge, stats{files, additions, deletions})
change_unit   (id, repo_id, kind='commit', head_sha, base_sha, title)   -- MVP: 1:1 with commit;
                                                                        -- later: PR / agent session / range
file_change   (change_unit_id, path, old_path, status A|M|D|R|B, additions, deletions,
               patch TEXT, filtered_reason NULL|'lockfile'|'binary'|'generated'|'too_large')
explanation   (change_unit_id, level 0..3, content JSON, status ok|pending|error|truncated,
               provider, model, prompt_version, input_hash, created_at,
               UNIQUE(change_unit_id, level, prompt_version))
```

`explanation.content` by level:

- L0 `{ text }`
- L1 `{ userVisible: boolean, bullets: string[] }`
- L2 `{ items: [{ path, role, change }], notAnalysed: string[] }`
- L3 `{ annotations: [{ path, side: 'new'|'old', startLine, endLine, note }] }`. The diff itself comes from `file_change.patch`.

We use `change_unit` rather than tying explanations to commits directly. That
way we can later group many small AI commits into one unit without changing
the schema.

## 4. Explanation generation and caching

1. **Prepare**: drop lockfiles, binaries and generated files (recorded in
   `filtered_reason`); cap the input at a token budget (whole files first,
   the largest file is truncated last); redact secret-looking strings (key and
   token regexes) before anything leaves the process.
2. **Generate**: one provider call per change unit returns all four levels as
   a single JSON object. The model works bottom-up (L3 notes → L2 → L1 → L0), so
   the levels stay consistent and each commit costs one call, not four. Diff
   text is passed as quoted data, and the prompt says to ignore any
   instructions inside it. Tools are disabled.
3. **Validate**: JSON schema + length limits + L3 anchors must point to lines
   that exist in the diff. On failure, retry once, then store with status `truncated`/`error`.
4. **Cache**: commits are immutable, so an explanation is keyed by
   `(change_unit, level, prompt_version)` and `input_hash` detects prep
   changes. Re-running is a no-op; bumping `prompt_version` regenerates. The
   backfill command processes history oldest-first with a concurrency limit and
   a per-run budget cap. The UI shows `pending` for units not generated yet.

## 5. API (read-only, JSON)

- `GET /api/repos` — list of repos
- `GET /api/repos/:id/timeline?cursor=&limit=` — commits with parents, refs, stats and L0 (for timeline labels)
- `GET /api/changes/:id` — metadata + file list
- `GET /api/changes/:id/explanations/:level` — one level (L3 includes patches)

Ingestion and generation are CLI commands, not HTTP endpoints, so the web
surface cannot trigger outbound LLM calls.

## 6. Security posture

- The server listens on `127.0.0.1` only. Nothing is exposed to the host's
  network or the internet. Users reach it through an SSH tunnel.
- The only outbound path is the chosen LLM provider (D2), and it only
  processes repos on the allowlist. There is no telemetry, no CDN (UI assets are
  bundled) and no third-party fonts or scripts.
- Secrets (if D2 = A) come from an env file outside the repo and are never
  logged. Diffs are redacted before sending.
- LLM output is untrusted. It is rendered as text/limited markdown with no raw
  HTML (React escaping, strict CSP), and it never drives tools or writes.
- Ingestion reads local repos only (no network clone in the MVP) and runs git
  with fixed arguments (no shell interpolation of refs or paths).
