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
  ("Generate" again, one call per area). Since DIG-125 it reads the newest row among
  `AREA_STORED_VERSIONS` (every version from `a6` on, which all store this shape), current prompt
  first, so a prompt bump that keeps the stored shape no longer hides walkthroughs already made.

## 1a. Line IDs in the prompt (DIG-125, area prompt `a11`)

In rounds 2–3 of the memory A/B run, most walkthrough retries came from anchoring: a callout outside
its own step's ranges, or ranges that overlap. The model had to pick a side and copy per-side numbers
(`12+` and `12-` can be two different lines). The prompt now labels every shown line with a
hunk-relative **line ID** instead: `2.7` is the 7th shown line of hunk 2, counting `-`, `+` and
context lines alike (`2.7+ text`, `2.8  text`, `2.9- text`). A `\ No newline at end of file`
marker gets no ID. The model answers with

```json
"ranges":   [{"path": "src/retry.js", "from": "2.3", "to": "2.9"}],
"callouts": [{"path": "src/retry.js", "line": "2.5", "note": "doubles the delay"}]
```

(a callout may use `from`/`to` for a few lines). IDs must be strings: `2.10` as a JSON number would
read as `2.1`. The prompt states the anchor rules with one worked example in the walkthrough's
language (`ANCHOR_EXAMPLE`, en and ko); since DIG-126 (prompt `a12`) that example also covers the
callout no-overlap rule, stated the way the range rule already was ("each line in at most one
callout") rather than the one-line aside it used to be.

The parser (`packages/explain/src/lineids.ts`) turns the IDs into the stored `LineRange`. Nothing
downstream changes: the stored JSON, the cache, `rangeSpan` and the UI all still see
`{path, side, start, end}`. The `a6`–`a10` shape `{path, side, start, end}` is still accepted.

**Side.** `new` when the named lines include any new-numbered line (added or context), `old` when
they are all deleted lines.

**Snap rule.** `rangeSpan` cannot cut everywhere: a `new` range that starts on an added line takes
the deleted lines right before it, and a run of deleted lines at the edge of a mixed span has no
new-side number. When the named lines `from..to` cannot be stored exactly, they are snapped to the
**smallest stored range whose `rangeSpan` keeps every named line**, on the preferred side; the other
side is used only when the preferred one cannot hold them at all (for example `+` then a run of `-`
lines that ends the hunk). The stored range always round-trips: `rangeSpan(side, start, end)` gives
back exactly the span that was checked. Tests: `lineids.test.ts` (a span starting on `-` lines, a
span of only `-` lines, a span ending at a `\ No newline` marker, and every pair of lines in a
fixture checked against all stored ranges for minimality).

Streamed steps go through the same parser one range at a time, so the UI never sees line IDs.

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

## 2a. Repair before retry (DIG-125)

Before a reply counts as invalid, mechanical anchoring slips are fixed without a call. Each fix is
recorded as a `repair` finding (`AreaCheckResult.repairs`, logged as `repair: …` in
`explain_call.violations`). A repair is neither a violation nor a soft note: it never triggers a
retry, never goes into the retry feedback and never counts in `style_warnings`. A retry happens only
when a hard violation is left after repair.

| Slip | Repair | Not repaired (stays a violation) |
|---|---|---|
| A range entry that names no lines, or repeats a range of the same step exactly | dropped | — |
| Two ranges of one step overlap | merged into one range (snapped as in §1a) | when no stored range holds the union |
| A range overlaps an earlier step's range | the later range is trimmed off the earlier lines | trimming would leave nothing, split the range in two (overlap strictly inside), or leave one of the step's callouts outside every range of the step |
| A callout outside its step's ranges, in the same file and hunk as one of them | clipped to its lines inside the nearest range, or moved to that range's nearest line, even onto a line another callout already holds (then goes through §2b) | another file or hunk |
| A non-mechanical step with no callout | — | always: adding one would change what the step says |

Repairs change anchors only, never prose. The coverage check and the "Other changes" fallback run
after repair, unchanged, and the no-repeat rule still holds. `checkAreaWalkthrough(…, { repair:
false })` reports every slip as the violation it was before; the replay in
`first-try-replay.test.ts` uses it as its baseline.

## 2b. Callout overlap repair (DIG-126)

Round 4's raw replies were not kept, but memory A/B metrics (`.cache/DIG-121-acceptance-real/
metrics.json`) showed the anchoring repairs above removed the round 2-3 rules they targeted, and
left one residual as the main cause of a retry in both arms: "callout N overlaps another callout in
step N". The validator now repairs this too, when the overlap is trivial, processing a step's
callouts in reply order and comparing each against the ones already kept:

| Shape | Repair | Not repaired (stays a violation) |
|---|---|---|
| Exact duplicate: same lines, same note after trimming whitespace | the later callout is dropped | — |
| Partial overlap: the later callout has lines of its own outside the earlier one's | the later callout is trimmed to just those lines (snapped as in §1a) | the trim would leave nothing contiguous (e.g. the earlier one's lines sit in the middle of the later one's) |
| The later callout's lines are fully covered by the earlier one's (or the two name the same lines with a different note), and the earlier one spans more lines | the earlier callout is trimmed to exclude the later one's lines, keeping the later one as the model wrote it | trimming the earlier one would leave it empty, or would drop its own first line (the later one's lines sit inside, not at an edge, of the earlier one's) |
| Same single line, two different notes (or any other case above the earlier one does not span more lines than the later one) | — | always: neither callout can give way without changing what it says |

A callout moved in from outside its step's ranges (§2a) that lands on a line another callout
already holds is not failed outright: it goes through these same rules, as if it had always pointed
there. Repairs here never touch a note's text, only line anchors, same as §2a.

## 3. Prompt (area prompt `a6`)

- Walk the change in logical order. Each step is one idea over one small range (a few to ~20
  changed lines); a large new file is several steps, one per part.
- `ranges`: copy the line IDs (`"2.3"` to `"2.9"`, §1a) from the line prefixes; one range per
  hunk; never give the same line to two steps. (Before `a11`: line numbers from the `N+`/`N-`
  prefixes, with a side.)
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
