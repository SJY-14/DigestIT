# Roadmap

## Milestone 1 — MVP: explain DigestIT's own history

Done when the owner opens the dashboard over Tailscale (port 4780), sees this repo's commits on a
timeline and can open any commit at L0, L1, L2 or L3. Design: [architecture.md](architecture.md),
[abstraction-levels.md](abstraction-levels.md). Architecture approved by the Board on 2026-09-24 (DIG-1).

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 1 | DIG-2 | Monorepo scaffold, core types, SQLite schema | Diff engineer | — |
| 2 | DIG-3 | Git ingestion | Diff engineer | 1 |
| 3 | DIG-4 | Diff preparation (filter, budget, redact) | Diff engineer | 2 |
| 4 | DIG-5 | Explanation providers (interface, stub, Claude Code) | Summarization engineer | 1 |
| 5 | DIG-6 | L0–L3 prompt, validation, cache and backfill | Summarization engineer | 3, 4 |
| 6 | DIG-7 | Read-only API server | Frontend engineer | 2 |
| 7 | DIG-8 | Timeline dashboard | Frontend engineer | 6 |
| 8 | DIG-9 | Explanation panel with level picker + annotated diff | Frontend engineer | 5, 7 |

### Acceptance criteria

**1. Monorepo scaffold, core types, SQLite schema**
- pnpm workspace with `packages/core`, `packages/ingest`, `packages/explain`, `apps/server`, `apps/web`; strict TS; `pnpm -r build` and `pnpm -r test` (vitest) pass.
- `core` exports the data-model types and a migration that creates the tables in architecture.md §3 using `node:sqlite`; DB file lives under `.cache/`.
- Lockfile committed; no install scripts outside the allowlist.

**2. Git ingestion**
- `digest ingest <path>` stores every commit on all local branches with parents, refs, stats and per-file patches.
- Idempotent and incremental: a second run adds 0 rows; new commits only are added after a new commit.
- Handles root commit, merge commits (diff vs first parent), renames, binary files, empty commits.
- Tests run against fixture repos created in a temp dir; git is called with argument arrays (no shell).

**3. Diff preparation**
- Lockfiles, binaries, generated/vendored files and files over a size cap are marked with `filtered_reason` instead of being sent.
- Input is trimmed to a configurable token budget in a deterministic way, and the same input gives the same `input_hash`.
- Secret redaction covers common key/token patterns (tests include AWS-, GitHub-, Anthropic-style and PEM samples).

**4. Explanation providers**
- `ExplanationProvider` interface; `StubProvider` (deterministic, from message + diffstat) and `ClaudeCodeProvider` (`claude -p --output-format json`, tools disabled, timeout).
- The provider is selected by config; repos not on the allowlist are refused before any call.
- Unit tests use the stub; the Claude Code provider has a test with a mocked process.

**5. L0–L3 prompt, validation, cache, backfill**
- One call per change unit returns all four levels; the output passes the JSON schema and the length limits from abstraction-levels.md; L3 anchors point to lines that exist in the diff.
- Retry once on invalid output, then store with status `truncated`/`error`.
- `digest explain --all` backfills oldest-first with a concurrency limit and a budget cap; re-running makes 0 provider calls; bumping `prompt_version` regenerates.
- Worked example commit `3dd6389` produces output comparable to abstraction-levels.md (checked in as a golden sample from the stub path + one manual real run).

**6. Read-only API server**
- Endpoints from architecture.md §5 with cursor pagination; binds `127.0.0.1:4780` by default (port configurable; a test asserts the host is loopback).
- Serves the built `apps/web` bundle from the same port so a single Tailscale serve mapping covers UI + API.
- Returns 404 for unknown ids and 200 with `status: pending` for explanations not generated yet; no write endpoints.

**7. Timeline dashboard**
- React + Vite, no external CDN/fonts. Commit list newest-first, with branch lanes computed from parents, L0 as the label and date, author and stats.
- Loads 50 at a time, infinite scroll; works for this repo's full history.

**8. Explanation panel**
- Clicking a commit opens a panel with L0/L1/L2/L3 tabs (keyboard 0–3); the level choice persists while navigating.
- L3 renders the unified diff with annotations inline at their anchored lines; filtered files are listed as "not analysed".
- Generated text is rendered escaped (no raw HTML); a strict CSP header is set.

## Milestone 2 — real-time tracking of agent work

Watch mode, issue-level work units, quota-guarded explanation timing and digest-speed metrics.
Design and acceptance scope: [milestone-2.md](milestone-2.md). Approved by the Board on 2026-09-24 (DIG-12).

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 1 | DIG-13 | `digest watch` | Diff engineer | — |
| 2 | DIG-14 | Work units + range snapshots | Diff engineer | DIG-13 |
| 3 | DIG-15 | Explain scheduler + 40/day budget | Summarization engineer | DIG-14 |
| 4 | DIG-16 | Range prompt + last-hour roll-up | Summarization engineer | — |
| 5 | DIG-17 | Live API (SSE, work units, metrics) | Diff engineer | DIG-14 |
| 6 | DIG-18 | `POST /api/ui-events` + metric derivation | Diff engineer | DIG-17 |
| 7 | DIG-19 | Live dashboard + `/metrics` | Frontend engineer | DIG-17, DIG-18, DIG-9, DIG-11 |
| 8 | DIG-20 | *(gated)* Paperclip read-only enrichment | — | separate Board approval |

## Milestone 3 — thinking aids (proposed)

Daily/weekly briefing, digest dashboard, change map and review blind spots, all built from stored
data with drill-down to L0–L3. Proposal: [milestone-3.md](milestone-3.md), awaiting Board approval (DIG-22).
Build issues are created after approval.

## Later

- Other repos (each needs a Board decision on data leaving the server).
- Anthropic API provider for throughput; access control if more than one user.
- Co-change map and work-flow view (M3b; work-flow needs DIG-20).
