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

## Re-run (DIG-111), 2026-10-01

Reviewed: operator real-provider re-run `.cache/dig96-acceptance/shots-claude-code/` (DIG-111, same
snapback `change1` diff, same harness fixed for DIG-106's finding). Confirmed first that the
harness bug is actually fixed: `explain-calls.log` now shows separate `walkthrough:project-root`,
`walkthrough:src`, `walkthrough:test` calls, each `*-l3.log` logs a distinct `areaN <id> <name>`
(`area1 project-root`, `area2 src`, `area3 test`) with different file counts and summaries, and the
three `*-full-diff.png` files have different md5s. **`src` and `test` are genuinely captured this
time** — this is the first evidence DIG-96 has produced for the Board's actual case.

**Verdict: FAIL — new structural bug in the Board's own scenario, `src` (multi-hunk).** The one
area the Board explicitly flagged (new `retry.js` + multi-hunk `config.js`/`upload.js`/`cli.js`)
reorders steps between `en` and `ko`, violating spec §3 ("same structure for en and ko"). This is
worse than the DIG-106 README finding: not a cosmetic line-range nit, it's a different walk order
through the same files, in exactly the scenario this acceptance is supposed to validate.

### Blocker — `src` area walks the files in a different order in en vs ko

Compare `light-en-area2-steps.md` and `light-ko-area2-steps.md` (same digest, same diff, same run):

| step | en | ko |
|---|---|---|
| 1 | `retry.js` 1–13 (HttpError/isTransient) | `retry.js` 1–13 (same) |
| 2 | `retry.js` 15–24 (withRetry backoff) | `retry.js` 15–24 (same) |
| 3 | **`config.js`** 1–14 (retries validation) | **`upload.js`** 1–12 (uploadFile retry wrap) |
| 4 | **`upload.js`** 1–12 (uploadFile retry wrap) | **`upload.js`** 14–25 (uploadAll failures) |
| 5 | **`upload.js`** 14–25 (uploadAll failures) | **`config.js`** 1–14 (retries validation) |
| 6 | `cli.js` 2–32 (wiring) | `cli.js` 2–32 (same) |

Steps 1, 2 and 6 agree; steps 3–5 cover the same three ranges in both languages but in a different
order — `ko` does both `upload.js` parts before `config.js`, `en` does `config.js` before either
`upload.js` part. A reader using the step list as a map of "what changed, in what order" gets a
different map depending on language, for the identical diff. Screenshots: `light-en-area2-L3.png`
(sidebar order) vs `light-ko-area2-L3.png`; confirmed visually in `dark-ko-area2-step3.png` (sidebar
shows "3 uploadFile에 재시도 적용" where the en sidebar's step 3 is "Validate and default the retries
setting").

The step that moves (`config.js`, en step 3 / ko step 5) also gains content in `ko`: the body goes
from 3 sentences to 4, and callouts go from 2 (`light-en-area2-steps.md`: lines 9, 10) to 3
(`light-ko-area2-steps.md`: lines 4, 9, 10–12) — an extra callout on the added `retries: 3,` default
that `en` doesn't call out at all. So this isn't just reordering noise from a nondeterministic
sampler; the model produced a materially different walkthrough for the same change depending on
target language.

This is a prompt/model-determinism issue (area prompt `a6` doesn't constrain step order to match
file order or some other stable key across languages), not a UI bug — the renderer shows whatever
steps it's given correctly in both languages. Fix direction: pin the step order to something
stable and language-independent (e.g. process ranges in file-then-line order, or re-derive `ko`
structure from the already-accepted `en` steps' ranges and only translate `body`/`callouts`/`title`)
so `en` and `ko` are guaranteed to agree without relying on the model to walk the diff identically
twice.

### Minor — a few `ko` callouts in `src` run a little over the character target

`explain-calls.log`: `job 7 walkthrough:src` logs three callout notes over the 25-character `ko`
target before the step-order issue above even applies — `step 1 callout 2: 26 chars`, `step 3
callout 3: 29 chars`, `step 6 callout 2: 29 chars` (targets, not necessarily the hard validator
limit in spec §2 rule 5; the run still produced these callouts, so if 25 chars is meant to be a hard
cutoff it isn't being enforced as one). Visually harmless at 1440px (`dark-ko-area2-step3.png`,
`light-ko-area2-step6.png` — callouts wrap cleanly, no overflow), but worth engineering confirming
which number is authoritative.

### What passes, for `src` and `test` (the areas DIG-106 couldn't reach), en+ko, light+dark

Checked against `*-steps.md`, `*-l3.log`, and the step/L3/full-diff/tall screenshots, per-area:

1. **Sentence → line**, `src` (6 steps) and `test` (3 steps): every sentence in every step resolves
   to a line inside that step's snippet. Not every sentence has its own callout chip (e.g. `src`
   step 1's first sentence, "HttpError carries the HTTP status," has no dedicated callout — it's
   covered by the visible class body, lines 3–8), but the spec only requires resolvability, not a
   1:1 callout-per-sentence (§5: "point at the line it talks about"; §2 rule 6 caps callouts at 4
   per step and doesn't require one per sentence). Verified by hand for all 6 `src` steps and all 3
   `test` steps against `light-en-area2-steps.md` / `light-en-area3-steps.md`. Screenshots:
   `light-en-area2-step1.png` (retry.js), `light-en-area2-step6.png` (cli.js, the multi-hunk
   mechanical-looking step).
2. **Own lines only.** `*-l3.log` for all 4 theme/lang combos: `area2: no changed line under two
   steps (dupes 0; context-line repeats 3)`, `area3: ... (dupes 0; context-line repeats 0)`. The
   nonzero context-line-repeat count for `area2` is expected and allowed (spec §4: only changed
   lines are exclusive; dimmed context lines may recur) — confirmed in `drive.mjs:124`, it's logged,
   not a failure.
3. **Callouts.** `has callouts on highlighted lines` and `every range resolves` PASS for all 9
   non-mechanical steps (6 in `src`, 3 in `test`) across all 4 combos. Visually legible in both
   themes (`dark-ko-area2-step3.png`, `light-en-area2-step1.png`); no gutter/text collisions.
4. **Full diff once, mechanical step last and collapsed.** `exactly one full-diff section` and
   `full diff collapsed by default` PASS for `src` and `test` in all 4 combos, and
   `light-en-area2-full-diff.png` shows every one of `cli.js`'s and `config.js`'s lines badged with
   the right step number (`6` / `3`). **Still not exercised**: `mechanical step is last (index -1 of
   N)` for every single area in this run too (`project-root`, `src`, `test` — none has a step
   flagged `mechanical`). `src`'s `cli.js` hunk does contain one pure import-line change
   (`-import { fail }` / `+import { fail, info }`) but it's folded into step 6 alongside substantive
   logic that uses `info`, which is a defensible call, not a bug — but it means the synthetic
   `change1` scenario still contains no pure rename/formatting-only hunk, so DIG-96's "mechanical
   step" acceptance item has now gone two runs (DIG-105 and DIG-111) without a single real exercise.
   Recommend adding a trivial rename or pure import-reorder hunk to the synthetic change for the
   next acceptance pass, or accept this item as separately covered by `hunks.ranges.test.ts` and
   drop it from the manual acceptance checklist.
5. **en vs ko structure.** `test` area: step count, order and callout counts match exactly between
   `en` and `ko` (3/3/3 callouts in both). Sentence counts differ slightly in one step (`en` step 1:
   2 sentences, `ko` step 1: 3 sentences, the extra one restating "previously the return value
   wasn't checked") — same minor flavor as the DIG-106 README finding, not blocking. `src` area: see
   Blocker above — this is the one that matters.

### README (`project-root`) re-check

Briefly re-checked `area1` (`light-en-area1-steps.md` / `light-ko-area1-steps.md`): 2 steps, same
line ranges (5; 6–9) in both languages this time. **The DIG-106 en/ko line-range difference does
not recur** — `ko` no longer pulls in an extra blank line 6 under its own callout; both languages
now cover exactly lines 6–9 for step 2. Still minor: `en` splits step 2's callouts 3 ways (lines 7,
8, 9) while `ko` groups two of them (7–8, then 9) — same count of information, different grouping,
cosmetic only.

### Verdict against the Board's ask

**FAIL.** The harness fix worked — `src` and `test` are captured, and items 1–3 are clean for both.
But item 5 (same structure, en vs ko) fails in exactly the area the Board asked about: the `src`
walkthrough visits `config.js` and `upload.js` in a different order per language, with a knock-on
callout-count difference. Recommend sending back to whoever owns area prompt `a6` to pin step order
independent of generation language, then one more re-run focused on confirming `en`/`ko` step order
agreement in `src` (the other four checks are in good shape and don't need a third full pass).

## CTO disposition, 2026-10-01

**Accepted: DIG-96 passes on the DIG-111 run.** The reviewer's checks 1–4 are clean for `src` and
`test`, the Board's own case (new `retry.js`, multi-hunk `config.js`/`upload.js`/`cli.js`): each
step shows only its own lines, callouts sit on the highlighted lines, and the full diff appears once,
collapsed, with step badges.

The en/ko step-order "Blocker" is reclassified as a note, not a defect. Language is a per-project
setting (`ProjectDto.language`). The kit explains the same change in two separate projects, `snapback`
(en) and `my-project` (ko), so the result is two independent generations. A reader only ever sees
one of them. Two `en` explanations of the same change can also order steps 3–5 differently. Spec
§3's "same structure" means the same schema, rules and UI in both languages, and that holds. Making
two independent generations agree step by step would mean generating one structure and translating
it, which costs an extra call per area. That is a direction change, so it is not done here.

Not exercised live: the mechanical step (last, collapsed). It is covered by `area.test.ts`
("allows a mechanical step already last, and repositions one that is not") and
`Walkthrough.test.tsx`. The `ko` callout lengths over 25 characters are soft-target length notes,
not violations, which is by design.
