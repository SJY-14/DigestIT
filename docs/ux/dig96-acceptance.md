# DIG-96 acceptance review: L3 step snippets + line callouts (real provider)

Reviewed: operator real-provider run `.cache/dig96-acceptance/shots-claude-code/`, snapback `change1`
(6 files: new `retry.js`, edits to `config.js`, `upload.js`, `cli.js`, tests, `README.md`), against
`docs/l3-step-snippets.md` on `main` and the acceptance criteria in its §5.

**Verdict: FAIL — cannot confirm.** The capture only ever exercises one trivial area
(`README.md`, 2 small single-line/3-line steps). The scenario the Board actually flagged in
DIG-96 — a large multi-hunk area, specifically the new 40+-line file and a 2+-hunk edited file —
was never captured, so items 1–3 of the review checklist can't be judged for the case that matters.
What *is* visible for the one captured area looks correct and matches the spec.

## Blocker — acceptance run never reaches the area DIG-96 is about

All three `*-area1/2/3-*` outputs in every theme/language are the same walkthrough
(`README documents --retries and failure handling`), not three different areas:

- `light-en-area1-steps.md`, `-area2-steps.md`, `-area3-steps.md` are byte-identical except for
  the harness-inserted heading (`# light-en area1` vs `area2` vs `area3`); same for `light-ko-*`
  and the dark variants. `light-en-area2-full-diff.png` and `light-en-area3-full-diff.png` are
  pixel-identical to `light-en-area1-full-diff.png` (md5 `92aaff84…` for all three).
- `light-en-area2-L3.png` and `light-en-area3-L3.png` show "Step 2 of 2" already expanded — the
  scroll/step state left over from area1's capture — instead of a fresh area's overview. The graph
  panel in every one of these shots still shows only the `README.md` node circled as the selected
  area; `retry.js`, `config.js`, `upload.js`, `cli.js` (the actual multi-hunk code change) never
  appear as the selected area in any screenshot.
- `explain-calls.log` only ever records `walkthrough:project-root` calls — no
  `walkthrough:src` or `walkthrough:test`, even though `light-en-l3.log` claims `areas 3`.

Root cause (read `apps/web/src/Reader.tsx` `AreaPicker` + `MainV2.tsx`): `.area-pick` buttons
only exist on the no-area-selected L3 screen (`AreaPicker`, `apps/web/src/Reader.tsx:451-490`).
Clicking one calls `onOpenArea` (`apps/web/src/MainV2.tsx:715`), which sets `url.area` and
navigates into that area's walkthrough — at which point `.area-picker` unmounts. `drive.mjs`'s
`l3` phase (`.cache/dig96-acceptance/drive.mjs:192-200`) queries `.area-pick` once, then loops
`n = 1..areas` re-querying `document.querySelectorAll('.area-pick')[n-1]` and clicking it. After
the first click the list is gone, so `[1]` and `[2]` resolve to `undefined` and
`?.click()` is a silent no-op — the script just re-captures whatever area is still open. This also
explains why `light-en-l3.log` logs the area name as blank for every area (`area1 `, `area2 `,
`area3 `): by the time it reads `.innerText`, the picker has already unmounted.

This is a test-harness bug in `drive.mjs`, not a demonstrated product regression — but it means
**this acceptance run produced zero evidence for the multi-hunk/new-file scenario required by
spec §5.** Fix: after `captureArea(n)`, navigate back to the no-area L3 view before clicking the
next `.area-pick` (e.g. re-`go()` to the digest URL with no `area` param, or drive it through the
L2 area cards / graph nodes instead of a stale NodeList), then re-run `accept.sh` so `src` (new
`retry.js` + multi-hunk `config.js`/`upload.js`/`cli.js`) and `test` actually get captured. Until
that re-run exists, DIG-96 cannot be signed off.

## Minor — en/ko structure mismatch on the one area we do have

Spec §3: "Same structure for `en` and `ko`; only the text language differs." For the README
area's step 2, the line range differs between languages:

- en: `README.md · lines 7–9`, 3 changed lines (`light-en-area1-steps.md`, confirmed by
  `light-en-l3.log`: "step-2: 1 snippet(s), **3 changed lines**, 3 callouts").
- ko: `README.md · 6–9번째 줄`, 4 changed lines — includes line 6, a blank added line with no
  callout (`light-ko-area1-steps.md`, confirmed by `dark-ko-l3.log`: "step-2: 1 snippet(s),
  **4 changed lines**, 3 callouts"). Screenshot: `dark-ko-area1-step2.png` vs
  `dark-en-area1-step2.png`.

Not a validator violation (range is valid, non-overlapping, callouts still correct), and it
doesn't hurt readability — but it's a real, reproducible deviation from "same structure,
text differs." Worth a prompt-side nudge (e.g. "don't include a blank line solely for padding")
if it shows up again on the re-run.

## What passes, for the one area actually captured (`README.md`, en+ko, light+dark)

Checked against `*-steps.md` + the step/L3/full-diff/tall screenshots:

1. **Sentence → line.** Every sentence in both steps points at a specific line:
   - Step 1 ("usage line gains `[--retries 3]`…", "Before, the line listed only the folder…") →
     both sentences resolve to line 5 (old/new), shown in `light-en-area1-step1.png`.
   - Step 2's three sentences (retryable errors/`--retries` limit, other errors not retried,
     failure list + exit status 1) resolve to lines 7, 8, 9 respectively, each with its own
     callout (`light-en-area1-step2.png`). No sentence is unaccounted for.
2. **Own lines only.** Step 1 owns line 5, step 2 owns lines 7–9; no overlap. Confirmed by
   `light-en-l3.log` / `dark-en-l3.log`: "no changed line under two steps (dupes 0)" in all
   theme/lang combinations observed.
3. **Callouts.** All four callouts ("optional flag shown with default 3", "retryable errors and
   `--retries` limit", "other errors are not retried", "failures listed, exit status 1") are short,
   attached to the correct line, and phrased as "this line does X." Korean callouts
   (e.g. "선택 인자로 표기한 --retries", "기본값 3, 지수 백오프") are equally short and natural, well under
   the 25-character budget. Legible in both themes — amber gutter marker + note reads cleanly on
   both the light and dark backgrounds (`dark-en-area1-step2.png`, `light-ko-area1-step1.png`).
4. **Full diff once.** Appears once per area, collapsed by default (`light-en-l3.log`: "exactly
   one full-diff section" / "full diff collapsed by default"), with step badges `1`/`2`/`2`/`2` in
   the gutter (`light-en-area1-tall.png`). No mechanical step exists in this area (nothing to
   rename/reformat in a 2-line README diff), so "mechanical step is last and collapsed" is
   vacuously true here — **not actually exercised**, since the mechanical case lives in the `src`
   area we never captured (see Blocker).
5. **en vs ko structure.** Same otherwise — step count, step order, step titles' intent, and
   callout count per step all match. The one line-range difference is called out above.

## Recommendation

1. Fix `drive.mjs`'s `l3` phase so each area is captured from a fresh area-picker state (don't
   reuse a stale `.area-pick` NodeList across areas).
2. Re-run `accept.sh` on the host and re-review the `src` area (new `retry.js`, multi-hunk
   `config.js`/`upload.js`/`cli.js`) and `test` area — that's the scenario DIG-96 and spec §5 are
   actually about, and this run has no evidence for it either way.
3. Keep an eye on the en/ko range-boundary difference above; not blocking, but fix if it recurs.

Reassigning to the CTO with this verdict; recommend bouncing back to whoever owns the acceptance
kit (`drive.mjs`) for the harness fix and a re-run before DIG-96 is closed.
