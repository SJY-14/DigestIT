# UX cycle 1 — verification and summary (DIG-55, step 6)

Verifies Issue A (DIG-60, P1/P3/P4) and Issue B (DIG-61, P2/P6/P5-A) against
`docs/ux/decision-1.md` and `docs/ux/brief-1.md`, on `main` at `2758768` (both merged). Every
proposal holds; nothing is being reopened.

**Method**: built `main` in a dedicated worktree, ran the `stub` provider against a synthetic
`snapback` project (the same demo used in `audit-1.md`/`.cache/dig47-acceptance`), served it on
loopback, and drove it with headless Firefox over WebDriver BiDi at 1440×900 and 1280×800, light
and dark, English and Korean. Two digests were used throughout so P6's "returning visit" and
P5's per-area (not per-digest) marking would actually exercise real state, not a single-digest
edge case. All before/after screenshots referenced below are new, in `docs/ux/screens/`
(prefixed `dig62-`), or the engineer's own `*-after.png` shots already on `main` from DIG-60.

## P1 — localize the top nav — holds

`dig62-dark-ko-header-idle-after.png` (matches the already-committed
`dark-ko-header-idle-after.png` from DIG-60) and every other Korean screenshot below: nav reads
"홈 | 기록", History menu items and descriptions are Korean, breadcrumbs/tabs/buttons follow.
Confirmed the cold-load fallback path exists (`App.tsx` fetches the project's language from the
v2 projects list when a History page is the first page opened) by reading the merged diff; a
live cold-load test needs a page bookmarked straight to `/units` etc., which the stub-project
script doesn't produce — low risk, the code path is a direct, small `fetchProjects` call with the
same shape already covered by `App.test.tsx`.

## P3 — History menu descriptions — holds

`dig62-dark-ko-history-menu-after.png` (English: `light-en-history-open-after.png`, already on
main): "OTHER VIEWS" label, visible `<span>` descriptions under each item in both languages, not
a `title` tooltip — confirmed by reading the rendered DOM, not just the screenshot.

## P4 — focus visibility and contrast — holds, with a testing-loop limitation noted

- Confirmed in the merged diff: `.digest-row-main:focus-visible` no longer sets `outline: none`,
  so it now gets the same global ring as everything else. `grep`ing `styles.css` for
  `outline: none` on main finds nothing else — no new bespoke exception was introduced.
- **Contrast, recomputed from the live page's `getComputedStyle`, not just the source file**:
  `--focus` (`#0969da` light / `#4493f8` dark) against `--bg` is **5.19:1 (light)** and
  **6.11:1 (dark)** — both comfortably clear of the WCAG 1.4.11 3:1 non-text threshold, and against
  `--hover`/`--selected` (both very close to `--bg`) the ring's contrast doesn't meaningfully
  drop. This directly answers the "recheck the contrast numbers" ask: the fix is correct, not
  just "should be."
- **Icon-only triggers** (zoom `−`/`+` = `.graph-zoom`, digest-picker `▾`, info `ⓘ`): none of them
  override the global `:focus-visible` rule, so they inherit the same ring and the same passing
  contrast — no separate fix was needed once P4(a) landed globally.
- **What I could not verify, and why**: I could not get a real `:focus-visible` ring to *render*
  in a screenshot, even using WebDriver BiDi's `input.performActions` to send a trusted Tab
  keypress (not just `element.focus()`). Checked directly: `document.hasFocus()` returns `false`
  for the entire session, always — this headless Firefox's top-level browsing context never gets
  OS window focus at all, so `:focus` (and therefore `:focus-visible`) cannot match on anything,
  regardless of how the focus was set. This sharpens brief-1.md's existing caveat ("may lack OS
  focus") into a confirmed fact rather than a suspicion. To still show what the ring looks like
  when it does render, I temporarily mirrored the app's own `:focus-visible` CSS rules onto
  `:focus` (same selectors, same `var(--focus)` token, nothing invented) and screenshotted those:
  `dig62-light-en-focusring-picker-trigger.png`, `-digest-row.png`, `-graph-zoom.png`. They confirm
  the ring is visible and well clear of both light and dark backgrounds. This is evidence the CSS
  is correct, **not** a substitute for the operator's real Tab-through the decision already calls
  for — that step still stands and should happen once the CTO reads this.

## P2 — areas-in-this-digest + short-view CSS — holds

`dig62-light-en-L0-areas-glance-after.png`: L0's blank space below the headline is now a grid of
real area cards (title, file count, ±stats, "Open area →"), matching the brief's mockup. Clicking
a card (`dig62-light-en-L0-card-lands-on-L2-after.png`) navigates to `?level=2&area=<id>` — L2
with that area selected, confirmed via the URL, not just visually — not straight to L3, exactly
the critique fix the brief records. The cards are real `<button>` elements (checked the DOM, not
assumed from the screenshot), matching `AreaPicker`'s existing pattern as required. The L3-picker
height fix (`data-short-view`) is in place and scoped to L0/no-area-L3 only; `.reader-split`'s
stretch is untouched for L1/L2/L3-walkthrough. Held at 1280×800 too (narrower graph pane, no
overflow or clipping).

## P5 option A — per-area reviewed mark, with undo — holds

Full round-trip verified, not just the "on" state: mark → `dig62-light-en-L3-reviewed-after.png`
(header shows "✓ Reviewed") → badge propagates to the L2 area card
(`dig62-light-en-L2-badge-reviewed-after.png`, a green checkmark + the word "Reviewed", not
color-only) → click again to unmark → badge disappears
(`dig62-light-en-L2-after-undo-after.png`). Confirmed **per-area**: marking one area's L3 view
does not mark the digest's other areas. Confirmed it survives a page reload (real `localStorage`,
not React state) and that a fresh browser profile starts unmarked, matching the documented
per-browser limitation. Korean copy confirmed: "검토됨으로 표시" (Mark as reviewed) /
"검토됨" (Reviewed).

## P6 — welcome-back strip — holds

This needed a scenario the UI's own "click Explain" flow can't produce on its own: Explain
auto-navigates to the new digest and immediately marks it seen, so a same-session second digest
never should show the strip (correctly — that's not a "welcome back," that's still the same
visit). To test the actual target scenario — a digest that arrived while the owner was away — I
created digest 2 with a direct API call instead of through the browser (simulating a background
run), then reloaded the page in the same browser profile. Result:
`dig62-light-en-L0-welcome-back-1440-after.png` — "1 digest since you last looked, just now · 5
files total" with an "Open digest list ▾" CTA that opens the real `DigestPicker` overlay
(`dig62-light-en-welcome-back-cta-opens-picker-after.png`, listing both digests) — the exact
critique fix, not the old scroll-promising button. Confirmed correctly absent on a genuine
first-ever visit (single digest, nothing to compare against) and correctly absent on a fresh
browser profile that never saw digest 1 (`dig62-dark-en-L0-after.png` — dark theme, no strip on
this profile's first load, as expected). Held at 1280×800
(`dig62-light-en-L0-welcome-back-1280-after.png`).

## Tests

`pnpm --filter @digestit/web test` on `main`: 269/269 pass, including the new
`storage.test.ts`, and the DIG-60/61 additions to `App.test.tsx`/`MainV2.test.tsx`/
`Reader.test.tsx`/`Walkthrough.test.tsx`/`copy.test.ts`.

## What we learned about the loop itself

1. **The brief/decision/verify chain worked.** Every fix-direction in `brief-1.md`, including the
   round-1 critique fixes (P6's CTA, P5's per-area+undo, P2's L0→L2 landing), was implemented
   exactly as written and held up under independent re-testing, not just a re-read of the diff.
   Citing exact file:line locations in the brief made verification fast: I could go straight to
   the claimed code instead of re-deriving it.
2. **Headless BiDi cannot verify focus-visible rendering at all, not just "unreliably."**
   `document.hasFocus()` is `false` for the whole session, confirmed directly, not inferred from a
   missing ring in a screenshot. Worth writing into whatever runs this loop next: don't ask the
   Reviewer to "try harder" at a headless focus screenshot — route it to the operator immediately,
   the way this cycle's decision already did. The CSS-mirror technique above is a reasonable
   stand-in for "does this token/rule combination look right," but it is not a substitute for a
   real Tab-through and shouldn't be reported as one.
3. **Testing a "returning visit" feature needs a way to advance state without going through the
   UI the feature is trying to fix.** P6 only shows up for a genuinely stale visit; the natural
   way to create a second digest (click Explain) also marks it seen. Calling the project's
   `POST /api/projects/:id/explain` directly (the same endpoint the button calls, just without the
   browser client) was the only way to produce the actual before-and-after this proposal was
   built for. Future "unread/last-seen" style features in this app will hit the same testing
   shape; worth remembering rather than re-discovering.
4. **The synthetic project needs at least two digests with a few named areas to exercise most of
   this cycle's proposals at once** — `.cache/dig47-acceptance/project.sh base`/`change1`/`change2`
   already provides exactly that; no new fixture was needed.

## Candidates for cycle 2

- **v2 instrumentation** (deferred this cycle, brief §3): still nothing posts a `UiEvent` from the
  v2 reading flow. Until that exists, every "measure" line in brief-1.md (P2/P6 especially) stays
  a screenshot-based pass/fail, not a real usage signal. This is the one prerequisite that unlocks
  the most other measurement work, so it's worth cycle 2's first slot.
- **P5 option B** (server-side reviewed state): revisit once Option A has real usage — the decision
  already names this trigger ("if A gets used and people ask for it across devices").
- **A cross-project "unread" signal**: P6 explicitly scoped this out (brief §2, "Multiple
  projects"). A busy owner running 3+ unattended projects still has to visit each one to find out
  which have unseen digests — the same problem P6 solves, one level up. Needs a projects-list
  landing view this app doesn't have yet, so it's a real cycle's worth of work, not a quick add-on.
- **A real (non-headless) focus-visible check as a repeatable step**, not a one-off operator ask —
  see the testing-loop note above. Even a manual checklist the operator re-runs every cycle would
  catch a future regression that this sandbox structurally cannot.
