# Milestone 4: project memory

Board direction DIG-97 (2026-09-30). DigestIT should explain a change the way a teammate who has
followed the project for weeks would. Today each Explain gets one project context (a map plus one
LLM call, `docs/direction-v2.md` §3), rebuilt only on structural change, and nothing carries over
from one digest to the next. This milestone adds a **project memory**: small, sourced facts about a
project, updated in the background, of which each prompt gets a relevant slice. The contract is
`packages/core/src/memory.ts`. The Board approved D1–D3 (§7) as recommended on 2026-10-01.

## 1. What is stored

Four kinds of item. Each is one row with a `source`, a `status`, provenance and a version.

| Kind | Holds | Source | Update |
|---|---|---|---|
| `area` (folder or package, ≤ 80) | file count, exported symbols (≤ 30, most-imported first), which areas it uses and is used by, the folder README's first paragraph or the main file's leading doc comment; optional summary | `code`; `summary` if D1 is on | deterministic, only for areas whose files changed |
| `term` (≤ 300) | identifier or project word, where it is defined, meaning (doc comment, user or summary), areas it appears in | `code`, `user`, `summary` | with its area |
| `thread` (≤ 20 open) | a line of work across digests: title, areas, terms, the digests with date and L0; optional summary | `digest`; `summary` if D1 is on | after each Explain, no call |
| `note` | a fact from the user: sections of the context `.md`, and corrections made on the page. A note with a target overrides that item's text in prompts | `user` | on edit, or when the `.md` changes |

Decisions visible in code or docs are not their own kind in v1: they show up as area docs, notes or
thread summaries. We add a kind only if the blind read (§6) shows the need.

**Deterministic extraction, no new dependency.** From the checkpoint in the shadow store (already
filtered by the denylist, `.gitignore`, project ignores and the size cap), with line-based parsers:
TS/JS `export` and `import`, Python top-level `def`/`class` and imports, Go exported names, Rust
`pub` items. Other languages get file names only. Relative and workspace imports resolve to areas.
Doc text is capped at 400 characters and passed through `redact()` **before storage**. A thread is
built from the digests' stored L0, L2 and area lists: a new digest joins an open thread when it
touches one of its areas and shares a term or at least half its areas. Area overlap only counts
when the digest or the thread has no terms yet; when both have terms and share none, they are
different work, even in the same folder (DIG-114). A thread closes after 14 days with
no new digest.

**Storage** (next migration, same SQLite DB in the data dir): `memory_item` (unique on repo, kind,
key, language), `memory_revision` (every version of every item, with its batch), `memory_batch`
(one update run: trigger, checkpoint, items changed, calls) and `memory_use` (which item versions
went into which prompt). **Rollback** replays a batch's revisions backwards and is itself a batch.
`status`: `active`, `stale` (its files changed since it was confirmed; never sent) or `hidden`
(the user deleted it; the extractor keeps it hidden until restored). Stale items are dropped after
30 days; user and hidden items are never dropped.

## 2. Update triggers

A `MemoryWorker` in the `digest serve` process, one queue, one task at a time:

1. **After an Explain job finishes:** re-extract only the areas whose files changed in that digest,
   then attach the digest to a thread. No LLM. It runs after the job's last part is stored.
2. **Idle** (no Explain job running and no API write for 2 minutes): drain the summary queue, only
   for projects with summaries on (D1) and within the share (§4). Areas are queued when their
   fingerprint changed or when they have no summary, ordered by how recently a digest touched them.
3. **Daily**, first idle moment after local midnight: a full deterministic sweep if the latest
   checkpoint moved; mark stale, drop stale items older than 30 days, close idle threads.
4. **Manual:** `digest memory update <project>` and a button on the page.

Explain never waits on memory. The worker yields between items when a job starts. A memory
LLM call already running finishes, and its result is dropped if its area changed in the meantime.
Without `digest serve`, only the CLI trigger runs.

## 3. Retrieval

`selectMemory(items, request, budget)` is pure and deterministic. It uses the touched area keys and
the identifiers found in the prepared diff (words matching known terms or exports). Order: user notes
on touched areas, pinned items, touched areas (with their `uses`/`usedBy` names only), terms found
in the diff, open threads on touched areas that share a term with the diff (a thread with no terms
yet goes on area overlap), then neighbouring areas. It stops at the budget (1,500
tokens for summary, 1,200 for an area, 800 for a walkthrough step) and records what it dropped. The
slice goes into a `<memory>` block next to the existing `<project>` context. The context's
`modules` list is left out when the slice has areas, so the total grounding grows by less than
1,000 tokens. A slice whose lines are all area relationships (no note, pinned item, diff term or
thread) is not sent: that structure is already in the project context, and an unrelated digest
should read like it would without memory. The reader never sees the slice, so the prompt asks for
citations a colleague would give (DIG-114): a thread is listed by its earlier changes' titles and
their age relative to this change ("5 days earlier"), with no date, and the prompt may say
"continues" only about a thread listed there, naming the earlier change; a user note is listed
with its date and cited as "the user's note of Tue 22 Sep". The validator flags any date or weekday
that is not in the slice or the diff, and any text that names the mechanism ("in memory", "memory
says", "프로젝트 메모리") unless the diff itself uses the phrase. The slice is part of each call's
input hash, and its item versions go to `memory_use`. Old digests are not re-explained when memory
changes.

## 4. Budget

Background memory LLM work runs as jobs of a new kind `memory` in `explain_job`, so it shows in the
same counts. One job is one call plus at most one retry and summarises up to 4 areas or 1 thread,
using a new provider task `memory` (Sonnet, low effort; Haiku goes into the A/B run). **(rec.) D2:**
a share of **4 jobs a day** across all projects (`DIGESTIT_MEMORY_DAILY_JOBS`, 0 turns it off),
counted inside the daily budget of 40, and a job starts only while **at least 10 units remain** for
user actions. Deterministic work costs no budget. Settings shows "Memory: 2 of 4 today".

## 5. Privacy defaults and UI

Same rules as Explain: registered projects only, read from the shadow store only (never the project
folder, never written), denylist and ignores apply, text is redacted before it is stored and again
before it is sent, and all writes need the token and pass the CSRF check. **(rec.) D1:** deterministic
memory is on for every project, since nothing leaves the host. Using the slice in Explain prompts is
on, because it goes to the same provider under the same Explain consent. **Background LLM summaries
are off per project** until the user turns them on. `digest memory export|clear <project>` and
the page export or delete a project's memory. A soft-removed project keeps its memory like its
other rows.

**"What DigestIT knows"** (per project, designed by the UX team in their usual loop): the four kinds,
each item with its source ("from the code", "from earlier digests", "summarised", "from you"), when it
was last checked, from which files or digests, and how often it was used. Actions: correct (this
creates a user note that overrides the item), pin, delete, restore. Page-level: the summaries switch,
today's usage, undo the last update (batch rollback), export, clear. Each digest links to "what
DigestIT used" for it.

## 6. Measuring the gain

The same digests are explained with memory off and on (same model, same prompts otherwise):

- **Blind read** by the UX Reviewer and the Board: 10 digests from a multi-day `snapback` story
  (retry work over three digests, a rename, a user correction) plus 5 digests of this repo's own
  history, en and ko. Readers pick the better one on continuity, the project's own names,
  specificity and correctness. **Pass:** memory wins at least 7 of 10 per language, with no
  continuity claim that the slice does not support. A tie is not a win (DIG-117).
- **Automatic:** first-try validator pass rate not lower, 0 AI-tell hits, the share of diff
  identifiers that are known terms and are used verbatim, and L0 time no more than 15 % slower.
- **Kit** (`packages/ingest/test/memory-ab-kit.mjs`): each pair file ends with the project memory
  the memory-on version was sent (notes with dates, threads with their earlier changes and dates,
  term and area names), so the reader can check a continuity claim against it. Prompt tokens count
  the whole prompt, cached tokens included (`explain_call.prompt_tokens`), and validator findings
  are broken down by rule per arm.

## 7. Board decisions (approved as recommended, 2026-10-01)

- **D1, background LLM default:** deterministic memory on everywhere, background summaries off per
  project until the user opts in (rec.). The alternative is summaries on for new projects.
- **D2, budget share:** 4 memory jobs a day inside the 40, with a reserve of 10 for user actions (rec.).
  Or 0 until the blind read shows a gain from summaries.
- **D3, what is stored:** areas, terms, threads and user notes, with provenance, rollback and
  export (rec.). Not stored: raw file contents, diffs, and anything that is not already in the shadow
  store.

## 8. Build issues

| # | Issue | Owner | Depends on |
|---|---|---|---|
| 1 | DIG-100: store, migration, rollback, export/clear, deterministic extraction, threads, `digest memory` CLI | Diff engineer | contract |
| 2 | DIG-101: `selectMemory`, `<memory>` block in summary/area/walkthrough prompts, date check, `memory` task and summary validator (behind the per-project switch) | Summarization engineer | contract |
| 3 | DIG-103: `MemoryWorker` triggers, budget share, retrieval wired into Explain jobs, memory API, usage in Settings | Diff engineer | 1, 2 |
| 4 | DIG-102: "What DigestIT knows" design: brief, critique, decision | UX Designer, UX Reviewer | — |
| 5 | Later: the page and the per-digest "what DigestIT used" | Frontend engineer | 3, 4 |
| 6 | Later: A/B kit and blind read (§6) | Summarization engineer, operator, UX Reviewer | 3 |
