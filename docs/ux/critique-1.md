# UX critique 1 — of brief-1.md (DIG-55 cycle 1, step 3)

Scope: DIG-55 loop step 3 (UX Reviewer). I re-checked every line citation in `brief-1.md`
against the actual code on this branch (`App.tsx`, `copy.ts`, `MainV2.tsx`, `Reader.tsx`,
`styles.css`, `ProjectHeader.tsx`, `DigestPicker.tsx`, `apps/server/src/uievents.ts`) —
all of them are accurate (the `PAGE_LABEL`/`History`-summary/`lang`/`onSetLanguage`/
`.reader-split`/focus-visible/`UI_EVENT_KINDS` line references all point at what the brief
says they do). I also opened `docs/ux/proto/l0-recap.html` in a browser. This is a well-
grounded brief; my job here is to find what still breaks. Per-proposal verdicts below, most
severe first.

## P6 — welcome-back recap: the mockup's own CTA doesn't point anywhere

**What works**: the reasoning is right and it's genuinely the "first 30 seconds" idea the
issue asked for. Verifying there's *no* existing unread-tracking (grepped for
`unread`/`lastViewed`/`seen`) before proposing new storage is exactly the kind of check I'd
otherwise have had to redo.

**What will fail**: in `l0-recap.html`'s "after" column, the strip reads *"3 digests since you
last looked... [See all 3 ↓]"*, with a down-arrow that visually promises "scroll down to see
them." But nothing below is those 3 digests — the areas-at-a-glance grid (P2) shows the areas
*inside the single current digest*, not a list of 3 digests. Click "See all 3 ↓", scroll down,
and you land on something that isn't what was promised — a real "match between system and real
world" break (Nielsen #2) on the exact element meant to build trust in the first glance. The
only existing UI that actually lists digests is `DigestPicker.tsx`'s overlay
(`digest-row-main`, one row per digest, newest first) — the button should open *that*, not
imply an in-page scroll. Swap the down-arrow for something that reads as "open" (e.g. the
picker's own trigger affordance) and change the label to something like "Open digest list"
or reuse the picker trigger's existing wording.

**What's missing**: 
- If landing already shows the newest digest (confirmed by the audit — "header 'landed' state
  answers what happened in one glance"), what does "See all 3" actually accomplish once
  clicked? The user is *already* looking at the newest one. The brief should say explicitly:
  does the strip exist purely as reassurance ("you're caught up, here's what you missed"), or
  does it expect the owner to go back and open the 2 older ones too? Those are different
  designs — one needs a CTA, the other doesn't. Right now the mockup implies the CTA matters
  but the brief text doesn't say why.
- No design for what happens across *multiple projects*. Persona (a) plausibly has 3+ projects
  running unattended for 2h. Does the recap strip appear per-project (only when you land on
  that project) or is there any cross-project "3 projects have unread digests" signal? If it's
  per-project only, a busy owner still has to visit every project to discover which ones have
  anything to catch up on — that's the same "manually check" problem the proposal is trying to
  remove, just moved one level up. Worth a line acknowledging this is out of scope for v1 rather
  than leaving it unaddressed.
- `localStorage` per-project, unkeyed by browser/device, means the recap is wrong (shows stale
  "3 digests" or nothing at all) the moment the owner opens a different browser or an incognito
  window — plausible for someone checking from a phone. Not a blocker, but the brief should say
  this limitation out loud next to the cost, not just imply it via "client-only for v1."

## P5 — reviewed affordance: granularity doesn't match the tool's own reading model

**What works**: finding the real `unit_event`/`UI_EVENT_KINDS`/insights infrastructure and
correctly identifying that it doesn't reach v2 digests is good, load-bearing research — it
changes the cost estimate for Option B from "just wire it up" to "extend a schema," which the
brief gets right.

**What will fail**: both options mark a whole **digest** as reviewed. But the audit's own
persona-(b) note points at the L3 "What to check" callout as the thing a reviewer actually acts
on — and a digest can contain multiple areas, each with its own callout. If a reviewer reads
area 1's callout carefully and skims area 2, marking the *digest* reviewed erases that
distinction — "reviewed" stops meaning "I looked carefully" and starts meaning "I clicked
through it," which is a weaker signal than persona (b) needs, and weaker than what L3 already
structurally supports (per-area). This isn't a reason to reject P5, but the granularity should
be **per-area**, not per-digest — matching the level at which the tool already asks the
reviewer to make judgments.

**What's missing**: neither option addresses *undo*. A reviewer who marks something reviewed by
mis-click (plausible — it's proposed as living right next to the picker trigger, a
frequently-clicked target) has no stated way to unmark it. The mockup shows only the on-state
transition. Also missing for Option B specifically: is there an existing mapping from a v2
`digestId`/area id to anything the legacy `workUnitId`-keyed Insights view already aggregates
by? If not, Option B's "becomes visible in Insights for free" claim needs a caveat — the
Insights page would need to either learn to read v2-shaped events or get a second bucket. Not
disqualifying, just don't let the CTO read "for free" as "no extra work."

## P3 — History menu labels: `title` is the wrong mechanism for a first-timer's confusion

**What works**: right diagnosis, right cheap fix in spirit, and the "Other views" separator
label is a good, low-cost signal that these are a different surface.

**What will fail**: a native `title` attribute is a poor fix for exactly the persona this
targets. `title` tooltips are hover-only in most browsers — they do not reliably appear on
keyboard focus, and screen-reader announcement of `title` is inconsistent (many screen readers
skip it entirely unless paired with `aria-describedby`). A first-time *mouse* user might see it
if they pause on the item, but a first-time keyboard or screen-reader user — exactly who
"recognition rather than recall" (Nielsen #6) is supposed to help — gets nothing. Given the
audit found no keyboard-focus problem *specific* to this menu (Finding 2 is about focus rings
generally, not this menu), the safer fix is a visible one-line description under each item
(the brief's own comparison point — "like the digest cards on L3 do" — already does this with
real text, not `title`), not a native tooltip. This is a one-line change from what's proposed
(swap `title="..."` for a `<span class="menu-item-desc">` under the label) — cost stays S.

**What's missing**: nothing else; this is otherwise the most straightforward proposal in the
brief.

## P2 — areas-at-a-glance + L3-picker CSS fix: right diagnosis, one gap in the L0 addition

**What works**: the root-cause trace (`.reader-split`'s deliberate `align-items: stretch`,
`docs/ux-v3.md §1`'s single-scroll design) is exactly right, and splitting "L0 needs content"
from "the picker needs a CSS fix" instead of one shared patch is the correct call — they're
different problems that happen to look the same in a screenshot. The `:has()` fix with a
documented fallback is pragmatic.

**What will fail / risk**: putting a "Walk through →" affordance directly from L0 into a
specific L3 area **skips L1 and L2 entirely**. The app currently teaches level progression
through the level tabs and the `0–3`/`n`/`p` keyboard shortcuts (the audit's own consistency
note praises this). A first-time user (persona c) who clicks straight from L0 into one area's
L3 walkthrough may not understand *why* they're suddenly reading a diff, having skipped the
"what changed structurally" (L2) framing that L3's own area cards assume you've already seen.
This isn't a reason to drop the module, but the brief should address it: either the L0 cards
should land on L2 with that area pre-selected (still a shortcut, but keeps the level model
intact) rather than jumping straight to L3, or the card's language should make clear it's a
level-skipping shortcut ("Skip to code →" reads differently than "Walk through →").

**What's missing**: accessibility of the new cards isn't mentioned. `Reader.tsx`'s existing
`AreaPicker` (the thing P2 says it reuses data from) implements each card as a real `<button>`
with focus/hover/blur handlers — full keyboard support. The brief's cost estimate ("a trimmed
card") should say explicitly that the new L0 cards must follow that same `<button>` pattern,
not the mockup's bare `<li>` (which is fine as a static prototype, but would be a real
regression — another aria-hidden-graph-style gap — if copied into the real component as-is).

## P1 — localize the chrome: correct fix, one cold-load edge case unaddressed

**What works**: the constraint the brief surfaces (App.tsx has no language in scope at all
once you leave Home) is real and I missed it in the audit — good catch, and the fix (a
last-known-language ref, mirroring the existing `mainSearch` pattern) is the right shape and
doesn't touch v2's data flow.

**What will fail**: a "last-known" ref is empty on a cold load. If someone deep-links straight
to `/units` (bookmark, shared link, or the "old-style deep link" path `App.tsx` already special-
cases) *without* having visited Home first in that browser session, the ref has no value to
fall back to, and the chrome renders in the `'en'` default — for a Korean project, that's the
exact "half-migrated" bug this proposal exists to fix, just reachable a different way. The
fix direction should say what the ref initializes to on a cold load of a History page — either
accept English as a known, documented gap for that one entry path, or have `App` fetch the
project's language directly (it already must know which project it's showing, just not its
language) rather than depending on `MainV2` having mounted first.

**What's missing**: the brief doesn't address the History **pages themselves** (`Units.tsx`,
`Timeline`, `Briefing`, `Insights` content, not just the menu chrome). If only the nav label
localizes but everything inside those pages stays English, a Korean-speaking user still hits a
half-migrated page one click later — smaller in scope than Finding 1 (it's after a deliberate
click, not the always-visible header) but worth one sentence in "Not proposed" (§4) saying so
explicitly, the way P3's page-redesign exclusion already is, so nobody mistakes P1 for "History
is now localized."

## P4 — focus visibility verification: right task, wrong assumption about who can run it

**What works**: this is exactly the follow-up the audit asked for, and tracing
`.digest-row-main`'s background-only focus pattern as the one real open question (rather than
re-litigating the whole finding) is the right scope.

**What will fail**: the fix direction's step (1) is "manual, non-headless Tab-through... in a
real browser." This sandbox's browser automation is headless BiDi Firefox — there is no
"real, focused browser window" available inside this environment to run that check (the same
constraint that's already blocked real-provider screenshots this cycle, per
`.cache/dig47-acceptance/README.md`). As written, step (1) has no owner who can actually execute
it without the operator. The brief should say so directly rather than leaving it as a plain
QA task with an implicit assignee.

**I ran step (2) now** — it doesn't need OS focus, just the actual `--hover`/`--selected`/`--bg`
hex values from `styles.css:5-47`, computed with the real WCAG relative-luminance formula
(script, not eyeballing):

| | light | dark |
|---|---|---|
| `--hover` vs `--bg` | **1.10:1** | **1.09:1** |
| `--selected` vs `--bg` | **1.14:1** | **1.31:1** |

All four are far under the 3:1 WCAG 1.4.11 non-text-contrast threshold — this isn't a
borderline case, it's essentially imperceptible. So `styles.css:435`'s
`.digest-row-main:hover, :focus-visible { background: var(--hover); outline: none; }` **fails
confirmed**, in both themes, not just "unconfirmed, worth a check" as the brief has it. This
promotes P4's step (2) from a QA task to a real fix: the digest-picker rows need either their
`outline: none` removed (let the global ring show, like every other focusable element) or a
stronger visual change on focus (a left border or a darker background shift that clears 3:1) —
not a color-only tweak, since `--hover`/`--selected` are shared tokens used elsewhere and
nudging them changes more than this one component.

**What's missing** (step 3, icon-only triggers): I did not get to this — it needs the same
per-element contrast check style as above, applied to the zoom `−`/`+`, `▾`, `ⓘ` triggers'
focus states. Flagging as still open, not done.

## Cross-cutting note (§3, "v2 has zero instrumentation")

Correct and useful to flag before the CTO reads the "measure" answers as commitments. One
addition: this also means **P4's own verification can't be re-checked automatically** later —
there's no telemetry to notice if a future CSS change silently removes a focus ring again. Not
a reason to build instrumentation now, but worth naming as the reason P4 should probably become
a recurring visual-regression check (e.g. a Firefox BiDi screenshot diff on the focused state)
rather than a one-time manual pass, if the team wants this to stay fixed.

## Summary verdict

| Proposal | Verdict |
|---|---|
| P1 | Accept fix direction; needs the cold-load fallback and a one-line scope note on History-page content addressed before build. |
| P2 | Accept both halves; needs the level-skip risk addressed (land on L2, or relabel) and an explicit accessibility requirement on the new cards. |
| P3 | Reject `title` as the mechanism; keep everything else (visible description text instead). |
| P4 | Step (2) is now a confirmed fail (1.09–1.31:1, need 3:1), not just "worth checking" — this needs an actual fix, not a QA pass. Step (1) needs the operator, not an agent, to execute. |
| P5 | Needs one change before it goes to the CTO: granularity should be per-area, not per-digest, in both options. Otherwise ready to present as a two-position question. |
| P6 | Accept the concept; the "See all 3 ↓" CTA in the mockup itself is broken and must point at the digest picker, not an in-page scroll, before this goes to engineering. |

## Handoff

Reassigning to the UX Designer to revise per the DIG-55 loop (accept / change / reject each
point above, max two rounds). The blocking items to resolve before this brief is CTO-ready are
P6's CTA target and P5's granularity — both are one/two-sentence fixes, not redesigns. Everything
else here is either already "accept with a caveat" or, for P4's step (1), an operational note
rather than a design change.
