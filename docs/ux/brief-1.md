# UX brief 1 — proposals (DIG-55 cycle 1, step 2)

Built on `docs/ux/audit-1.md` (commit 073b48e) plus a direct read of `Reader.tsx`, `MainV2.tsx`,
`App.tsx`, `copy.ts`, `ProjectHeader.tsx`, `DigestPicker.tsx`, `styles.css`, `api.ts` and
`uievents.ts`/`insights.ts` on `apps/server`. Every "fix direction" below cites the line(s) it
touches so the Reviewer and the Frontend Engineer can check it against real code, not intent.

## 1. The problem, before the UI

DigestIT's whole premise is that a person can digest AI-made changes as fast as the AI produces
them. That only works if, at every level (L0→L3), the *chrome around the content* gets out of the
way and the *state of the world* ("what's new since I looked, have I dealt with it") is visible
without re-deriving it from memory. Two things currently work against that:

1. **The chrome undermines trust before anyone reads a word.** A half-localized header
   (Finding 1) or a page that's 60% blank at first glance (Finding 3) reads as "unfinished," which
   primes a skeptical read of the content that follows — the opposite of what a fast-digest tool
   wants. This is cheap to fix and disproportionately important because it's the *first* thing
   every persona sees, every time, before any judgment about the AI's work itself.
2. **The product has no memory of the reader.** Two different "state" gaps compound this:
   returning after time away, there's no answer to "did anything happen while I was gone that I
   haven't seen" (nothing beyond audit Finding 5); and once someone *has* read a digest, there's no
   way to record that (Finding 5). Persona (a) and (b) both lose time re-establishing context that
   the tool already has and simply doesn't surface.

The six proposals below address both: P1–P4 are chrome/content fixes (cheap, high-confidence,
directly answer audit findings 1/2/3/4/6); P5 answers Finding 5 but needs a product decision, so
it's presented as options, not a single recommendation; P6 is the bolder idea the issue asked for
— it's the one proposal not triggered by a specific finding, aimed at persona (a)'s first 30
seconds.

Cost tiers used throughout: **S** = CSS/copy-only or a few lines, no new state; **M** = new
component or new client-side state, no schema change; **L** = server schema/API change.

## 2. Proposals

### P1 — Localize the top-level chrome [S] — answers Finding 1

**Problem.** `copy.ts:1-8` already runs every other string through an `_EN`/`_KO` table keyed by
the project's `language`. The top nav doesn't: `App.tsx:22` (`PAGE_LABEL`) and `App.tsx:208`
(`<summary>History</summary>`) are literal English, so `dark-ko-header-idle.png` shows a fully
Korean page under an English "DigestIT | Home | History" bar — worse than all-English, because it
reads as broken rather than as "not translated yet."

**A real constraint the audit didn't surface**: `App.tsx` (which renders the nav) doesn't
currently know the project's language at all — only `MainV2.tsx:332` computes `lang` (from
`projects.find(...).language`), and `MainV2` isn't even mounted on the History pages (`/units`,
`/timeline`, etc., which key off the older `repoId`, not a v2 `projectId` — see `App.tsx:194-202`
vs. `v2Api.ts`'s `ProjectDto`). So "just wire it through" isn't quite right: there is no project
language in scope at all once you've navigated off Home.

**Fix direction.** Treat "last-known project language" as a small piece of `App`-level state,
the same pattern already used for `mainSearch` at `App.tsx:52` (a `useRef` that survives page
switches). `MainV2` reports its `lang` up via a new `onLanguage` callback prop whenever it changes
(mirrors the existing `onSetLanguage` write path at `MainV2.tsx:494`, just in the read direction);
`App` keeps the last value and uses it for `PAGE_LABEL`/`"History"` regardless of which page is
active. Add a `NAV` table to `copy.ts` (6 strings: Home, History, Units, Timeline, Briefing,
Insights) following the existing `_EN`/`_KO` convention.

**Mockup.**
```
Before (dark-ko-header-idle.png):   DigestIT | Home | History        ← stays English
After:                               DigestIT | 홈 | 히스토리          ← follows last project's language
```

**Expected effect.** Removes the single most visible "half-migrated" signal on the page for
persona (d) — it's the top-left corner, on every screen, all the time.

**Cost.** S. ~6 new copy strings + one small state-lift in `App.tsx` (no new component, no schema).

**Measure.** Binary regression check, not a metric: screenshot `dark-ko-header-idle.png` again
after the fix and confirm zero English strings above the fold when `language: 'ko'`. Not worth
instrumenting further.

### P2 — "Areas in this digest" on L0 + let short L3-picker content stop stretching [S/M] — answers Findings 3 & 6

**Problem.** `light-en-L0.png` and `light-en-L3-picker.png`: both views leave 400px+ of blank
space below a few lines of content, at exactly the graph pane's height.

**Root cause (traced, not guessed).** `styles.css:469` — `.reader-split { ... align-items:
stretch ... }` — is deliberate: `docs/ux-v3.md §1` designs the reading pane as *the one long
scroll* on a fixed-height page, so `.reading-pane` (`styles.css:470`) must be able to stretch to
full height for L1/L2/L3-walkthrough views with real content. The bug isn't the stretch rule
(removing it would break the single-scroll design for the views that need it) — it's that L0
(`SummaryView`, `Reader.tsx:140`) and the no-area-selected L3 picker (`AreaPicker`, `Reader.tsx:258`)
are short by nature and stretch anyway, with nothing to fill the space.

**Fix direction — two parts, deliberately different:**

1. **Give L0 a reason to use the space** (this is the actual content fix, not a layout hack):
   add a compact area grid below the existing headline/stats/Next button, reusing the *data*
   `StructureView` already renders (`digest.l2.items` + `areaStats()`, `Reader.tsx:200-254`) but a
   trimmed card — title, file/± stats, "Walk through →" — no `effect`/`how`/`why` body, so L0 stays
   a one-line summary with a map attached, not a second L2. See prototype below.
2. **For the L3 picker specifically**, adding cards doesn't apply — it already shows all of
   `digest.l2.items` in `.area-picker` (`Reader.tsx:269`, grid defined at `styles.css:546`), so a
   3-area digest will never fill 700px no matter the grid. Scope a CSS override to the two
   short views instead of touching the shared `.reader-split` rule: `.reading-pane:has(.level-0),
   .reading-pane:has(.level-3-picker) { align-self: start; }`. (`:has()` has been supported in
   every evergreen browser since 2023; if the Frontend Engineer wants a fallback, a
   `data-short-view` class toggled alongside the existing `level-0`/`level-3-picker` classes is a
   one-line alternative — same result, no `:has()` dependency.)

**Mockup.** `docs/ux/proto/l0-recap.html` (open in a browser) shows the L0 "after" with the areas
module — the bottom half of that file is P2; ignore the recap strip at the top for now, that's P6
below (they share a screen but are independent proposals — see §3 on shipping them separately).

**Expected effect.** L0 goes from "headline, then nothing" to "headline + a map of what's inside,"
which is a genuine second win for persona (a): they can jump straight to the one area they care
about without detouring through L1/L2. The L3-picker fix is pure visual cleanup (Finding 6 folds
into it) — no behavior change.

**Cost.** L0 module: M (new small component + a few lines of copy, no new data — the digest
response already includes everything it needs). L3-picker height fix: S (one CSS rule).

**Measure.** If P6's `postUiEvent`-style instrumentation direction (§4) is later added to v2,
watch whether "walk through" clicks from L0's new module become a meaningful fraction of L3
entries — that would confirm people use it as a shortcut rather than ignoring it. Until then, a
simple before/after screenshot at the same viewport is enough to confirm the whitespace is gone.

### P3 — History menu: name what these are [S] — answers Finding 4

**Problem.** `history-open.png`: "Units / Timeline / Briefing / Insights" are undefined
pre-v2 nouns, one click from the main flow, with zero explanation (`App.tsx:210-220`).

**Fix direction.** Add a one-line `title` attribute (native tooltip, no new component) per item —
short capsule descriptions like "Units — group changes by ticket/issue" — and a small
non-interactive label above the list, "Other views," so the menu visually reads as "a different,
secondary surface" rather than four peers of Home. `HISTORY_PAGES`/`PAGE_LABEL` already provide the
structure to hang this off (`App.tsx:19-22`).

**Mockup.**
```
History ▾
┌─────────────────────────────┐
│ Other views                  │   ← new, non-interactive label
│ Units      (title on hover)  │
│ Timeline                     │
│ Briefing                     │
│ Insights                     │
└─────────────────────────────┘
```

**Expected effect.** Closes the one first-time-user confusion point the audit found; low risk
since the pages themselves are explicitly out of scope this cycle.

**Cost.** S. Static strings + one `<span>`, no logic change.

**Measure.** Not worth instrumenting on its own — bundle a check into P6's "unread" work if that
ships (§4), otherwise treat as a copy fix verified by review.

### P4 — Verify, then harden, keyboard focus visibility [S] — answers Finding 2

**Problem.** The audit couldn't fully confirm Finding 2 (headless BiDi may lack OS focus). I
traced the CSS to add a second signal:

- `styles.css:96` (`:focus-visible { outline: 2px solid ...}`) is global and correct.
- `styles.css:424` (`.digest-picker-trigger:focus-visible`) explicitly re-asserts a ring on the
  exact element the audit's screenshot shows with no ring — the code clearly *intends* a ring
  there. That a code-defined, unambiguous style didn't render in the BiDi capture is itself
  evidence for the Reviewer's own hypothesis (headless artifact), not a missing style.
- One real, intentional-looking exception: `styles.css:435` —
  `.digest-row-main:hover, .digest-row-main:focus-visible { background: var(--hover); outline:
  none; }` — dropdown rows trade the ring for a background highlight (a legitimate, common
  pattern), but I can't confirm from a screenshot alone whether that background shift meets
  WCAG AA non-text contrast (3:1) against `--bg`/`--selected` in both themes.

**Fix direction.** Not a redesign — a scoped verification pass: (1) manual, non-headless Tab-through
of header → level tabs → digest picker → L3 step nav in a real browser, both themes, confirming a
visible indicator at every stop (ring or the row background); (2) contrast-check
`styles.css:435`'s hover/focus background against `--bg` (light) and `--bg` dark variant with a
tool (not eyeballing); (3) icon-only triggers (zoom `−`/`+`, `▾`, `ⓘ`) already have `aria-label`s
per the audit's code read — worth confirming they also get a *visible* (not just accessible-name)
affordance on focus, since sighted keyboard users rely on the ring alone for those.

**Expected effect.** Either closes Finding 2 as a non-issue (most likely, given the traced CSS) or
catches a real regression before it reaches a real user — cheap insurance either way.

**Cost.** S. This is a QA task, not a build task; if (2) fails the contrast check, the fix is a
one-line color change.

**Measure.** N/A — pass/fail verification, not a metric.

### P5 — A lightweight "reviewed" affordance for persona (b) — needs a product decision — answers Finding 5

The audit is right that this needs a decision, not a design, first: does DigestIT want to track
"I looked at this" at all, given it positions itself as an explain tool, not an approval tool? I'm
presenting two buildable options so the CTO can pick one, both, or neither, rather than
recommending a specific one myself.

**What I found that changes the cost math**: `apps/server/src/uievents.ts:9` already defines
`UI_EVENT_KINDS` including `'reviewed'`, with a full pipeline — `unit_event` table, insights
aggregation (`insights.ts:186`), a `DrillBucket` of `'reviewed'` already in the API
(`api.ts:206`). It's real infrastructure, not a stub — but it's wired only to the legacy
`workUnitId`-keyed Units surface (`Units.tsx:216`), which is a different entity than a v2
digest/area. Extending it to v2 is a genuine schema question, not a reuse-as-is.

- **Option A — client-only "seen" mark [M].** A toggle button ("Mark as reviewed") next to the
  digest picker or in the L3 walkthrough header, backed by `localStorage` keyed by
  `projectId:digestId`. No server change. Ships fast; state doesn't survive a different browser/
  device, and doesn't show up in Insights. Good enough if "reviewed" only needs to mean "don't
  make *me* re-read this."
- **Option B — real, shared "reviewed" state [L].** New event kind on v2 digests (not areas —
  match the granularity persona (b) actually judges at, per the audit), following the existing
  `unit_event`/insights pattern. Persists across devices, becomes visible in Insights next to the
  existing `'reviewed'` bucket. Real schema + API + insights wiring.

**Mockup (either option, same UI).**
```
Digest · Today, 17:05 › README.md › L3 Code              [ ○ Mark as reviewed ]
                                                              ↓ click
Digest · Today, 17:05 › README.md › L3 Code              [ ✓ Reviewed ]
```

**Expected effect.** Closes persona (b)'s "read and leave" gap named in the audit — but only if the
CTO decides this is in scope; it's the one proposal here that could be a straight reject.

**Cost.** A: M. B: L.

**Measure.** % of digests marked reviewed within a session (either option); Option B additionally
surfaces in the existing Insights `reviewed` bucket for free.

### P6 (bolder) — A "welcome back" recap for the first 30 seconds [M] — not triggered by a specific finding

**Reasoning.** Persona (a) is named first in this cycle's brief for a reason: "busy owner back
after 2h of AI work" is the load-bearing use case. Today, landing on Home answers "what did the
*current* digest do" well (the audit calls this out as already working) — but nothing answers
"how much happened while I was away, and have I seen it all." If three digests landed while the
owner was in a meeting, they'd have to manually check the digest picker's date column and count. I
verified there's no existing tracking for this: I grepped `MainV2.tsx`/`v2Api.ts`/`v2Fixtures.ts`
for `unread`/`lastViewed`/`seen` and found nothing — this is genuinely unbuilt, not a fix.

**Fix direction.** Client-only for v1 (no server schema needed): store the last-seen digest id per
project in `localStorage` (the same pattern P5 Option A would use, so if the CTO builds both,
they share one small storage helper). On landing, if the current digest isn't the last one this
browser saw, show a compact one-line strip above the L0 headline: "3 digests since you last
looked, 2h ago · 18 files total," with a link to expand the digest picker. It disappears once the
newest digest has been opened. First-time projects (no digests yet) are unaffected — the existing
empty state (`project2-first-run.png`) already handles that well and shouldn't be touched.

I placed this inside the reading pane, not the sticky header — `ProjectHeader.tsx:1-4` states the
header is deliberately kept to one line ("every pixel it takes comes out of the reading pane
below"), so a new header element would fight that constraint. Putting it at the top of L0 instead
costs nothing extra: P2 already adds content to that exact spot.

**Mockup.** `docs/ux/proto/l0-recap.html` — the top of the "after" column is this proposal.

**Expected effect.** Answers "did anything happen while I was gone" in the first glance, before
reading a single word of content — the actual "first 30 seconds" moment the issue asked about.

**Cost.** M. New `localStorage` helper + one small strip component + copy; no server change for v1.

**Measure.** This is the one proposal with a clean, testable prediction: time from page load to
first L3 open (or first meaningful scroll) should drop for returning sessions with >1 unread
digest, since the strip removes a manual "how many did I miss" check. No instrumentation exists
in v2 yet to measure this today (see §3) — this would be the first thing worth wiring up.

## 3. Cross-cutting: v2 has zero instrumentation today

Worth flagging before anyone commits to "how would we measure it" answers above: I traced
`postUiEvent` (`api.ts:240`, kinds `opened`/`level_viewed`/`reviewed`) and it's called from
exactly one place — `Units.tsx` (the legacy Units surface). `MainV2`/`Reader.tsx` — the entire v2
reading flow every proposal above lives in — posts nothing. So none of the "measure" answers above
can cite a real current signal; they're proposals for what *should* exist. Rather than inventing a
new pipeline, the cheapest path is extending the existing `UiEvent` kind/table/insights-aggregation
pattern to v2 digests (the same infrastructure P5 Option B would touch) — one extension serves
both. I'm flagging this as a shared prerequisite rather than folding it into any single proposal's
cost, since it's genuinely cross-cutting.

## 4. Not proposed

- A redesign of the Units/Timeline/Briefing/Insights pages themselves — audit and this brief both
  treat them as out of scope this cycle (P3 only touches the menu that links to them).
- Changing `.digest-row-main`'s background-only focus pattern (`styles.css:435`) — flagged in P4
  as needing a contrast check, not proposing a change until that check runs.
- Graph accessibility (`ProjectGraph.tsx`'s `aria-hidden="true"`) — the audit names this as a
  documented, accepted tradeoff (all graph content is reachable via text), not a finding to design
  against this cycle.

## 5. Handoff

Reassigning to the UX Reviewer to critique this brief per the DIG-55 loop: for each of P1–P6, what
works, what will fail and why, and what's missing. P5 in particular needs the Reviewer's read on
whether *either* option is worth building before it goes to the CTO as a two-position question.
