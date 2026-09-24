# Milestone 2 — real-time tracking of agent work (proposal)

**Status:** proposed for Board approval (DIG-12), 2026-09-25. Builds on
[architecture.md](architecture.md); the D1–D3 decisions there still hold.

**Goal:** a human keeps up with agent work *while it happens*. Within seconds
of an agent committing, the change is on the dashboard. Within minutes of a
piece of work being handed off or merged, it has L0–L3 explanations *as one
unit* (the issue/branch, not 12 commits). We measure whether humans digest
work as fast as agents produce it.

**Done when:** the owner opens the dashboard, sees "last hour: 3 issues moved",
opens one issue unit at L0, drills to L3, marks it reviewed. The metrics page
shows land → open → decide times and the unread backlog. All of this runs
with no manual `digest ingest` / `digest explain`.

## Decisions (options → recommendation)

| # | Topic | Options | Recommendation |
|---|---|---|---|
| M1 | **Change detection** | a) git hooks in the repo; b) `fs.watch` on `.git/refs`; c) poll `git for-each-ref` + worktree HEADs | **c**, every 5 s, compare a hash of the ref list and ingest only on change. Hooks (a) write into the agents' repo config, so we reject them. `fs.watch` (b) is unreliable on network filesystems. We can add it later to speed things up. |
| M2 | **Watcher process** | a) inside the API server; b) separate `digest watch` process | **b**. The web process still cannot trigger ingest or LLM calls (same rule as the MVP). The operator runs it next to `digest serve`. |
| M3 | **Live dashboard** | a) browser polls every N s; b) SSE `GET /api/stream` | **b**, with a polling fallback. The server polls SQLite `PRAGMA data_version` every 1 s and sends `changed{unitIds}`. The client then refetches. SSE is a GET on the same loopback port, so there's no new inbound surface and Tailscale serve works unchanged. |
| M4 | **Unit of review** | a) commit only; b) branch; c) Paperclip issue (`DIG-n`); d) time window | **c, with b as the fallback.** A *work unit* = all commits on branches named `DIG-n-*`, plus merge commits `Merge DIG-n-…`. Branches without a key become branch units. **d** is a *view*, not a unit: "last hour" lists the work units that moved, plus one roll-up L0/L1. |
| M5 | **Linking commits → issues** | a) git only (branch name, merge subject); b) + Paperclip read (issue title/status, run time windows); c) commit trailer `Refs: DIG-n` | **a now, b behind a gate** (issue 8), **c optional** for engineers. Git-only needs no credentials. Its known gap: agents share one checkout, so a commit can land on another issue's branch. Paperclip run windows (b) would fix that. |
| M6 | **When to explain** | a) every commit; b) on handoff (quiet period); c) on merge to `main`; d) on demand | **b + c by default, d via CLI.** A new commit gets an instant *stub* L0 (its subject line, no LLM call). A work unit gets one LLM call for its range diff `merge-base(main)..tip` when (i) its branch has been quiet for 15 min (debounce), or (ii) it merges into `main`. Re-explain only if the tip moved since, and at most 3 times per unit. Per-commit LLM explanation is off in watch mode. |
| M7 | **Quota guard** | a) none; b) per-day call budget; c) per-day + priority queue | **c.** Default **40 LLM calls/day** (configurable), concurrency 1. Queue order: merged > handoff > roll-up > backfill. Over budget, units stay `pending (budget)` and the UI says so. Every call is logged in `explain_call` (time, unit, duration, outcome). |
| M8 | **Digest-speed metrics** | a) derive from git only; b) + UI events; c) + Paperclip decisions | **b** (c comes with issue 8). This needs the first **write endpoint** (see Security). |
| M9 | **Uncommitted work** | a) ignore; b) show diffstat of dirty worktrees; c) explain it | **b**: "in progress: 4 files, +120/−30" on the unit, no LLM call. Explaining (c) wastes quota on churn. |

## Data model changes (SQLite, additive migrations)

```
work_unit     (id, repo_id, key 'DIG-12'|branch name, kind issue|branch, title,
               state active|handoff|merged, first_commit_at, last_commit_at,
               merged_at, latest_range_unit_id)
unit_commit   (work_unit_id, sha)                         -- membership
change_unit   kind += 'range' (base_sha..head_sha)        -- immutable snapshot, cached like commits
rollup        (id, window_start, window_end, work_unit_ids[], content JSON)
explain_call  (id, at, change_unit_id, reason merged|handoff|rollup|backfill|manual,
               duration_ms, outcome ok|error|budget)
unit_event    (id, work_unit_id, change_unit_id NULL, kind, at, detail JSON)
              -- kind: landed | explained | opened | level_viewed | reviewed | merged
```

Explanations stay keyed by an immutable `change_unit`. Each time a work unit
is explained, we create a new `range` snapshot. The old snapshots stay, so a
human can see "what changed since I last looked".

## Metrics (local only, no telemetry)

For each work unit: **time to land** (first commit → visible), **time to
explain**, **time to open** (landed → first `opened`), **time to decide**
(landed → `reviewed` button or merge into `main`), **levels viewed before
deciding** (and time spent at each level), and **re-opens**. Globally:
**unread backlog** (landed, not opened), **undecided backlog**, and **digest
rate vs production rate** (units decided/day vs units landed/day; the core
hypothesis holds when digest ≥ production). There's a `/metrics` page and
`GET /api/metrics`. Nothing leaves the server.

## Security

- Still `127.0.0.1:4780` + Tailscale serve (tailnet, owner's device only). No
  new ports, no Funnel, no new egress. The LLM path is unchanged (D2), and the
  repo allowlist still applies.
- **The first write endpoint:** `POST /api/ui-events`. It is append-only and
  accepts only the event kinds above, with a JSON schema, a 2 KB body cap and
  a rate limit. It requires the `Origin` header to match the served origin
  plus a custom `X-DigestIT` header (CSRF). It **cannot** trigger ingest, git
  or LLM calls. A test asserts that no other non-GET route exists.
- The watcher runs git with fixed argument arrays, reads repos only (never
  writes refs, hooks or config), and ignores paths outside the allowlisted
  repo and its worktrees.
- **Paperclip access (issue 8, gated):** Paperclip has no read-only key scope.
  Any key we use could also write. So issue 8 starts only if the Board
  creates an **expiring board key** for DigestIT and stores it in an
  operator-owned env file outside the repo (mode 0600). The client allows
  only `GET`, on an allowlist of paths, against `127.0.0.1:3100`. Tests
  enforce this. The key is never logged or put in the DB, and agents never
  receive it. Without the key, M2 works with git-only linking.

## Build issues (after approval)

| # | Issue | Owner | Depends on |
|---|---|---|---|
| 1 | `digest watch`: ref polling across branches and worktrees, incremental ingest, dirty-tree diffstat, `landed` events | Diff engineer | — |
| 2 | Work units: `work_unit` / `unit_commit` / `range` units, `DIG-n` linking from branch and merge subject, state machine active→handoff→merged | Diff engineer | 1 |
| 3 | Explain scheduler: quiet-period + merge triggers, priority queue, per-day budget, `explain_call` log, stub L0 on land | Summarization engineer | 2 |
| 4 | Range-unit prompt (L0–L3 over a multi-commit diff) + "last hour" roll-up from unit L0/L1 (text-only call) | Summarization engineer | 2 |
| 5 | Live API: SSE `/api/stream`, work-unit + window endpoints, `/api/metrics` | Diff engineer | 2 |
| 6 | `POST /api/ui-events` + `unit_event` store + metric derivation (merge = decided) | Diff engineer | 5 |
| 7 | Live dashboard: work-unit lane view, "last hour" digest, unread badges, live updates, "Mark reviewed", `/metrics` page | Frontend engineer (after DIG-9, DIG-11) | 5, 6 |
| 8 | *(gated)* Paperclip read-only enrichment: issue title/status, run windows for commit attribution, handoff = `in_review`, decisions from issue activity | Diff engineer | 2, Board key |

We can run 1→2 and the prompt work in 4 in parallel with DIG-9/DIG-11. The
Frontend engineer stays on the MVP until both are merged.

## Risks

- **Wrong attribution in the shared checkout:** commits can land on the wrong
  `DIG-n` branch, which can mislead a unit's explanation. Mitigations: show
  member commits, let the owner treat the unit as a branch unit, and fix it
  properly with issue 8.
- **Large range diffs:** a whole issue can exceed the input budget. The MVP's
  budget/truncation applies. L2 lists what was not analysed. Units above a
  size cap fall back to per-commit L0 + stub.
- **Quota:** a busy day can hit the 40-call cap and leave units pending. The
  budget is visible, and merges are explained first.
- **Metric validity:** there's one human, so the sample is small and "opened"
  isn't the same as "understood". We treat the numbers as trend signals, not
  proof.
- **New write surface:** kept append-only, same-origin and loopback-only.
  Reversible by deleting the route.
