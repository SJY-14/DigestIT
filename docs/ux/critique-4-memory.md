# UX critique — of brief-4-memory.md (DIG-102, milestone 4, step 2 of the loop)

Scope: re-checked every code citation in `brief-4-memory.md` against this worktree (`ProjectHeader.tsx`,
`App.tsx`, `AllProjects.tsx`/`ProjectRow.tsx`, `styles.css`, `copy.ts`) and the data shapes in
`packages/core/src/memory.ts` and `docs/milestone-4-memory.md`. Rendered the prototype
(`docs/ux/proto/memory/index.html`) in headless Firefox at 1440×900, light and dark, en and ko (all
six screens; Korean checked for `word-break: keep-all` wrapping, none found). Per-finding verdicts
below, most severe first.

## Finding 1 (major) — "used in N digests" promises a number the DTO can't produce

`MemoryItemDto.usedCount` is documented in `packages/core/src/memory.ts:171` as "Explain prompts
that included this item's current version" — a count of **prompts**, not digests. One digest
already fans out into several prompts (the summary, one L3 call per touched area, one per
walkthrough step — `docs/milestone-4-memory.md` §3's three budget tiers exist precisely because
these are separate calls). An item referenced by three prompts in the same digest would show
`usedCount: 3`, and the brief's mockup (§3) renders that straight through as **"used in 3 digests"**
— a literal fabrication of a number the store never computed. This isn't cosmetic: "how often it was
used" is the page's whole pitch for judging whether an item is trustworthy or noise (milestone doc
§5), and an inflated per-digest count is exactly the kind of over-confident number this page exists
to prevent elsewhere (§4's "never hide the evidence" principle cuts the other way here — the count
itself becomes the unverified claim).

Two honest fixes, either is cheap: (a) change the copy to "used in {usedCount} prompts" — correct as
written, just less intuitive than "digests"; or (b) have DIG-103's memory API compute a genuine
distinct-digest count from `memory_use` (it already links item versions to prompts, and prompts
belong to a digest, so grouping is a query change, not a new capability) and expose it as a second
field. I'd recommend (b) since "digests" is the unit everyone thinks in on this page, but either is
fine as long as the shipped number matches its label. Flag this for DIG-103, not just Frontend.

Secondary, same family: "Today: 2 of 4 background summaries used" reads `MemoryUsageDto.jobsToday`
straight through, but a job is a **call** that can write up to 4 area summaries or 1 thread summary
(`docs/milestone-4-memory.md` §4). "2 of 4 background summaries" undersells what happened if those 2
jobs actually wrote 8 area summaries between them. Lower stakes than the digest count above since
the daily-share number is a budget/cost figure, not a trust claim about a specific item — but "2 of 4
background summary runs" or "jobs" would be accurate without losing scannability. Your call on
wording; flagging so it's a decision, not an accident.

## Finding 2 (major, accessibility) — the prototype's toggle mixes an invalid ARIA role/state pair

`docs/ux/proto/memory/index.html:188`: `<button class="mem-switch" role="switch" aria-pressed="false" ...>`.
`role="switch"` requires `aria-checked`; `aria-pressed` is not a supported state for that role (it's
the toggle-button convention, `role="button"` territory). A screen reader has no guaranteed way to
announce this control's on/off state as built, because the one attribute that pair of role+state
actually requires is missing. Brief §8 hedges — "a real checkbox/button pattern with `aria-pressed`
**or** native `<input type="checkbox">`" — which is fine as written (both of those are valid), but
the prototype it ships next to that text picked the one combination that's neither: `role="switch"`
+ `aria-pressed`. Since the brief tells Frontend to build from "the real classes below, not a fresh
visual language," this exact markup is the risk of what gets copied forward.

Fix: either drop `role="switch"` and keep `aria-pressed` (a plain toggle button, matches
`ExplainButton`'s own convention of button + dynamic label elsewhere in this codebase), or keep
`role="switch"` and rename the attribute to `aria-checked`. I'd pick the former — this codebase has
no other `role="switch"` anywhere, so a toggle button is the smaller precedent to introduce. One-line
fix in the prototype before it's cited as the reference markup.

## Finding 3 (major) — no visible pinned state, and no way to unpin

Every item row's action list is static — "Correct · Pin · Delete" (or "Pin · Delete" for threads,
"Edit · Pin · Delete" for notes) — regardless of the item's actual `pinned` boolean
(`MemoryItemDto.pinned`, already in the DTO). Neither the brief's prose nor the prototype shows what
a pinned row looks like, and there's no `Unpin` action anywhere in §3, §4, or the mockup HTML. Pinned
items get retrieval priority (`docs/milestone-4-memory.md` §3: "user notes on touched areas, pinned
items, touched areas..."), so this is a control the owner will actually reach for after a correction
sticks or a fact keeps mattering — and once pinned, there is currently no way to see that it worked,
or to undo it short of Delete (which is the wrong tool: deleting a pinned item throws away the item,
not just its priority).

This is a rendering gap, not a data-shape one — `pinned` already exists on the DTO, so it costs
nothing beyond the design. Needs: a visible indicator when `pinned === true` (text label is enough,
consistent with the "never color alone" rule already applied to `stale`/`hidden`) and the action
label flips to `Unpin` in that state, the same way `.proj-remove`'s own label already flips between
`Remove`/`Confirm remove?` on the same button.

## Finding 4 (minor) — citation drift

`styles.css:673` is cited for `.areas-glance`; in this worktree it's at line 675 (two lines of drift,
likely from an intervening commit). Low stakes on its own, but the last two critiques in this
directory (`critique-2.md` Finding 3, `dig80-critique.md`) both caught the same class of stale
line-number citation — worth a quick fix before this doc gets cited again in the build issue.

## What I checked and did not flag

- IA placement (§2): confirmed against `App.tsx` — `Page` is exactly `'main' | 'insights' |
  'projects'` today, so `/memory` genuinely adds no nav entry, and `pageFor`/`PATH_FOR`/`usePage`'s
  `history.pushState` pattern is exactly what a new `'memory'` case would plug into. The Settings
  popover placement claim (after the language field, before the ignore-patterns section) matches
  `InfoPopover` in `ProjectHeader.tsx:173-188` exactly.
- `ExplainButton`'s `aria-live="polite"` citation (`ProjectHeader.tsx:61`) is accurate; note this
  attribute does not exist on `.proj-remove` today (`ProjectRow.tsx`) — the brief is proposing a new
  combination (borrowing `ExplainButton`'s live-region convention for a two-step confirm button that
  doesn't have one yet), not describing something already unified. Read that way it's a reasonable
  synthesis, not a misquote, but it's worth saying explicitly so Frontend doesn't go looking for an
  existing `aria-live` on `.proj-remove` and conclude the brief was wrong when it isn't there.
- Source badges, stale/hidden semantics, the overridden-item strike-through treatment, the empty
  states (both levels), and the two open items the brief already flagged for me (the "Used for"
  per-prompt grouping assumption, and the always-visible Settings link on zero-memory projects) — no
  objection to any of these. The always-visible-link call is right: gating it would be the
  inconsistency people trip on, and §7's empty state already makes the destination make sense.
- Rendered prototype: light/dark contrast, spacing, and the Korean screen all read cleanly at
  1440×900 — no overflow, no mid-word breaks, dashed-stale-row treatment is legible in both themes.
- `NoteMemory.origin` claim (`'context-md' | 'correction'` only, no freestanding "add a note" path)
  matches `packages/core/src/memory.ts` exactly — right call to flag as a contract gap rather than
  design around it.

## Recommendation

Findings 1–3 are all cheap to fix (copy/DTO-field decision, one HTML attribute, one boolean-driven
label) and don't change the page's shape — I'd fold them into the brief before the CTO's decision
rather than carrying them as build-time surprises. Finding 4 is a one-line correction. No objection
to scope, IA placement, or the overall progressive-disclosure structure.
