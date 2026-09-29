# Fast Explain (DIG-73)

Board feedback (2026-09-29): after pressing Explain, nothing useful shows for about 50 s, and about
100 s on a project's first Explain. This doc sets the design, the contract and the work split.
The contract is `packages/core/src/v2.ts` ("Fast Explain") and migration 10 in `packages/core/src/db.ts`.

## Baseline and targets

Operator measurements (`explain_call`, real `claude-code` provider, Sonnet):

| Call | Now | Target |
|---|---|---|
| First render after the click | ~50 s (spinner) | **< 1 s**: files, +/− stats, graph lit, areas with file names |
| L0 (+ L1) | ~50 s | **≤ 10–15 s** |
| Full L2 | ~50 s | **≤ 30 s** |
| First Explain of a project | ~100 s (context 54 s, then digest 48 s) | Same as any Explain: context runs in parallel |
| L3 of one area | 12–37 s, all at once | **≤ 15 s** typical, steps appear as they stream |

Where the time goes is not measured yet. We know that one digest call writes L0, L1 and every L2
area in a single JSON answer, that a style retry doubles it, that each `claude -p` run loads the full
Claude Code system prompt, and that the run's working directory is wherever the server started (so
the CLI may also pick up a `CLAUDE.md`). Step 1 measures before anything is tuned.

## Design

### 1. Measure every call (DIG-74)

`ClaudeCodeProvider` switches to `--output-format stream-json --verbose --include-partial-messages`
and records, per call:

- `startup_ms`: spawn → the CLI's `system`/`init` event (process and CLI start-up)
- `ttft_ms`: init → first text delta (request, queueing, thinking)
- `gen_ms`: first text delta → `result` event (writing the answer)
- `input_tokens`, `output_tokens` from the `result` event's usage, plus `model` and `effort`

These go into the new `explain_call` columns, together with `job_id` and `part` (`summary`,
`area:<id>`, `walkthrough:<id>`, `context`). A read-only report (`digest explain --timing`, or a
script in `scripts/`) prints percentiles per part from the DB. Nothing here needs the network beyond
the existing CLI.

### 2. Cheaper CLI runs (DIG-74)

Each option is kept only if the measurement shows it helps and the call still authenticates with
the owner's normal login. `--bare` is out: it drops OAuth.

- `--system-prompt <instructions>`: our instructions replace Claude Code's default system prompt,
  which is large and useless for a tools-off JSON task. The quoted diff stays in the user message.
  This also separates instructions from untrusted data more cleanly.
- `--no-session-persistence`, `--strict-mcp-config` (no MCP servers), `--disable-slash-commands`.
- Spawn with `cwd` set to an empty directory under the data home, so no `CLAUDE.md` or project
  settings are discovered.

### 3. Model and effort per task (DIG-74)

Four tasks, each with its own `{model, effort}` in the provider config and env overrides
(`DIGESTIT_MODEL_<TASK>`, `DIGESTIT_EFFORT_<TASK>`): `context`, `summary` (L0/L1), `area` (L2 text of
one area), `walkthrough` (L3). The CLI's `--model` takes aliases (`sonnet`, `haiku`), so defaults
don't pin a dated model id.

Starting defaults, to be confirmed by the operator's A/B run: `summary` and `context` on Sonnet with
low effort; `area` on Sonnet with low effort; `walkthrough` on Sonnet with medium effort. Haiku is
in the A/B matrix for `summary` and `context`. A task moves to a faster model or lower effort only if
its samples keep 0 AI-tell hits, pass the validators on the first try, and pass a blind read against
the current output. Faithfulness beats speed.

### 4. Split the digest (DIG-74 prompts, DIG-75 orchestration)

**Deterministic areas.** `groupDigestAreas(files, opts)` (pure, in `@digestit/core`) partitions the
changed files into 1–8 `DigestAreaSkeleton`s without an LLM:

- A test file joins its subject's area when the subject is in the digest (`x.test.ts` → `x.ts`,
  `test_x.py` → `x.py`, `__tests__/x.ts` → `x.ts`).
- Files are grouped by workspace package (the caller passes the prefixes that `apps/server/src/areas.ts` already derives)
  or by directory. Groups are then merged into their parent directory, smallest first, until there
  are at most 8. Top-level files form one "project root" area. Filtered (not analysed) files belong to
  the area of their directory like any other file.
- `id` is the kebab-cased label, de-duplicated; `label` is the folder or package path.
- The result is stored in `digest.areas` when the digest row is created, so the grouping of an
  existing digest never changes when these rules do.

This changes L2 from grouping by meaning to grouping by place. The LLM still writes each area's
title, effect, how and why, and L0/L1 still tell the story across areas. The blind read in the
acceptance run checks that L2 stays useful.

**Parts.** One Explain runs these calls, all started at once, at most 4 in flight (configurable):

| Part | Input | Output | Stored as |
|---|---|---|---|
| `summary` | whole diff under a smaller budget, the area list, context | `l0`, `l1` | `explanation` levels 0 and 1 |
| `area:<id>` (one per area) | that area's files only, the area list, context | `title`, `effect`, `how`, `why` | merged into `explanation` level 2 (`DigestL2Content.items`, same order as `digest.areas`) |
| `context` (first Explain only) | project map, user `.md` | project context | `project_context`, as today |

The `summary` call is sent first so it is never queued behind area calls. `area` calls do not
wait for `summary`. Each part has its own validator (the `checkDigestLevels` rules split by level)
and its own single retry. Coverage is guaranteed by construction, so the "file not covered" rule
goes away.

**Context off the critical path.** When a project has no context yet, its first Explain starts the
context build in parallel with the digest parts. Those parts are grounded on a compact text rendering
of the deterministic `ProjectMap` (purpose from README/manifests, top-level modules) instead of the
LLM context. The digest is not re-run when the context lands. Every later Explain and every L3 uses
the LLM context.

**Prompt size.** The context sent with each call is capped (a first cap of 1,200 tokens; the
measurement decides the final value). The `summary` diff budget is lower than today's digest budget,
since it only needs enough to name the change. Each `area` call carries only its own files.

### 5. Asynchronous Explain and live progress (DIG-75)

- `POST /api/projects/:id/explain` takes the project lock, snapshots, writes the checkpoint, the digest
  row and `digest.areas`, creates an `explain_job`, starts the parts in the background and returns
  `ExplainResultDto` with `status: 'pending'`. It does not wait for the LLM. The lock is held until
  the job settles, so a second Explain still gets `409 explain_running`.
- `GET /api/digests/:id` returns `areas` and `parts` (see `DigestDetailDto`). A part's text shows up
  in `l0`/`l1`/`l2` as soon as it is stored.
- `GET /api/digests/:id/events` (SSE) sends `parts` on connect and on every part status change,
  `area-progress` while an L3 walkthrough streams, and `done` when nothing is running. The client
  refetches the digest on `parts`. Events are not replayed. A reconnect gets the current `parts`
  and refetches.
- `POST /api/digests/:id/areas/:areaId/explain` returns right away too. The walkthrough streams as
  `area-progress` events: DIG-74's provider parses the partial JSON and hands over each complete step
  (`onProgress`). The final validated walkthrough (after coverage repair, or a style retry) replaces
  the streamed one.
- `POST /api/digests/:id/explain` (retry) re-runs only the parts whose status is `error`,
  `truncated` or `budget`.
- A server restart mid-job leaves stored parts as they are. Any part that is not stored and has no
  live job reads as `error`, so the UI offers a retry. Nothing is left `running` forever.
- Pre-computing: `explain_job.prep_ms` records how long the snapshot, diff and row writes took. If it
  is above 700 ms on a real project, the snapshot and diff move ahead of the click (they are already
  partly done for the pending count). If not, nothing is added.

### 6. UI (DIG-76)

- Right after the click (from the POST response plus one `GET /api/digests/:id`): the digest opens with
  the changed files, +/− stats, the graph lit blue, and the area list with labels and file names. There
  is no page-level spinner.
- The L0/L1 lines and each area's text show a short placeholder in place until their part lands, and
  they fill in independently. A failed part shows its own retry, and the rest stays readable.
- L3 steps appear one by one as `area-progress` events arrive. The final walkthrough replaces them
  without the reader losing their scroll position.
- The first Explain of a project says the project context is being built alongside.
- The budget line says "Explains left today" instead of "calls" (en and ko).

## Budget decision

**One user action = one budget unit.** The daily limit (default 40) now counts `explain_job` rows
that made at least one provider call. It no longer counts calls. A job is one Explain (all its parts,
their retries and a first-Explain context build), one area L3, one context refresh or one digest
retry. The limit is checked once when the job starts. A job that started is never cut off halfway by
the budget. Older rows without a `job_id` (commit-history mode) still count one each.

What this costs: one Explain now makes 2–10 calls instead of 1–2. Each call repeats the instructions
and the capped context, so input tokens per Explain go up. Output tokens stay about the same. DIG-74's
report gives the measured tokens per Explain before and after, and `docs/operations.md` states them.
If the subscription's rate limits push back (429s, slow queueing), the in-flight cap is the knob to
turn, not the budget unit.

## Work split

| Key | Owner | Scope | Depends on |
|---|---|---|---|
| DIG-73 | CTO | This doc, `core/v2.ts` contract, migration 10, review, acceptance | — |
| DIG-74 | Summarization engineer | Provider timing + stream-json + CLI flags + per-task model/effort + `onProgress`; `summary`/`area` prompts and validators; job-based budget helpers; timing report; operator A/B kit | — |
| DIG-75 | Diff engineer | `groupDigestAreas`, async Explain job runner, parts status, SSE endpoint, async area L3, retry of failed parts, restart recovery, `prep_ms` | DIG-74 (rebases on it; starts against the signatures below) |
| DIG-76 | Frontend engineer | Instant digest view, per-part placeholders and retries, SSE client, streamed L3 steps, budget copy | — (fixtures until DIG-75) |
| DIG-77 | Board operator | Real-provider acceptance (en and ko): first render, L0, L2, L3 times; AI-tell lint 0; walkthrough coverage intact | DIG-74, DIG-75, DIG-76 |

### Signatures between DIG-74 and DIG-75 (in `@digestit/explain`)

```ts
interface JobRef { jobId: number; budget: number; now?: () => Date }
// Starts a job if the daily budget allows one more; returns null when it does not.
function startJob(db, kind, refs: { repoId?, changeUnitId?, areaId? }, budget, now): number | null;
function finishJob(db, jobId, now): void;

// Each stores its own result, logs its calls with job_id/part, and never checks the budget itself.
function explainDigestSummary(db, changeUnitId, provider, opts: { job: JobRef; context?: string; language }): Promise<PartOutcome>;
function explainDigestAreaText(db, changeUnitId, areaId, provider, opts: { job: JobRef; context?: string; language }): Promise<PartOutcome>;
function explainArea(db, changeUnitId, areaId, provider, opts: { job: JobRef; context?; language; onProgress?: (e: AreaProgressEvent) => void }): Promise<...>;
function ensureContext(..., { job: JobRef }): Promise<...>;   // existing, gains the job
type PartOutcome = { outcome: 'ok' | 'truncated' | 'error' | 'cached'; calls: number; detail?: string };
```

`explainDigest` (the one-call path) stays for the CLI until DIG-75 moves `digest explain` onto the job
runner, then it is removed.
