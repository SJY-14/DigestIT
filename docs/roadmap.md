# Roadmap

## Milestone 4: project memory (current)

DIG-97 (Board, 2026-09-30): DigestIT keeps sourced facts about each project (areas, terms, threads of
work across digests, user notes), updates them in the background and gives each prompt a small,
relevant slice. Deterministic extraction first; background LLM summaries are opt-in per project and
have their own small daily share. Design: [milestone-4-memory.md](milestone-4-memory.md), contract
`packages/core/src/memory.ts`. D1–D3 (summaries default, budget share, what is stored) are with the
Board; the build starts on the recommended options.

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-97 | Design, contract, Board decisions D1–D3, review, acceptance | CTO | DIG-100–103 |
| 1 | DIG-100 | Store, migration, rollback, export/clear, deterministic extraction, threads, `digest memory` CLI | Diff engineer | — |
| 2 | DIG-101 | `selectMemory`, `<memory>` prompt block, date check, `memory` summary task | Summarization engineer | — |
| 3 | DIG-103 | `MemoryWorker` triggers, budget share, retrieval wired into Explain, memory API | Diff engineer | DIG-100, DIG-101 |
| 4 | DIG-102 | "What DigestIT knows" design: brief, critique, decision | UX Designer, UX Reviewer | — |
| 5 | later | The page and the per-digest "what DigestIT used" | Frontend engineer | DIG-102, DIG-103 |
| 6 | later | A/B kit and blind read (with and without memory, en/ko) | Summarization engineer, operator, UX Reviewer | DIG-103 |

## Fast Explain

Board feedback DIG-73 (2026-09-29): Explain shows nothing useful for ~50 s (~100 s on a project's first Explain).
Targets: deterministic view < 1 s, L0 ≤ 10–15 s, full L2 ≤ 30 s, L3 ≤ 15 s streamed step by step. One Explain stays
one budget unit. Design and contract: [explain-speed.md](explain-speed.md).

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-73 | Design, `core/v2.ts` contract, migration 10, review, acceptance | CTO | DIG-74–77 |
| 1 | DIG-74 | Per-call timing, cheaper CLI runs, model/effort per task, split digest prompts, streamed L3, job budget, A/B kit | Summarization engineer | — |
| 2 | DIG-75 | Deterministic areas, async Explain job runner, per-part status, digest events SSE, async L3 | Diff engineer | DIG-74 (signatures in the doc) |
| 3 | DIG-76 | Instant digest skeleton, per-part fill-in and retry, SSE client, streamed L3 steps | Frontend engineer | — (fixtures until DIG-75) |
| 4 | DIG-77 | Real-provider timing and quality acceptance (en and ko) | Board operator | DIG-74, DIG-75, DIG-76 |
| 5 | DIG-84 | Bug: Explain button stays "Explaining…" after a server-run Explain (live stream misses in-process writes). Merged 2026-09-30 | Diff engineer | — |

## L3 step snippets and line callouts

DIG-96 (Board, 2026-09-30, critical): "Explain code" still repeats the whole diff under every step, because steps point
at whole hunks and a new file is one hunk. Steps now carry exact line ranges and line-anchored callouts; each step shows
only its own lines, the full diff is shown once. Spec and contract (types, `rangeSpan` in core) merged to `main`:
[l3-step-snippets.md](l3-step-snippets.md). Supersedes the hunk anchors of DIG-71 below.

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-96 | Contract, review, acceptance kit | CTO | DIG-98, DIG-99 |
| 1 | DIG-98 | Schema, prompt `a6`, validator, stub, streaming | Diff engineer | — (rebase on DIG-94) |
| 2 | DIG-99 | Step snippets, callouts, full diff once, mechanical step collapsed | Frontend engineer | — |
| 3 | — | Real-provider run en/ko, light/dark, 60+ line multi-hunk change; UX Reviewer sentence-to-line check | Board operator, UX reviewer | DIG-98, DIG-99 |

## L3 step ↔ code mapping

DIG-71 (Board, 2026-09-29): it isn't obvious which lines each walkthrough step covers. Brief rev 2
([ux/dig71-step-code-mapping.md](ux/dig71-step-code-mapping.md)) was approved by the UX Reviewer. The CTO decision: build
P1–P3 (a range label and step badge on each hunk block, and an announcement plus focus move on every step change), all
client-only. Not built: the two-pane diff (it conflicts with the one-long-scroll rule in ux-v3 §1). No schema or
validator change: anchors are derived from `HunkRef` and the patch.

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-71 | Brief, decision, review, acceptance | CTO | DIG-81 |
| 1 | DIG-81 | `hunkRange()`, range labels, step badges, announce + focus (P1–P3). Merged 2026-09-30 | Frontend engineer | — |
| 2 | DIG-85 | Real-provider before/after screenshots (en/ko, light/dark), one-command kit | Board operator | DIG-81 |
| 3 | DIG-86 | The Reviewer's 2-second check on those screenshots | UX reviewer | DIG-85 |

## Visual refinement: Direction B (editorial)

DIG-72 (Board, 2026-09-30): of the three directions in [ux/brief-2-visual-refinement.md](ux/brief-2-visual-refinement.md),
the Board picked **B (editorial / documentation)**. It's built as a design-token pass over the whole app, with no
IA or copy change. Fonts are self-hosted (Source Serif 4 for reading text, Source Sans 3 for UI chrome, and Noto Serif
KR subsets as the Korean serif fallback behind the installed `Noto Serif CJK KR`), so rendering doesn't depend on
which fonts the host has. CSP is unchanged (`default-src 'self'` covers fonts).

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-72 | Directions, Board pick, review, macOS font check with the owner | CTO | DIG-83 (owner macOS check) |
| 1 | DIG-82 | Direction B token pass: fonts, type/spacing/color tokens, de-boxing, graph dots, en/ko, light/dark. Merged 2026-09-30 | Frontend engineer | — |
| 2 | DIG-83 | Verify: before/after of every view (en/ko, light/dark), contrast table, font-resolution evidence. No findings above Minor; macOS check doc merged 2026-09-30, owner run pending | UX reviewer | DIG-82 |

## UX improvement cycle 2 (done)

DIG-80 (Board, 2026-09-30): the whole journey, restyled in direction B. Inputs: `docs/ux/audit-2.md`, `brief-2.md`,
`dig80-critique.md`. The CTO decision is in [ux/decision-2.md](ux/decision-2.md). One mental model: all projects →
project → digest → level. Units, Timeline and Briefing leave the web app. Insights stays behind a gated "legacy" link in
Settings. First run and Settings state exactly what is sent, to which provider, and when, and that DigestIT only reads
the project. Projects can be removed (soft delete). A new "All projects" view sorts projects unread first.

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-80 | Audit, brief, critique, decision, acceptance. Done 2026-09-30 | CTO | DIG-93 |
| 1 | DIG-87 | `GET /api/about`, `ProjectDto.latestDigest`, soft remove (API + `digest remove`). Merged 2026-09-30 | Diff engineer | — |
| 2 | DIG-88 | IA cleanup, first-run trust + layout, Settings & trust panel (P1, P2, P3, P5). Merged 2026-09-30 | Frontend engineer | — |
| 3 | DIG-89 | Project panel with unread + Remove, All projects view (P4, P7). Merged 2026-09-30 | Frontend engineer | — |
| 4 | DIG-90 | Verify against decision-2, `docs/ux/cycle-2-summary.md`. Passed, merged 2026-09-30 | UX reviewer | DIG-88, DIG-89, DIG-92 |
| 5 | DIG-92 | Fix: the web client's Remove got 415 (DELETE sent no `content-type`). Found by DIG-90. Merged 2026-09-30 | CTO | — |
| 6 | DIG-93 | Real-provider acceptance run (`.cache/dig80-acceptance/accept.sh`, all views passed, 2026-09-30) | Board operator | DIG-90 |
| 7 | DIG-95 | Follow-up from DIG-93: inline code in All-projects row headlines. The L3 "writing" notice was correct (the kit captured mid-stream; kit wait fixed), now pinned by a test. Merged 2026-09-30 | Frontend engineer | — |

## Removing the AI-made look (done)

DIG-63 (Board, 2026-09-29): the UI and the generated explanations should read as human-crafted. The audit and its
critique (`docs/ux/ai-look-audit.md`, `critique-2.md`) found the UI and the current real output clean. What's missing is
a guard that keeps them that way.

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-65 | AI-tell lint in the validators (en/ko), one retry, `style_warnings`; prompt style rules (done) | Summarization engineer | — |
| 0 | DIG-66 | UI-copy lint test over evaluated `copy.ts`; string sweep (done) | Frontend engineer | — |
| 1 | DIG-67 | Verify: before/after screens, lint counts, blind read; `docs/ux/ai-look-summary.md` (done) | UX reviewer | DIG-65, DIG-66 |
| 2 | DIG-69 | Operator real-provider acceptance run (en and ko): 0 AI-tell hits (done) | Board operator | DIG-65 |
| 3 | DIG-70 | Follow-up: render inline code in explanation prose (done) | Frontend engineer | — |

## UX improvement cycle 1 (done)

DIG-55 (Board, 2026-09-28): a UX Reviewer audit, a Designer brief and a critique round, followed by a CTO decision
(`docs/ux/audit-1.md`, `brief-1.md`, `critique-1.md`, `decision-1.md`). The decision: build P1–P4, P6 and P5 option A.
Server-side reviewed state (P5-B) and v2 instrumentation are deferred.

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-60 | Localized nav, History menu descriptions, focus visibility (P1, P3, P4) | Frontend engineer | — |
| 1 | DIG-61 | L0 areas map, welcome-back strip, per-area reviewed mark (P2, P6, P5-A) | Frontend engineer | DIG-60 |
| 2 | DIG-62 | Verify with before/after screenshots; `docs/ux/cycle-1-summary.md` | UX reviewer | DIG-60, DIG-61 |

## Project switching and first-run state (done)

Board bug DIG-57 (2026-09-28): switching projects kept the previous project's digest and graph, a
project with no digests had no graph, and the pending count included files skipped at checkpoint.

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-57 | Project switch resets digest/level/URL; project-specific first-run copy (merged) | Frontend engineer | — |
| 1 | DIG-58 | `GET /api/projects/:id/graph` from the latest checkpoint; pending excludes skipped files (merged) | Diff engineer | — |
| 2 | DIG-59 | Gray first-run graph in the graph pane; project graph accepts `expand` (merged) | Frontend engineer | DIG-58 |

## Non-git projects with generated outputs (done)

DIG-56 (2026-09-28): per-project ignore patterns (gitignore syntax) stored in DigestIT's data dir,
never in the project. They are set with `digest init --ignore`, `digest ignore <project> add|remove|list`
or the dashboard info popover. `init` of a folder with no `.gitignore` suggests patterns for output
areas but does not apply them. "Not tracked" shows why each path was skipped: denylist, `.gitignore`
or a project pattern. Merged; the Diff engineer owns it.

## UX v3 — reading experience redesign (done)

Board feedback DIG-47 (2026-09-28) after first real use: explicit L0–L3 level switcher, L3 as a
step-by-step walkthrough of the diff, natural wording with Korean as a first-class explanation
language, and a simpler header/picker/progress flow. Contract: [ux-v3.md](ux-v3.md).

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-47 | Contract (`core/v2.ts` UX v3 types, `web/copy.ts`), acceptance on real `claude-code` output | CTO | DIG-48, DIG-49, DIG-50 |
| 1 | DIG-48 | L3 walkthrough prompt + schema + validator; natural prompts; `en`/`ko` | Summarization engineer | — |
| 2 | DIG-49 | Language setting + wiring, compact header, digest picker, Explain progress, empty states | Diff engineer | DIG-48 (wiring step only) |
| 3 | DIG-50 | Reading flow: level switcher, L0–L3 views, breadcrumb, walkthrough UI, graph fit | Frontend engineer | — (fixtures until DIG-48) |
| 4 | DIG-52 | Polish: Korean UI chrome, graph fills small panes, full L0 in picker, dark-theme strip | Frontend engineer | — |
| 5 | DIG-53 | Shorter walkthrough steps (2–4 sentences, en/ko) | Summarization engineer | — |

Accepted on 2026-09-28 on real `claude-code` output (demo project, English and Korean, light and
dark). The acceptance flow runs as a scripted headless-browser pass. DIG-52 and DIG-53 are follow-ups
from that review. Both are merged: DIG-53 (step bodies: 2–4 sentences, at most 70 words, cut after
the retry) and DIG-52 (Korean UI chrome, small graphs fill the pane, full L0 in the picker list,
themed scrollbars). One real-provider re-run of the acceptance flow on main checks both.

## Direction v2 — standalone project digester (done)

Board direction DIG-33 (2026-09-26): select a project folder → build its context → the user works
with any AI tool → **Explain** describes what changed since the last check (a *digest*) at L0/L1,
with clickable L2 areas and on-demand L3 (why + folded diffs). It supersedes the open M3 work.
Design: [direction-v2.md](direction-v2.md). Open decisions O1–O3 are with the Board. The build
starts on the recommended options.

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 0 | DIG-33 | Design doc, migration 6, `core/v2.ts` types + API DTOs, `core/graph.ts` graph builder | CTO | — |
| 1 | DIG-34 | Shadow store (snapshots in the data dir, no writes to the project) | Diff engineer | — |
| 2 | DIG-35 | Digest L0/L1/L2 areas (how + why) in one call | Summarization engineer | — |
| 3 | DIG-36 | Project context builder (map + 1 call + optional user `.md`) | Summarization engineer | — |
| 4 | DIG-37 | Lazy L3 per area (why/design/risks + anchored notes) | Summarization engineer | DIG-35 |
| 5 | DIG-38 | Project registry, data dir, `digest init/projects/status/explain` | Diff engineer | DIG-34, DIG-35 |
| 6 | DIG-39 | API v2 + token-only writes + wiring | Diff engineer | DIG-38, DIG-36, DIG-37 |
| 7 | DIG-40 | Main screen v2: project bar, budget, Explain, two panes (change list ↔ project graph), L0→L2 | Frontend engineer | — (fixture API until DIG-39) |
| 8 | DIG-41 | L3 area view with folded diffs and "Show all" | Frontend engineer | — |
| 9 | DIG-42 | Project graph pane (changed nodes in blue, pan/zoom, fit to changes) | Frontend engineer | — (fixture from `core/graph.ts`) |

Done when the owner runs `digest init` on a folder, edits it with any tool, presses Explain in
the dashboard, gets a digest with L0/L1/L2 next to a project graph with the changed nodes in
blue, and clicks an area or a lit node to get its L3. The daily budget is
shown and enforced, and nothing is written into the project.

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

## Milestone 3 — thinking aids (paused by direction v2)

Re-planned under DIG-33: DIG-25/26/27 are done and stay in the code. DIG-28 and DIG-30 are deferred
(their branches are kept). DIG-29 and DIG-31 are cancelled.

Daily/weekly briefing, digest dashboard, change map and review blind spots, all built from stored
data with drill-down to L0–L3. Design and acceptance scope: [milestone-3.md](milestone-3.md).
Approved by the Board on 2026-09-26 (DIG-22).

| # | Key | Issue | Owner | Depends on |
|---|---|---|---|---|
| 1 | DIG-25 | Insights query layer + read API + 90-day fixture | Diff engineer | — |
| 2 | DIG-28 | Briefing builder, M3 migrations, schedule, `digest brief`, `/api/briefings` | Diff engineer | DIG-25, DIG-26 |
| 3 | DIG-26 | Briefing narrative (`explainBriefing`) | Summarization engineer | — |
| 4 | DIG-27 | Chart primitives + drill list + `/insights` shell | Frontend engineer | — |
| 5 | DIG-31 | Briefing page | Frontend engineer | DIG-28, DIG-26, DIG-27 |
| 6 | DIG-29 | Digest dashboard v2 | Frontend engineer | DIG-25, DIG-27 |
| 7 | DIG-30 | Change map + blind spots | Frontend engineer | DIG-25, DIG-27 |

## Later

- Other repos (each needs a Board decision on data leaving the server).
- Anthropic API provider for throughput; access control if more than one user.
- Co-change map and work-flow view (M3b; work-flow needs DIG-20).
