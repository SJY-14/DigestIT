# UX brief — "What DigestIT knows" (DIG-102, milestone 4, step 1 of the loop)

Built on `docs/milestone-4-memory.md` (DIG-97, commit de8ebcf on `main`), `packages/core/src/memory.ts`
(the DTOs), and a direct read of the current app: `ProjectHeader.tsx` (the Settings popover,
`.info-popover`), `AllProjects.tsx`/`ProjectRow.tsx` (the two-step `.proj-remove` confirm),
`styles.css` (real Direction B tokens — not the old `proto/visual-b-editorial` approximations),
and the L0/L2 screenshots in `docs/ux/screens/dig90-*`. Prototype: `docs/ux/proto/memory/index.html`,
built from the real classes below, not a fresh visual language.

## 1. Who reads this, and when

Three moments, all downstream of the same worry: **"is what DigestIT just told me actually true,
and where did it get that from?"**

1. **The owner, right after Explain, on a digest whose L0 claims continuity** — "continues the
   retry work from Tuesday." Milestone 4's whole pitch is that this claim can now be made; it is
   also the first claim a suspicious reader will want to check. They need the *evidence for this
   one digest*, one click away, without leaving the digest.
2. **The owner doing periodic upkeep** — back from a stretch of AI-driven commits, before trusting
   the next digest, they want to skim "what does this tool think it knows about my project" the
   way they'd skim a teammate's notes: is anything stale, wrong, or worth pinning down. This is a
   project-level page, opened deliberately, not part of the digest reading flow.
3. **The owner deciding on cost/privacy** — whether to turn background summaries on, and, if
   something looks over-confident or wrong, correcting it so it stops repeating.

All three want **progressive disclosure**, same as L0→L3: a page-level glance (counts, is
anything wrong, today's usage), four scannable lists, and per-item depth on demand. None of them
want a dashboard; this reads as a plain document, like L2's table-of-contents (`.area-cards`), not
a grid of cards.

## 2. IA placement

No new top-level nav entry — `Home` and `All projects` stay the only two (decision-2.md). Two
entry points, both citing real anchor points already in the code:

- **A persistent link in the Settings popover** (`InfoPopover` in `ProjectHeader.tsx`), placed
  after the language field and before the ignore-patterns section (it's core, not demoted like
  `legacyInsightsLink` — always visible, not gated on a data check). New route `/memory`,
  participating in `App.tsx`'s router the same way `/projects` does (`pageFor`, `PATH_FOR`) so
  Back/Forward work and it's a real page, not a modal. State: `?project=<id>`.
- **A per-digest link, digest-scoped**, sitting where `.areas-glance` already sits today — directly
  below the L0 headline/stats block, same section rhythm (`styles.css:675`, "below L0's
  headline/stats/Next"). One line, L0 only (the milestone doc asks for one link per digest, not
  one per level): `Grounded in 6 memory items · What DigestIT used →`. Destination:
  `/memory?project=<id>&digest=<id>`, the same page as above, pre-filtered (§5). A digest with an
  empty slice (memory not built yet, or nothing matched) omits the line entirely rather than
  showing "0 memory items" — an empty digest-glance row is more alarming than informative.

Breadcrumb on the page itself matches the existing pattern (`.breadcrumb`, e.g. `Digest · Today,
09:13 › L0 Summary`): `snapback › What DigestIT knows`, with a `← Back to digest` link when arrived
from §2's per-digest entry point (using the referring digest id, not browser history, so it works
after a reload).

## 3. Page anatomy

```
snapback › What DigestIT knows                              ← Back to digest (when applicable)

What DigestIT knows about snapback
Areas 42 · Terms 118 · Ongoing work 3 · Your notes 5          [Export]  [Clear]
Last updated: daily sweep, today 03:02 (14 items) — Undo

Background summaries                                    [ ○ Off ]
  Off by default. When on, DigestIT writes short summaries of areas and lines of
  work using stub — the same provider Explain uses. ▸ What this sends
Today: 2 of 4 background summaries used, shared across all your projects.
  They pause once fewer than 10 of today's 40 Explain calls are left.

[ Active ]  Hidden (3)                                          ⌕ Filter items…

── Areas (42) ──────────────────────────────────────────────────────────────
  src/retry.ts                                    From the code · checked 2h ago
  Retry with exponential backoff                   used in 6 digests
  isRetryable, withRetry, RETRYABLE_CODES (+2)      Correct · Pin · Delete

  src/upload.ts                                    stale — files changed since checked
  Upload failures carry file and attempt count      Correct · Pin · Delete

── Terms (118) ─────────────────────────────────────────────────────────────
  RETRYABLE_CODES                                  From the code · src/retry.ts
  Error codes worth a retry: connection reset,      used in 4 digests
  timeout, DNS lookup, broken pipe                  Correct · Pin · Delete

── Ongoing work (3) ────────────────────────────────────────────────────────
  Retry work                                        From earlier digests
  src/retry.ts, src/upload.ts · 3 digests, Mon–Wed   open · used in 2 digests
                                                      Pin · Delete

── Your notes (5) ──────────────────────────────────────────────────────────
  "Retries are capped at 10 — raising this needs    From you · from your context file
   sign-off, it's a support-load tradeoff."          Edit · Pin · Delete

  Corrects: Area src/upload.ts                       From you · corrects an item ↑
  "This also retries a 429 with Retry-After,          Edit · Pin · Delete
   not just 5xx."
```

Each `kind` section is an `.area-cards`-style list (hairline-separated rows, no card chrome),
reusing that exact CSS: title in the serif at `--text-body`, one line of derived text under it
(the doc/meaning/thread-title), a meta row in `--text-meta`/`--muted` for source + last-checked +
provenance + used-count, and a right-aligned action row. A row expands (native `<details>`, like
`.file` in the walkthrough) to show full provenance: every file/digest it came from (not just the
first two), its version history count, and — for a `summary`-sourced item — which provider wrote
it and when.

**Cost:** M (new route, new list components reusing `.area-cards`/`.proj-row` patterns, no new
visual language). **Server dependency:** DIG-103's memory API (`MemoryItemDto`/`MemoryOverviewDto`
endpoints) — this page cannot build against fixtures-only data past the brief stage.

## 4. Source badges and status

| `source` (DTO) | Badge text (en) | Badge text (ko) |
|---|---|---|
| `code` | From the code | 코드에서 |
| `digest` | From earlier digests | 이전 다이제스트에서 |
| `summary` | Summarised | 요약됨 |
| `user` | From you | 직접 작성 |

`status`, shown as a second, plain-text line under the title — never color alone (matches
`.reviewed-indicator`'s existing "checkmark plus the word" precedent):

- `active`: nothing extra shown — the default, quiet state.
- `stale`: `stale — files changed since checked` in `--muted`, plus a small dashed outline on the
  row (echoing `.graph-node.deleted`'s dashed-not-solid treatment). Stale items **stay in the
  Active list** (they're not deleted, just currently unused) — a separate "Stale" tab would hide
  exactly the thing worth noticing. The doc's own text is exactly this: "stale... never sent."
- `hidden`: only reachable via the **Hidden** filter tab (§3's `[ Active ] Hidden (3)` control, a
  plain two-state toggle, not a dropdown — mirrors nothing in this codebase that needed a select
  for two states). Each hidden row shows `Deleted <relative time>` and a single **Restore** button,
  no confirm (restoring is low-risk and reversible by deleting again).

**Overridden items:** when `overriddenBy` is set, the source badge is replaced by
`Overridden by your note →` in `--muted` (same visual weight as `.legacy-insights-link`), linking
to the note row in Your notes. The original item's own text stays visible below it, struck through
in a *display-only* way (`text-decoration: line-through` on a `--muted` copy of the text) — the
old fact stays legible, never hidden, per the mission's "never hide the evidence" principle; it is
what the note is correcting.

## 5. Per-digest "what DigestIT used"

`?project=&digest=` opens the same page, page-level chrome unchanged, but the four `kind` lists
are replaced by one flat, deduplicated list titled **Used for this digest** — the item versions
that appear in any `memory_use` row tied to this digest's Explain job(s) (`MemorySlice.items`
across the summary/area/walkthrough prompts that ran). Each row carries a **Used for** tag line
naming which prompt(s) pulled it in, since one item can ground more than one prompt in the same
digest:

```
Used for this digest (6 items)                          ← Back to digest

src/retry.ts                                    From the code
Retry with exponential backoff                    Used for: L0 summary, src/retry.ts (L3)
                                                    Correct · Pin

Retry work (thread)                              From earlier digests
3 digests, Mon–Wed                                Used for: L0 summary
                                                    Pin
```

Same row component and actions as §3 (Correct/Pin work identically — fixing a wrong grounding fact
belongs exactly where you noticed it wrong). Delete/Restore are omitted here on purpose: deleting
an item that already shaped a past digest doesn't unwrite that digest, and offering it in a
"why did it say that" context invites confusion about what deleting actually does. Delete stays
available from the plain project-level page.

**Known gap, flagged for the Reviewer, not solved here:** `MemorySlice.droppedForBudget` is a
count, not a list — the store doesn't keep the identity of what got cut for budget. This view can
truthfully say *"3 more items were considered but left out for space"* but cannot name them. That
is a data-shape limit from `packages/core/src/memory.ts`, out of this issue's scope; noting it here
so it isn't rediscovered as a bug during Frontend build.

## 6. Privacy, usage, undo, export, clear

- **Background summaries switch** (`summariesEnabled`): off by default, per D1 (rec.). A plain
  toggle, same control style as the language `<select>` in Settings, labelled, with an expandable
  `▸ What this sends` line that mirrors the first-run trust box's copy pattern
  (`.fr-trust`/`legacy-insights-link` tone) rather than inventing new phrasing:
  *"DigestIT writes a short summary of a folder or a line of work using **{provider}** — the same
  one Explain uses. Nothing beyond what Explain already sends leaves this machine."* `{provider}`
  comes from the existing `GET /api/about`, exactly as Settings already does it
  (`about.provider`, `ProjectHeader.tsx:160`).
- **Today's usage** (`MemoryUsageDto`): *"Today: {jobsToday} of {share} background summaries used,
  shared across all your projects. They pause once fewer than {reserve} of today's Explain calls
  are left."* Note this counter is **global**, not per-project (`jobsToday`'s own doc comment says
  "all projects") — say so explicitly, unlike the per-project "Explains left today" badge in the
  header, so nobody reads it as this project's private quota.
- **Undo last update** (`lastBatch`, a rollback): a plain button, disabled when `lastBatch` is null
  or `rolledBack`. Click reveals inline confirm text naming what it undoes, same interaction shape
  as `.proj-remove` → `Confirm remove?`: *"Undo the {trigger label} from {relative time} — {changed}
  items changed?"* → `Confirm undo?`. Trigger labels: `init` "initial scan", `after-explain`
  "update after a digest", `idle` "background summary run", `daily` "daily sweep", `manual`
  "manual update", `user` "your edit", `rollback` "the last undo" (undoing an undo is a valid
  redo — the button keeps working, it doesn't need to special-case this).
- **Export**: a plain link/button, downloads the project's memory as JSON (mirrors
  `digest memory export`). No confirm — it's non-destructive.
- **Clear**: destructive, same two-step inline pattern as `.proj-remove`: `Clear` → `Confirm clear
  all memory?`, with the count spelled out — *"This deletes all {N} items for {project}. Digests
  you've already read are not affected."* — the second sentence matters: this is easy to
  mis-read as "delete my history," and it isn't.

**Cost:** S for the switch/usage/undo/export copy and wiring once DIG-103's endpoints exist (they
map onto existing patterns almost verbatim); Clear is S as well, same component as Remove.

## 7. Empty states

Two levels, don't conflate them:

- **Whole page, brand-new project (no checkpoint yet):** replace all four sections with one block,
  same voice as the existing `.empty-steps`/`.empty-state` pattern used elsewhere: *"DigestIT
  hasn't looked at {project} yet. Areas and terms appear after the first Explain."* No zeroed-out
  section headers, no fake "0 items" rows — an empty page that still shows four empty section
  headings reads as broken, not new.
- **One empty kind, others populated** (e.g. a project with areas/terms but no ongoing work yet,
  or no notes yet): a single muted line where the list would be, not a missing section — sections
  always exist once the project has *any* memory, only their contents vary:
  - Ongoing work: *"No ongoing work tracked yet — a thread appears once a digest continues
    something from an earlier one."*
  - Your notes: *"Nothing yet. Correct anything you see above, or add project facts to your
    context file — they show up here."* No standalone "+ Add a note" button: `NoteMemory.origin`
    is `'context-md' | 'correction'` only (`packages/core/src/memory.ts`) — there is no freestanding
    "write a note" path in the v1 contract, and inventing one in this UI would promise a flow the
    store doesn't support. If that's wanted, it's a contract change, not a page design — flagging
    it rather than quietly working around it.

## 8. Keyboard and screen reader

- Plain document structure: `<h1>What DigestIT knows</h1>`, `<h2>` per kind section (`Areas`,
  `Terms`, `Ongoing work`, `Your notes`), each list a real `<ul>`/`<li>` — Tab order, no roving
  `tabindex`, consistent with every other list in this app (`.area-cards`, `.proj-list`); the app
  reserves custom key handling (`0`–`3`, `n`/`p`) for the digest reader, not for management pages
  like this one or `/projects`.
- Row actions (`Correct`/`Pin`/`Delete`/`Restore`) are always-visible text buttons, not
  hover-only or hidden behind a `...` menu — a screen-reader or keyboard user must reach them by
  Tab alone, same reasoning as the existing `.ignore-pattern-list` delete button's `aria-label`.
- Toggle: a `<button>` with `aria-pressed` (no `role="switch"`; the label names the setting, not its state),
  labelled, `aria-describedby` pointing at the "what this sends" text so it's read together.
- Two-step confirms (`Confirm remove?`-style) keep focus on the same button through both steps and
  announce the state change via `aria-live="polite"` on the row, matching `ExplainButton`'s
  existing pattern (`ProjectHeader.tsx:61`) — don't invent a second convention for the same
  interaction shape.
- Stale/hidden/overridden states are plain text, already covered by §4 — not color-only anywhere.
- Filter input (`⌕ Filter items…`) is a normal labelled text input, filtering client-side within
  the currently loaded page; it does not fetch — 42 areas + 118 terms + 20 threads + notes is small
  enough to hold in memory, no pagination needed at these caps (`MEMORY_LIMITS`).

## 9. en/ko copy (key strings, for Reviewer/CTO sign-off — full set goes through `copy.ts`)

| Key | en | ko |
|---|---|---|
| Page title | What DigestIT knows | DigestIT가 아는 것 |
| Per-digest link | Grounded in {n} memory items · What DigestIT used | 메모리 항목 {n}개를 근거로 함 · 무엇을 사용했는지 보기 |
| Correct action | Correct | 수정 |
| Pin action | Pin | 고정 |
| Delete action | Delete | 삭제 |
| Restore action | Restore | 복원 |
| Stale status | stale — files changed since checked | 오래됨 — 확인 이후 파일이 변경됨 |
| Overridden | Overridden by your note | 내가 작성한 메모로 대체됨 |
| Summaries switch | Background summaries | 백그라운드 요약 |
| Undo | Undo last update | 최근 업데이트 실행 취소 |
| Export | Export | 내보내기 |
| Clear | Clear | 모두 지우기 |
| Empty (new project) | DigestIT hasn't looked at {project} yet. | 아직 DigestIT가 {project}를 살펴보지 않았습니다. |

## 10. How we'd know it worked

Ties to the milestone doc's own §6 blind-read gate (memory wins ≥7/10 digests on continuity),
which measures the *retrieval*, not this page. This page's own job is narrower: make checking and
correcting fast enough that people actually do it before trusting a continuity claim. Two signals,
both gettable from existing event logging (`memory_use`, batch timestamps) without new
instrumentation:

- **Time from opening a digest with a continuity claim to opening "What DigestIT used" for it** —
  should be near-zero friction (one click, no page reload feel) since it's the same route, just
  filtered; if people aren't clicking it at all on digests that claim continuity, the link is in
  the wrong place or reads as decorative.
- **Correction half-life**: does a `user` note reduce how often the same wrong fact reappears in
  the next few digests' L0/L1 text (checked by the AI-tell/validator tooling already in
  `packages/explain`)? If corrections don't visibly stick, the "Correct" action isn't trusted or
  isn't wired to retrieval priority the way §5 promises, and that's a build bug, not a design one —
  but this page is how we'd notice.

## Open items for the Reviewer

1. §5's "Used for" tag line assumes the memory API groups `memory_use` rows by prompt kind per
   digest — confirm that shape is realistic for DIG-103 before Frontend builds against it, or the
   list falls back to an undifferentiated "used in this digest" with no per-prompt tags (still
   honest, just less specific).
2. Placing the Settings-popover link "always visible" (not gated, unlike `legacyInsightsLink`)
   means every project — including ones with zero memory yet — shows a live link to an empty page.
   I think that's fine (§7 handles it, and hiding the link would be its own inconsistency people
   would trip on), but it's a judgment call worth a second look.
