# L3 step snippets and line callouts (DIG-96)

Board feedback (2026-09-30): "Explain code" still shows the whole diff again under every step.
Steps reference whole hunks (`WalkthroughStep.hunks`), and a new or heavily edited file is often
one hunk, so every step that touches it repeats all of it. The Board wants each step to point at
its own code ("this part does X") and the full diff shown once.

This replaces the hunk-level step anchors of DIG-48/DIG-71 with exact line ranges and
line-anchored callouts. Contract: `LineRange` and `StepCallout` in `packages/core/src/v2.ts`, and
`rangeSpan`, `spansOverlap`, `spanContains`, `changedCount` and `spanContext` in
`packages/core/src/hunks.ts` (tests: `hunks.ranges.test.ts`). The validator and the UI must both
cut the patch with these helpers, never with their own copy.

## 1. Data

```ts
interface WalkthroughStep {
  title: string;
  body: string;            // the why: 2–4 sentences, as today
  ranges: LineRange[];     // ≥ 1, reading order; {path, side, start, end}, one hunk each
  callouts: StepCallout[]; // LineRange + note; each inside one of this step's ranges
  mechanical: boolean;     // at most one step, always the last
}
```

- Line numbers are the prompt's own `N+` / `N ` (new side) and `N-` (old side) prefixes, so the
  model copies numbers it can see instead of counting.
- `rangeSpan(walkPatch(patch), side, start, end)` gives the patch lines a range covers: from the
  first to the last matched line, with the other side's lines in between. A `new` range that starts
  on an added line also takes the deleted lines right before it (the removed half of a
  replacement). A range may not cross hunks.
- `hunks` is dropped from the step. The server reads only rows of the current
  `AREA_PROMPT_VERSION`, so after the bump to `a6` older walkthroughs show as not generated
  ("Generate" again, one call per area).

## 2. Validator rules (`checkAreaWalkthrough`, area prompt `a6`)

Hard violations, each with a message that tells the model how to fix it on the retry:

1. A range is malformed, names a file not in the area, has no lines (`no-lines`), or crosses hunks
   ("split it into one range per hunk").
2. Two ranges overlap (`spansOverlap`), within one step or across steps. Name both steps and the
   lines.
3. A range covers every changed line of a file with more than 30 changed lines, or a single range
   has more than 40 changed lines (`changedCount`): "split it at the step boundaries".
4. A callout is not inside one of its own step's ranges (`spanContains`), or two callouts of a
   step overlap.
5. A callout note is longer than 12 words (en) or 25 characters (ko), or empty.
6. A non-mechanical step has no callout, or more than 4.
7. More than one mechanical step, or a mechanical step that is not last.

Coverage: every hunk the prompt showed must be touched by at least one range. A hunk no range
touches is a violation and is repaired into the generated "Other changes" step (its changed lines
as one range per hunk; those ranges are exempt from rule 3). Changed lines inside a touched hunk but
outside every range are allowed; the full diff shows them without a step badge.

Repairs on the kept result: drop bad ranges and callouts, drop a step left with no range, and
move a mechanical step to the end. Keep the rules in `LIMITS` and state the same numbers in the
prompt, counted the same way (see DIG-94: a limit the prompt does not state costs a retry).

## 3. Prompt (area prompt `a6`)

- Walk the change in logical order. Each step is one idea over one small range (a few to ~20
  changed lines); a large new file is several steps, one per part.
- `ranges`: copy the line numbers from the `N+`/`N-` prefixes; one range per hunk; never give the
  same line to two steps.
- `callouts`: 1–4 per step, like review comments on specific lines: "this line/part does X"
  (e.g. "retryable status codes", "backoff doubles each attempt", "gives up after `retries`").
  The body explains why; the callouts say which line does what. Every sentence of the body should
  point at lines that a callout or the range makes visible.
- Renames, import changes and formatting go into one final step with `mechanical: true`.
- Same structure for `en` and `ko`; only the text language differs.

## 4. UI (`Walkthrough.tsx`)

- Under each step's body: for each range, a snippet of exactly that span (`rangeSpan`), with up to
  3 dimmed unchanged lines above and below (`spanContext`), captioned `path · lines a–b` with the
  step badge. No step shows a line that another step shows (the validator guarantees this for
  changed lines; context lines stop at the first changed line).
- Callouts sit on their lines like review comments: the anchored lines get a marker in the gutter
  and a highlight, and the note sits next to or right under the last anchored line
  ("← backoff doubles each attempt"). A note stays readable at the narrow reading-pane width and
  in both themes, and is announced with its line numbers to screen readers.
- One "View full diff" toggle per area (collapsed by default) shows every hunk once, with the
  step number in the gutter of each line that a step's range covers. Clicking a badge goes to
  that step. The full diff is not repeated inside the steps.
- The mechanical step is last and collapsed by default (title and body visible, snippets behind a
  disclosure).
- Before a walkthrough exists (or while it streams) the full diff is shown as today. Streamed
  steps render with their ranges as soon as each step arrives.
- `walkthroughOf` treats a walkthrough whose steps lack `ranges` as no walkthrough, so an old
  shape can never render whole hunks per step.

## 5. Acceptance

Operator real-provider run, en + ko, light + dark, on a multi-hunk change of 60+ changed lines
(one new file of 40+ lines and one edited file with 2+ hunks): every step has a different small
snippet, callouts attach to lines, no hunk or line appears under two steps, and the full diff is
available once. The UX Reviewer checks, for each sentence of each step, that they can point at the
line it talks about.
