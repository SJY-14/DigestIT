# DIG-71 — make step ↔ code line mapping obvious (brief 1)

Built on a direct read of `apps/web/src/Walkthrough.tsx`, `apps/web/src/hunks.ts`, `apps/web/src/diff.ts`,
`apps/web/src/MainV2.tsx`, `apps/web/src/styles.css`, `apps/web/src/copy.ts`, `packages/core/src/v2.ts`
and `packages/explain/src/area.ts` on `main` (the merged L3 walkthrough, DIG-48/50), plus
`docs/ux-v3.md`. Every proposal below cites the line(s) it touches.

## 1. The problem, before the UI

The Board's complaint is specific: given a step, which lines does it cover? Today's L3
(`Walkthrough.tsx`) is not a two-pane diff-with-annotations view — it's **one column, read
top to bottom**: overview, then each step's title + body + its own hunk block(s) rendered
immediately under it (`Walkthrough.tsx:204-218`), a "What to check" list, then any hunks no
step covers. A `>3`-step area also gets a sticky step table of contents
(`Walkthrough.tsx:181-198`) that scrolls the matching `#step-N` section into view on click
(`Walkthrough.tsx:128-131`).

That structure already gets the *coarse* mapping right — a step's code is never far from its
prose, and there's no separate diff a reader has to cross-reference. What it doesn't give a
first-time reader is the *fine* mapping the Board is asking for:

- **No line-range at a glance.** A hunk block's caption is just the path (`Walkthrough.tsx:42`,
  `<figcaption><code>{path}</code></figcaption>`). The exact lines are only visible by scanning
  the old/new gutter columns row by row (`Walkthrough.tsx:23-31`) — that's a read, not a glance,
  and it fails the acceptance test ("say which lines step N covers within 2 seconds") once a
  step has more than a few lines.
- **Multi-hunk steps look ambiguous.** When a step's `hunks` array has more than one entry
  (`packages/core/src/v2.ts:75`), `StepHunks` (`Walkthrough.tsx:64-76`) stacks one
  `HunkBlock` after another with nothing but a repeated path caption. Nothing marks "these two
  blocks are still step 4" versus "the second block is the start of step 5" — the only cue is
  vertical whitespace and heading rhythm, which is not "obvious at a glance," it's inference.
- **The screen-reader announcement is already half-built, and stops short of the ask.**
  `MainV2.tsx` already has a working `aria-live="polite"` region (`MainV2.tsx:748`) that
  announces on `n`/`p` (`MainV2.tsx:614-624`) — but it announces `walkthroughCopy(lang).stepOf(n,
  total)` only, i.e. **"Step 2 of 6"**, never the file/line part the issue's acceptance line
  asks for verbatim. And it's wired only to the keyboard path: clicking a step-TOC item
  (`Walkthrough.tsx:190`, `onClick={() => onStep(i + 1)}`) calls the raw `onStep` prop directly,
  bypassing `setAnnounce` entirely — a mouse-driven TOC click currently announces nothing.
- **Focus doesn't move with the step.** Both paths (`n`/`p` and the TOC) call
  `document.getElementById('step-${step}').scrollIntoView` (`Walkthrough.tsx:128-131`) but never
  move DOM focus. A sighted mouse user's eye follows the scroll; a keyboard/screen-reader user's
  focus stays on the button they pressed, so they hear "Step 2 of 6" (once fixed) but have to
  hunt for where that content actually is.

## 2. What this means for scope

Given the above, DIG-71's four bullets translate differently than "build a second diff pane":

| Issue bullet | Where it lands here |
|---|---|
| Numbered gutter markers | Adapted: a step-number badge on each hunk block (§3 P2), not a persistent full-diff gutter — there is no persistent full diff once a walkthrough exists, by design (§4). |
| Explicit range label | Direct fit: §3 P1. |
| Linked scrolling | **Already built** (TOC → `scrollIntoView`, `n`/`p` → step change) — needs the announcement/focus fix (§3 P3), not a new pane. |
| Multi-hunk "N of M ranges" | Direct fit: folded into §3 P1's range label. |
| Anchors (file/side/start/end) in the data model | **No schema change needed** — derivable client-side from data already shipped (§5). |

## 3. Proposals

### P1 — Range label + position, on every hunk block [S]

**Problem.** `Walkthrough.tsx:42`'s figcaption shows only the path. No line range, no
indication of how many hunks this step has or which one you're looking at.

**Fix direction.** Extend the figcaption to a two-part header:
`(2) upload.js · lines 12–14` on the left, `1 of 2 ranges` on the right (omit the right part
when a step has exactly one hunk — most steps do, per `packages/explain/src/area.ts`'s
one-mechanical-step norm, and a "1 of 1" label is noise). `(2)` is the step-number badge, shared
with P2 below — same element, not a second number to parse.

Side rule, matching the issue's own wording ("new-side numbers; old-side for deletions"): a hunk
with no added lines (`newCount` conceptually 0 — see §5) shows old-side numbers, every other
hunk shows new-side numbers. Single-line ranges read as `line 41`, not `lines 41–41`.

**Mockup.** See `docs/ux/proto/dig71-step-ranges.html` and the ASCII sketch in §7.

**Expected effect.** Closes the literal 2-second test: the range is printed, not inferred from
gutter numbers.

**Cost.** S — one derived value per hunk block (§5), one copy string, a few lines of JSX/CSS in
`HunkBlock` (`Walkthrough.tsx:35-60`).

### P2 — Step-number badge on the hunk block itself [S]

**Problem.** A hunk block's only tie back to its step is physical nesting under that step's
`<h3>` (`Walkthrough.tsx:211-214`). If the step's body is long, or the block itself is long
(`FOLD_THRESHOLD`, `Walkthrough.tsx:12`), the heading can scroll out of view while the code is
still on screen — at that point the block has zero self-identifying "which step" marker. This is
the concrete version of "gutter step markers": since there's no persistent multi-step diff pane
(§4), the marker belongs on the block itself rather than in a shared gutter.

**Fix direction.** A small numbered badge, reused from P1's `(2)`, styled as a circle: **filled**
(solid accent fill, white numeral) when this block belongs to the step currently selected via
`n`/`p`/TOC/`?step=`, **outlined** (accent ring, accent numeral, transparent fill) otherwise.
Filled-vs-outline is a shape difference, not a hue difference, so it survives grayscale/color-
blindness — the issue's "not color-only" requirement. Steps not currently selected are not
dimmed or hidden (never hide the evidence); the badge is the only differentiator, and it's
subtle by design — most of the time no step is "selected" (`step === null`, the default reading
state, `Walkthrough.tsx:99`), so every badge renders outlined and the page reads exactly as it
does today.

**Cost.** S — one CSS class pair (`.step-badge`, `.step-badge.current`), computed from the same
`step === i + 1` comparison `Walkthrough.tsx:208` already makes for `.step.current`.

### P3 — Announce the range, and move focus predictably [S]

**Problem.** Per §1: the existing `aria-live` announcement (`MainV2.tsx:614-624`, `748`) says
"Step 2 of 6" and only fires on `n`/`p`; the TOC path (`Walkthrough.tsx:190`) announces nothing;
neither path moves focus.

**Fix direction.** Move the announcement into `WalkthroughView` itself, keyed off the `step`
prop with a `useEffect` (next to the existing scroll effect, `Walkthrough.tsx:128-131`), so it
fires the same way regardless of *how* `step` changed — `n`/`p`, a TOC click, or a reload with
`?step=`. Compute the string from the step's ranges (§5): `"Step 2 of 6, upload.js lines 12–14"`
for a single range, `"Step 2 of 6, upload.js lines 12–14 and 1 more"` for multi-hunk steps
(reading out every range would be long for a `>2`-hunk step; "and N more" is enough for orientation,
full detail is on-screen via P1). This makes `MainV2.tsx`'s own `n`/`p`-only announce call for
this case redundant — recommend removing it there (`MainV2.tsx:622-623`) once `WalkthroughView`
owns it, so there's one source of truth, not two announcements racing on every keypress.

For focus: after the scroll in the existing effect, move focus to the step heading
(`document.getElementById('step-${step}-title')`, which needs `tabIndex={-1}` added,
`Walkthrough.tsx:211`) — the same "focus follows navigation" pattern already implied by
`scrollIntoView`, just completed for keyboard/AT users. This is a deliberate "jump to X" action
(`n`/`p`/TOC/breadcrumb), the case where moving focus programmatically is expected, not
surprising.

**Cost.** S — one more `useEffect` dependency, one `tabIndex` attribute, string composition
reusing P1's range formatter. Deleting the now-redundant call in `MainV2.tsx` is a one-line
removal.

## 4. Explicitly deferred: a persistent two-pane "scrollytelling" diff

The issue's third bullet asks for steps on one side, a full diff on the other, scrolling in
sync. I'm not proposing it for v1, and naming why rather than silently dropping it:

- **It doesn't fix a gap that's still open.** Once P1–P3 land, "which lines does step N cover"
  is answered in place, at the step, without a second pane to cross-reference.
- **It conflicts with a stated principle.** `docs/ux-v3.md §1`: "the reading pane is the only
  long scroll." A second pane holding the *entire* area's diff (potentially several files, many
  hunks the current step doesn't touch) needs its own scroll position and its own sync logic
  against the reading pane — exactly the second long scroll that document rules out.
- **It's real cost for a case the current model already handles differently, and arguably
  better for this product's two audiences.** Long Korean prose (`docs/ux-v3.md §3`) next to a
  cramped code pane is a worse read than full-width inline code under full-width prose. Building
  and maintaining scroll-sync (what happens on manual diff-pane scroll — does it fight the
  reading pane, per `docs/ux-v3.md`'s own "no half-finished implementations" bar) is an **L**
  cost for a problem P1–P3 already close at **S**.

Recommend the CTO close this bullet as "met by the existing inline model plus P1–P3," not as
"rejected outright" — if a future need shows up (e.g. comparing two non-adjacent steps' code
side by side), it's a separate, better-scoped ask than "make the mapping obvious."

One gap worth naming honestly: a `≤3`-step area has no TOC at all (`Walkthrough.tsx:180-198`
gates it on `steps.length > 3`), so it has no "steps on one side" affordance today. Given most
areas are short (the walkthrough step cap exists precisely to keep areas skimmable), I'd leave
this as-is rather than adding a TOC for 2-3 items — but flagging it for the Reviewer to weigh in
on, since the issue's wording implies every area, not just long ones.

## 5. Data: derive anchors, don't extend the schema

The issue asks for steps to "carry exact anchors (file, side, start, end)... extend the schema
and validator if needed." They don't need to — the data to compute every anchor is already
shipped, and computing it client-side (or once, server-side, at read time — either works; see
cost note) avoids adding a field the model could get wrong.

- `WalkthroughStep.hunks` is `HunkRef[]` (`packages/core/src/v2.ts:64-67`, `{path, hunk}`),
  already validated against the real patch's hunk count by `checkAreaWalkthrough`
  (`packages/explain/src/area.ts:137-209`) — a hunk reference that doesn't resolve to a real hunk
  is a rejected/repaired violation today, not a possible bad anchor tomorrow.
- The web already turns `{path, hunk}` + `AreaDetailDto.files[].patch` into a fully-numbered
  `PatchHunk` (`apps/web/src/hunks.ts:10-60`, `splitPatch`) with every line's `oldNo`/`newNo`
  already computed (`apps/web/src/diff.ts:11-18`). The range is just the min/max of those
  numbers on whichever side has additions, or the old side when it doesn't:

  ```ts
  // apps/web/src/hunks.ts — pure, no new imports
  export interface HunkRange { side: 'old' | 'new'; start: number; end: number }
  export function hunkRange(h: PatchHunk): HunkRange {
    const news = h.lines.map((l) => l.newNo).filter((n): n is number => n !== null);
    if (news.length > 0) return { side: 'new', start: h.newStart, end: news[news.length - 1]! };
    const olds = h.lines.map((l) => l.oldNo).filter((n): n is number => n !== null);
    return { side: 'old', start: h.oldStart, end: olds[olds.length - 1] ?? h.oldStart };
  }
  ```

- **No overlap validation needed.** Two hunks of one file's unified diff cannot describe
  overlapping line ranges by construction (each `@@` header starts strictly after the previous
  hunk's end); `checkAreaWalkthrough` already de-duplicates repeated `{path, hunk}` references
  within one step (`area.ts:180-183`, the `seen` set). The issue's "no overlapping ranges within
  a step" constraint is therefore already structurally satisfied — worth one small test in
  `hunks.test.ts` asserting it (documents the invariant, catches a future regression if the hunk
  walker ever changes), not a new validator rule.
- **Korean range copy needs a native check**, same caveat `docs/ux-v3.md §3` already states for
  every other generated/UI string — draft below is my best guess, not a native-speaker sign-off.

## 6. Accessibility checklist

- Numbers are shape-coded (filled vs. outline badge, P2), not color-only.
- Screen readers hear the same content a sighted reader sees: step position **and** file/range
  (P3), on every path that changes the step (keyboard, TOC, URL).
- Focus moves to the step heading on every "jump to step N" action (P3); nothing steals focus
  during ordinary scroll-reading (`step === null`, the default state).
- Fold/"Show all" (`Walkthrough.tsx:53-56`) is unaffected — the range label reflects the full
  hunk regardless of fold state, so collapsing a long hunk never hides or changes its stated
  range.
- Contrast: badge fill uses `--accent-solid` / white numeral (already the button-fill pairing
  used elsewhere, `styles.css:13`), so no new contrast case to check.

## 7. Mockup

`docs/ux/proto/dig71-step-ranges.html` — before/after, light and dark, reusing `styles.css`'s
real token values (hand-copied, not imported). ASCII summary of the "after" state for a step
with two hunks in two files:

```
 ⬤ 2  Add retry to the upload loop                    ← filled badge: this is the selected step
 Retries a failed PUT up to --retries times with backoff; other errors still stop the run.

 ┌────────────────────────────────────────────────────────────┐
 │ (2) upload.js · lines 12–14                    1 of 2 ranges│
 │ @@ -10,6 +10,14 @@                                          │
 │  10  10                                                     │
 │  11  11  function upload(file) {                            │
 │      12 +   for (let i = 0; i <= retries; i++) {            │
 │  12  13       const res = put(file);                        │
 │      14 +     if (res.ok || i === retries) return res;      │
 │  13  15  }                                                   │
 └────────────────────────────────────────────────────────────┘
 ┌────────────────────────────────────────────────────────────┐
 │ (2) cli.js · line 41                           2 of 2 ranges│
 │ @@ -40,3 +40,4 @@                                            │
 │  40  40  program.option('--folder <path>');                 │
 │      41 + program.option('--retries <n>', 'retry count', 3);│
 └────────────────────────────────────────────────────────────┘

  ○ 3  Handle the config file                          ← outline badge: not selected
```

(Visually hidden, on entering step 2:) `aria-live="polite"`: **"Step 2 of 6, upload.js lines
12–14 and 1 more."**

## 8. Measure

`docs/ux/brief-1.md §3` already established that v2 posts no UI events at all — that's still
true (`MainV2.tsx`/`Walkthrough.tsx` call `postUiEvent` nowhere for reading actions), so there is
no live metric to point at. The issue's own acceptance line is the measure: a moderated check —
show a first-time reader a step, start a stopwatch, ask "which lines does this step cover," stop
on their answer. Target from the issue: under 2 seconds, en and ko, light and dark. Not proposing
new instrumentation for this alone; it's a one-time acceptance check, not an ongoing signal.

## 9. Cost summary

| # | Proposal | Cost |
|---|---|---|
| P1 | Range label + position on hunk blocks | S |
| P2 | Step-number badge on hunk blocks (filled/outline) | S |
| P3 | Fix the announcement + move focus on step change | S |
| — | Deferred: two-pane scrollytelling diff | not proposed (§4) |
| — | Data: `hunkRange()` helper + one invariant test | S (no schema/validator change) |

Everything proposed is **S** and client-only (`apps/web/src`); nothing here touches
`packages/core`, `packages/explain`, or the stored `AreaWalkthrough` shape.

## 10. Handoff

Assigning to the UX Reviewer for critique — in particular: whether the P2 badge treatment
actually reads as "which step" at a glance versus adding visual noise to every hunk block, and
whether deferring the two-pane layout (§4) is the right call or worth a second opinion before it
reaches the CTO.
