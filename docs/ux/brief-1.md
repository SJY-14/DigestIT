# UX brief 1 — proposals (DIG-55 cycle 1, step 2, revised in step 4)

Built on `docs/ux/audit-1.md` (commit 073b48e) plus a direct read of `Reader.tsx`, `MainV2.tsx`,
`App.tsx`, `copy.ts`, `ProjectHeader.tsx`, `DigestPicker.tsx`, `styles.css`, `api.ts` and
`uievents.ts`/`insights.ts` on `apps/server`. Every "fix direction" below cites the line(s) it
touches so the Reviewer and the Frontend Engineer can check it against real code, not intent.

## 0. Round-1 revisions (per `docs/ux/critique-1.md`)

Every citation the Reviewer re-checked came back accurate, so this round is fixes, not
re-litigation. Responses below; full detail is inline in each proposal.

| # | Critique point | Response |
|---|---|---|
| P6 | "See all 3 ↓" CTA promises an in-page scroll but nothing below is those 3 digests | **Change.** CTA now opens the existing `DigestPicker` overlay; label and mockup updated. |
| P6 | No stated purpose for the CTA once the newest digest is already showing | **Change.** Made explicit: the strip is reassurance-first ("you're caught up"); the CTA is optional, for someone who also wants to open the older digests, not a required step. |
| P6 | No design for multiple projects with unread digests | **Accept, scoped out.** Added a sentence naming this as an explicit v1 gap, not silently unaddressed. |
| P6 | `localStorage` is wrong across browsers/devices | **Accept.** Moved from implied-by-"client-only" to a stated limitation next to the cost line. |
| P5 | Marking a whole digest reviewed erases per-area judgment | **Change.** Both options now mark **per area**, matching where L3's "what to check" callout lives. |
| P5 | No undo | **Change.** Added an unmark affordance to both options' mockup. |
| P5 | Option B's "visible in Insights for free" needs a caveat | **Change.** Caveat added: needs either Insights to read v2-shaped events or a second bucket — not zero extra work. |
| P3 | `title` is hover-only, unreliable for keyboard/screen-reader users | **Accept, mechanism changed.** Swapped for a visible description `<span>` under each item; cost unchanged (S). |
| P2 | L0→L3 cards skip L1/L2, breaking the app's own level-progression model | **Change.** Cards now land on L2 with the area pre-selected/scrolled-to, not straight on L3. Relabeled accordingly. |
| P2 | New cards' accessibility (real `<button>`, not `<li>`) wasn't stated | **Accept.** Added as an explicit requirement, citing `AreaPicker`'s existing pattern. |
| P1 | Cold load of a History page has no language to fall back to | **Change.** Fix direction now has `App` fetch the project's language directly instead of only depending on `MainV2` having mounted. |
| P1 | History **page content** (not just the menu chrome) stays English | **Accept.** Added to §4 "Not proposed," matching how P3 already scopes out the same pages. |
| P4 | Step 2 (contrast) is a confirmed fail, not "worth checking" | **Accept the finding as a fact update.** Rewrote as a required fix with two named options, not a QA pass. |
| P4 | Step 1 (manual Tab-through) has no in-sandbox owner | **Accept.** Named the operator as the owner of that one step; everything else stays with the Reviewer/Engineer. |

No point was rejected — the critique's citations were all correct and every finding held up under
a second look, so this round is entirely "change" or "accept."

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

**Cold-load fix (added in revision).** A `useRef` alone is empty the first time a browser opens a
History page directly (bookmark, shared link, or `App.tsx`'s existing old-style-deep-link path)
without visiting Home first in that session — the critique is right that this regresses to the
exact bug P1 exists to fix, just via a different entry path. Fix: `App` already knows which
project a History page belongs to (it has the id to render the page at all), so on a cold load it
should fetch that project's `language` directly from the v2 projects list rather than waiting for
`MainV2` to mount and report it. The ref becomes the fast path (no extra request once `MainV2` has
run this session); the fetch is the correctness fallback for cold loads. No new endpoint — v2's
existing project list already carries `language` per `ProjectDto`.

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
   trimmed card — title, file/± stats, "Open area →" — no `effect`/`how`/`why` body, so L0 stays
   a one-line summary with a map attached, not a second L2. See prototype below.
   **Revised per critique**: the card now lands on **L2 with that area pre-selected/scrolled to**,
   not straight on L3. The audit and the app's own level tabs/keyboard shortcuts (`0`/`n`/`p`)
   teach a strict progression, and jumping L0→L3 skips the "what changed structurally" framing L3's
   area cards assume you've already seen — the critique is right that this is a real risk for
   persona (c), not just a labeling nit. Landing on L2 keeps the shortcut (skip past L1's prose)
   without skipping the structural framing; the card's label changed from "Walk through →" to
   "Open area →" to match (no promise of L3). **Accessibility requirement (added):** these cards
   must be real `<button>` elements with the same focus/hover/blur handling as `Reader.tsx`'s
   existing `AreaPicker` cards — the mockup's bare `<li>` is prototype-only shorthand and must not
   be copied into the real component.
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
about, landing on L2 already scoped to it, without detouring through L1's prose or hunting for it
again in L2's full list. The L3-picker fix is pure visual cleanup (Finding 6 folds into it) — no
behavior change.

**Cost.** L0 module: M (new small component + a few lines of copy, no new data — the digest
response already includes everything it needs). L3-picker height fix: S (one CSS rule).

**Measure.** If P6's `postUiEvent`-style instrumentation direction (§4) is later added to v2,
watch whether "open area" clicks from L0's new module become a meaningful fraction of L2 entries —
that would confirm people use it as a shortcut rather than ignoring it. Until then, a simple
before/after screenshot at the same viewport is enough to confirm the whitespace is gone.

### P3 — History menu: name what these are [S] — answers Finding 4

**Problem.** `history-open.png`: "Units / Timeline / Briefing / Insights" are undefined
pre-v2 nouns, one click from the main flow, with zero explanation (`App.tsx:210-220`).

**Fix direction (mechanism changed per critique).** A native `title` attribute is hover-only in
most browsers and inconsistently announced by screen readers — exactly the wrong mechanism for a
first-time keyboard or screen-reader user, who is the person "recognition rather than recall"
(Nielsen #6) is meant to help. Swap it for a visible one-line description under each item — short
capsule text like "Units — group changes by ticket/issue," rendered as a `<span class="menu-item-
desc">`, same pattern as the digest cards' own description text (not a tooltip) — plus a small
non-interactive label above the list, "Other views," so the menu visually reads as "a different,
secondary surface" rather than four peers of Home. `HISTORY_PAGES`/`PAGE_LABEL` already provide the
structure to hang this off (`App.tsx:19-22`). Cost is unchanged (S): still static strings and one
extra element per item, no logic change.

**Mockup.**
```
History ▾
┌─────────────────────────────────────────┐
│ Other views                              │   ← new, non-interactive label
│ Units                                    │
│   group changes by ticket/issue          │   ← visible text, not a title tooltip
│ Timeline                                 │
│   changes in chronological order         │
│ Briefing                                 │
│   narrative summary over a date range    │
│ Insights                                 │
│   charts and trends across digests       │
└─────────────────────────────────────────┘
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

**Fix direction — updated per critique with a real result, not a plan to get one:**

1. **Confirmed fail, not "worth checking."** The Reviewer ran the actual WCAG contrast math on
   `styles.css:5-47`'s real hex values: `--hover` vs `--bg` is 1.10:1 (light) / 1.09:1 (dark),
   `--selected` vs `--bg` is 1.14:1 (light) / 1.31:1 (dark) — all far under the 3:1 WCAG 1.4.11
   non-text threshold, not a borderline case. `styles.css:435`'s
   `.digest-row-main:hover, :focus-visible { background: var(--hover); outline: none; }` fails
   confirmed, in both themes. This is now a required fix, not a QA pass, and not color-only (since
   `--hover`/`--selected` are shared tokens used elsewhere, so nudging their values changes more
   than this one component). Two fix options for the Frontend Engineer to pick between: (a) drop
   `outline: none` on `.digest-row-main` so the same global focus-visible ring every other
   focusable element gets applies here too — simplest, most consistent; (b) keep the background
   pattern but add a stronger focus-only visual (e.g. a left border) that independently clears 3:1
   against `--bg`, if the row background is meant to stay distinct from a plain ring. My
   recommendation is (a) — one less bespoke pattern, no new token — but either closes the finding.
2. **Step (1), manual real-browser Tab-through, needs the operator.** This sandbox's browser
   automation is headless BiDi Firefox with no real, OS-focused browser window — the same
   constraint that already blocked real-provider screenshots this cycle
   (`.cache/dig47-acceptance/README.md`). This step has no agent-side owner; it should be assigned
   to the operator explicitly, not left as an implicit QA task, when this brief reaches the CTO.
3. **Step (3), icon-only triggers** (zoom `−`/`+`, `▾`, `ⓘ`) still needs the same per-element
   contrast check as step (1) received — not done yet, flagged as open, not silently dropped.

**Expected effect.** Fixes a real, confirmed WCAG failure on a frequently-used element (every
digest-picker row) rather than a hypothetical one — this is no longer "cheap insurance," it's a
known bug.

**Cost.** S. One CSS change for the confirmed fail (fix option (a) is a single property removal);
step (3)'s check is the same small effort as step (2) already spent.

**Measure.** N/A — pass/fail verification. The Reviewer's cross-cutting note (§3) is worth
repeating here: v2 has no visual-regression check, so nothing will catch this failing again later
without a screenshot-diff test on the focused state — not proposed for this cycle, but named as
the reason to consider one.

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

**Granularity changed per critique: per area, not per digest.** Both options below now mark a
single **area** reviewed, not the whole digest. The audit's own persona-(b) note points at L3's
"what to check" callout as the thing a reviewer actually acts on, and a digest can hold several
areas each with its own callout — marking the whole digest reviewed after reading one area
carefully and skimming another would erase that distinction, turning "reviewed" into "I clicked
through it" instead of "I looked carefully." Per-area also matches the level L3 already
structurally supports (`Reader.tsx`'s per-area callout, one per `digest.l2.items` entry).

- **Option A — client-only "seen" mark [M].** A toggle button ("Mark as reviewed") in the L3
  walkthrough header for the current area, backed by `localStorage` keyed by
  `projectId:digestId:areaId`. No server change. Ships fast; state doesn't survive a different
  browser/device, and doesn't show up in Insights. Good enough if "reviewed" only needs to mean
  "don't make *me* re-read this area."
- **Option B — real, shared "reviewed" state [L].** New event kind on v2 digest **areas**
  (`digestId` + `areaId`, not just `digestId`), following the existing `unit_event`/insights
  pattern. Persists across devices. **Caveat added per critique**: "becomes visible in Insights for
  free" overstates it — there's no existing mapping from a v2 `digestId`/`areaId` pair to anything
  the legacy `workUnitId`-keyed Insights view aggregates by today, so this is "extends the existing
  pipeline" (real, load-bearing reuse), not "zero extra work." Insights would need to either learn
  to read v2-shaped events or gain a second bucket.

**Undo (added per critique, both options).** Clicking the toggle again while reviewed unmarks it —
the mockup below now shows both directions, not just the on-state, since a mis-click next to a
frequently-clicked control (the digest picker trigger area) is plausible and there was previously
no stated way back.

**Mockup (either option, same UI, per-area, with undo).**
```
Digest · Today, 17:05 › README.md · Area 1/3 › L3 Code    [ ○ Mark as reviewed ]
                                                               ↓ click
Digest · Today, 17:05 › README.md · Area 1/3 › L3 Code    [ ✓ Reviewed ]  ← click again to unmark
```

**Expected effect.** Closes persona (b)'s "read and leave" gap named in the audit, at the
granularity they actually judge at — but only if the CTO decides this is in scope; it's the one
proposal here that could be a straight reject.

**Cost.** A: M. B: L (unchanged by the granularity change — an `areaId` column is not a bigger
schema change than a `digestId`-only one).

**Measure.** % of areas marked reviewed within a session (either option); Option B additionally
extends into the existing Insights `reviewed` bucket, with the mapping caveat above.

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
looked, 2h ago · 18 files total." It disappears once the newest digest has been opened. First-time
projects (no digests yet) are unaffected — the existing empty state (`project2-first-run.png`)
already handles that well and shouldn't be touched.

**Purpose, stated explicitly (added per critique).** The strip is **reassurance-first**: landing
already shows the newest digest's L0 (the audit confirms this already answers "what did the
current digest do"), so the strip's job is only to answer "did anything else happen while I was
away" in one glance — it does not expect or require the owner to go open the older digests too.
That's why the CTA is optional, not a call to action the owner needs to complete before feeling
caught up.

**CTA fixed per critique.** The mockup's original "See all 3 ↓" with a down-arrow promised an
in-page scroll to a list of 3 digests that doesn't exist there (the areas grid below it, from P2,
is the *current* digest's areas, not the other 2 digests) — a real "match between system and real
world" break on the one element meant to build first-glance trust. The button now opens the
existing `DigestPicker` overlay (the only real place a list of digests lives) instead: label
changed to "Open digest list," icon changed from `↓` to the picker trigger's own `▾` caret, so the
affordance reads as "open a panel," not "scroll down."

**Scope gaps named explicitly, not left implicit (added per critique).**
- **Multiple projects.** This strip is per-project — it only appears once you've landed on a
  project that has unread digests. A busy owner with 3+ projects running unattended still has to
  visit each one to discover which have anything new; there's no cross-project "N projects have
  unread digests" signal in this proposal. That's a real, second instance of the same "manually
  check" problem this proposal is trying to remove, just moved up one level — out of scope for v1
  (it would need a projects-list landing view this app doesn't currently have), but should be read
  by the CTO as a known gap, not an oversight.
- **Cross-device.** `localStorage` is per-browser, unkeyed by device. Opening the same project from
  a different browser or an incognito window (plausible — checking from a phone) shows either a
  stale count or no strip at all, not a wrong-but-harmless state, but it can under- or over-claim
  "you missed N." Acceptable for a v1 reassurance feature, not acceptable if this ever needs to be
  authoritative (e.g. feeding a metric) — noted next to cost below rather than left to be inferred
  from "client-only."

I placed this inside the reading pane, not the sticky header — `ProjectHeader.tsx:1-4` states the
header is deliberately kept to one line ("every pixel it takes comes out of the reading pane
below"), so a new header element would fight that constraint. Putting it at the top of L0 instead
costs nothing extra: P2 already adds content to that exact spot.

**Mockup.** `docs/ux/proto/l0-recap.html` — the top of the "after" column is this proposal.

**Expected effect.** Answers "did anything happen while I was gone" in the first glance, before
reading a single word of content — the actual "first 30 seconds" moment the issue asked about.

**Cost.** M. New `localStorage` helper + one small strip component + copy; no server change for v1.
Known limitation (stated here, not just implied): per-browser/device, so a different browser or an
incognito window shows a stale or missing count — acceptable for a v1 reassurance feature, see
"Scope gaps" above.

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
  treat them as out of scope this cycle (P3 only touches the menu that links to them). **Added per
  critique**: this includes their *content* staying English even after P1 — P1 only localizes the
  top-level chrome (nav labels, History dropdown), not what's rendered inside those pages. A
  Korean-speaking user still hits English content one click past the (now-localized) menu; worth
  saying explicitly here so nobody reads P1 as "History is now localized," the same way P3 already
  scopes out a page redesign for the same surfaces.
- Graph accessibility (`ProjectGraph.tsx`'s `aria-hidden="true"`) — the audit names this as a
  documented, accepted tradeoff (all graph content is reachable via text), not a finding to design
  against this cycle.

(The `styles.css:435` background-only focus pattern is no longer in this list — the Reviewer's
contrast check confirmed it fails WCAG, so it moved from "not proposed" into P4 as a required fix.)

## 5. Handoff

This is the round-1 revision (§0 above answers every point in `critique-1.md`; nothing was
rejected). Reassigning to the UX Reviewer for a focused round-2 pass per the DIG-55 loop
("revise at most twice"): please confirm the two previously-blocking items are actually resolved —
P6's CTA now opens `DigestPicker` instead of implying an in-page scroll, and P5 now marks
per-area with undo — and flag anything in §0 that only looks fixed on the page. If those hold up,
this brief should go straight to the CTO rather than consuming a second full revision round; P5
still needs the CTO's read on Option A vs. B vs. reject (that's a product call, not something
another critique round resolves), and P4's operator-owned step should be routed to the operator
alongside the CTO's decision on the rest.
