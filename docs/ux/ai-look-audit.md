# AI-look audit — DIG-63 (main @ 164e5ee, 2026-09-29)

Scope: DIG-63 step 1 (UX Designer, "catch"). Goal: find everything in the interface and in
generated explanations that would make a user think "this was made by an AI," using the
checklist in the issue plus whatever else turns up.

**Method**: read `apps/web/src/copy.ts`, `styles.css` and every `.tsx` in `apps/web/src` in full
(not a sample — the copy discipline from DIG-47 means `copy.ts` is close to a complete string
inventory, but I grepped the components too, for anything not yet migrated). Grepped for the
issue's literal tells (emoji ranges, exclamation marks, "AI" mentions, marketing verbs, chirpy
openers, title case) across the web app. Read the shared prompt/validator module
(`packages/explain/src/style.ts`, wired into `digest.ts`/`area.ts`/`context.ts`) to see what
style enforcement already exists. Reviewed real `claude-code` output two ways: the stored JSON
samples `packages/explain/test/golden/walkthrough-snapback.sample.{en,ko}.json` (DIG-48, model
`claude-opus-5-5`, full L0–L3 for a 4-area change) and the rendered screenshots in
`.cache/dig47-acceptance/old/shots-claude-code-dig47/` (real-provider, light/dark, en/ko, all four
levels plus header states) and `.cache/dig47-acceptance/audit1/` (picker, History menu, a fresh
project). No new screenshots were taken this round — the existing set already covers every
screen/theme/language combination the issue asks for, at the current `main`.

## Already clean — verified, checked against the issue's list

Re-listing these as closed so the Reviewer doesn't re-spend time on them:

- **Gradients/glassmorphism/neon/purple accents**: none. `styles.css` is flat colors, 1px
  borders, 6px radius throughout (GitHub palette, `styles.css:1-2` comment states this as intent).
  The one `linear-gradient` in the file (`styles.css:82`) is a 1px hairline technique for a
  full-bleed header border, not a decorative fill — confirmed by reading the adjacent comment.
  Lane/heat colors use purple (`--lane-3`, `--lane-6`) but only as one slot in an 8-color
  categorical graph palette and a validated sequential ramp — data encoding, not chrome.
- **Sparkle/magic/robot icons, decorative icons, "AI" badges**: none found in any `.tsx`.
- **Emoji in UI**: none. The only non-ASCII UI glyphs are `✓`/`○` (reviewed/unreviewed state,
  `Walkthrough.tsx:167`, `Reader.tsx:128-134`, `styles.css:561,586`) — and that's a deliberate
  WCAG 1.4.1 fix from DIG-61 ("not color-only: a checkmark glyph plus the word," per the code
  comment), not a decorative flourish. Leave it.
- **Exclamation marks, chirpy tone ("Welcome back!", "Let's dive in")**: none in `copy.ts` or any
  component string.
- **Marketing words** (seamless, effortless, powerful, robust, comprehensive, streamlined,
  leverage, unlock, supercharge, delve, elevate): none.
- **"AI" mentioned where the user doesn't need to know**: none in UI copy. `packages/explain/src/
  {prompt,digest,area}.ts` do say "The code may have been written by an AI coding tool" — but
  that's the *system prompt sent to the model*, never shown to a user; it's there so the model
  calibrates tone/caveats for AI-authored diffs. Not a UI tell.
- **Hero layouts, everything-in-a-card, big headings/little content**: the app is a dense,
  GitHub-style two-pane reading layout (`docs/ux/screens/light-en-L0.png` etc.); L0's own
  whitespace was already raised and accepted as a *layout* issue in cycle 1 (audit-1.md Finding
  3), not an AI-look issue — not re-opening it here.
- **Skeleton shimmer**: none used anywhere.
- **Generated-explanation filler the DIG-47 lint already blocks**: `style.ts` has a working
  `boilerplate()` check (`FILLER`/`FILLER_WHOLE`/`UNCLEAR`, `style.ts:52-91`) wired through
  `checkProse` into every prose field of L0–L2, the L3 walkthrough and the context builder. It
  already kills "may have changed," "Changed here.," "No user-visible change," "Changes in
  &lt;folder&gt;," and Korean equivalents, and requires "not evident from the diff" to say what's
  unclear. Confirmed by grepping the real sample JSON: none of these phrases appear.
- **Vague value claims in real output**: the DIG-48 sample (`walkthrough-snapback.sample.en.json`)
  never says "improves maintainability" or similar — every claim names a function, flag, file or
  number (e.g. "waits start at 200 ms, double up to 10 s, jittered"). Korean sample: no 전반적으로,
  다양한, 효율적으로, 보다 원활한, and endings are the concise 합니다/습니다 style the prompt asks
  for, not 하십시오체. This is strong evidence the *voice* rules already work — the gap (below)
  is in what they don't yet check for.

## Findings

### 1. [gap, high priority] The "AI-tell lint" the issue asks for doesn't exist yet — only a narrow DIG-47 boilerplate check does

`style.ts`'s `boilerplate()` (`style.ts:81-91`) checks five hard-coded filler patterns left over
from the DIG-47 walkthrough work. It does not check for anything in DIG-63's broader list:
chatty openers ("This change introduces/enhances…," "In this commit…," "Overall,"), hedging
("it's worth noting," "essentially," "various," "a number of," "ensures that," "helps to"),
triplets/rhythmic lists, em-dash chains, over-bolding, or vague value claims without a concrete
referent. None of these happen to appear in the one real sample I have, but nothing currently
stops them from appearing in the next one — there's no lint, no `style_warnings` field, and no
retry-on-style-violation path (the existing retry is validation-only: schema/word-limit/filler).

**Why it matters**: this is the actual mechanism DIG-63 asks for ("Add an AI-tell lint... It
triggers one retry with feedback, then records a `style_warnings` count"), and it's currently
zero built, not partially built — easy to assume `boilerplate()` already covers it since it looks
similar, but it's scoped to five specific DIG-47 phrases, not the DIG-63 checklist.

**Fix direction**: this is Summarization-engineer work, not something I can spec as a UI fix, but
concretely: extend `style.ts` with a second pattern set (call it `AI_TELLS` or fold into
`FILLER`/`FILLER_WHOLE` with a `severity: 'warn'` vs `'hard'` split, since hard filler currently
blocks/truncates while style tells should *warn + retry once*, per the issue). Cover the
opener/hedge/marketing lists in the issue verbatim plus the Korean equivalents. Run it inside
`checkProse` (already the single choke point for every prose field in `digest.ts`/`area.ts`/
`context.ts`) so one change covers L0–L3 and context at once. Needs a `style_warnings: number`
column/field on the stored explanation and a test fixture per language (en/ko), same shape as the
existing `validate.test.ts`.

### 2. [minor] The DIG-48 sample repeats the same overview opener across areas in one digest

In `walkthrough-snapback.sample.en.json`, 2 of 4 area overviews open with the same clause: "This
area adds src/retry.ts, a small helper that retries…" and "This area adds a retries setting that
operators control…". A reader who moves through L3 area to area (the intended flow, per
`docs/ux-v3.md` section 2) hits the same sentence shape twice in five minutes — a small but real
structural tell (repeating a template rather than repeating information). The Korean sample does
not repeat this pattern (its openers vary: "새 src/retry.ts의 withRetry는…", "업로드가 재시도를
모두 소진하면…"), so this looks like an English-specific habit, not a systemic one.

**Fix direction**: add one line to `VOICE` or a walkthrough-specific instruction in `area.ts`:
something like "don't open this area's overview with the same first clause as another area's
overview in the same digest" — the area prompt already receives the digest's L0/L2 context
(`area.ts` `digestBlock`), so the model has what it needs to check this itself. Low cost, and
folds naturally into the same prompt-rule change as Finding 1.

### 3. [reviewed, no change] "Explaining… 12s" progress label

`.cache/dig47-acceptance/old/shots-claude-code-dig47/light-en-header-running-later.png` (corrected
citation — not under `docs/ux/screens/`, which doesn't have this shot) shows a primary button
reading "Explaining… 12s" with a spinning ring while a digest is generated. This sits close to the
issue's banned "Analyzing…, Thinking…, Generating magic…" pattern in *shape* (ellipsis + verb +
spinner), but differs in substance: it names the literal action in progress and shows real,
ticking elapsed time (per `docs/ux-v3.md` section 4: "running state with elapsed seconds... so a
reload keeps the timer"), which is the opposite of vague "thinking" copy — it reads like a CI
job's "Running… 12s," not a chatbot's "Thinking…". Reviewed against the actual pixels (not just
the copy) per critique-2.md: closing this as no-change. Making the label less concrete to avoid
the ellipsis-rhyme (a bare spinner, or "Working…") would be a regression — it would remove the
live counter that's the actual reason this doesn't read as AI-coded. If anything the only tell
here is the ellipsis alone, which isn't worth a change by itself.

### 4. [gap, low priority] No copy-lint test yet to guard the "already clean" state

`copy.ts` currently contains no banned words, emoji or exclamation marks (see "Already clean"
above), but there's no test enforcing that — a future change could reintroduce one and nothing
would catch it before a human read it. This is exactly the "UI-copy lint test" DIG-63 asks for
under "Both." Low priority only because there's nothing to *fix* today; it's a regression guard,
not a current defect.

Concretely, two different checks need two different inputs, per critique-2.md: `copy.ts` is
TypeScript, not a string table, and already has legitimate `!` characters that aren't exclamation
marks (`!builtLabel`, `!/^[a-z][a-z0-9_]*$/.test(code)` — confirmed by grep, two hits, both
negation/regex syntax). A literal `/!/` test against the raw source would red-build on code that's
already merged, for a reason that has nothing to do with tone. So: `import * as copy from
'./copy.js'`, walk the exported strings and function outputs, and run `/!/` only against those
*evaluated* values, never the source text. The banned-word list and the emoji range
(`/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u`) don't collide with TS syntax the same way, so they
can run against either the evaluated strings or the raw source — evaluated strings is still the
simpler single method to build and maintain, so use it for all three checks rather than mixing
methods.

## New tells to add to the checklist

- **Same-opener repetition across sibling generations within one digest** (Finding 2) — the
  existing checklist is written per-field ("openers like…"); it doesn't cover the case where each
  individual field passes but the *set* of fields reads as templated because they share an
  opener. Worth adding as its own line since it can't be caught by a single-string pattern match —
  it needs a cross-field check or a prompt rule, not a regex. Scoped explicitly to *within one
  digest*: the observed case was two area overviews in the same walkthrough, not a pattern across
  unrelated digests — a global opener-tracker would be more expensive to build and isn't what was
  observed, so don't scope the fix wider than the evidence.
- **Question to ask, not a default-to-fix pattern: does this progress copy rhyme with "thinking"
  language only in rhythm, or is it actually vague?** (Finding 3) — the checklist's example list
  ("Analyzing…", "Thinking…") is about vague verbs with no real referent; ellipsis+spinner is a
  separate, purely visual/rhythmic signal that can co-occur with genuinely concrete, honest copy
  (a live elapsed-time counter naming the real action, as in Finding 3). When auditing this in
  future cycles, check whether the copy names a real action and shows real progress before
  flagging it — pattern-matching on shape alone risks "fixing" a legitimately good indicator into
  a vaguer one.

## Revision note (after critique-2.md)

This is the Designer's one revision pass per the loop, addressing all three requested changes in
`critique-2.md`:

- Finding 3 reworded from "judgment call, not confirmed" to "reviewed, no change" (closed, not
  carried forward), and its screenshot citation corrected to
  `.cache/dig47-acceptance/old/shots-claude-code-dig47/light-en-header-running-later.png`.
- Finding 4's fix direction corrected: the `/!/` check must run against evaluated `copy.ts`
  exports, not raw source text (raw-source `/!/` would false-positive on existing negation/regex
  syntax); the import-and-evaluate method is now the primary (only) method, not a fallback.
- Both new checklist items reworded: the opener-repetition item is now scoped explicitly to
  "within one digest," and the progress-copy item is now phrased as a question to ask rather than
  a default-to-fix pattern.

No other changes — Findings 1 and 2, and the "already clean" section, stand as critique-2.md
confirmed them (including the independent regex-sweep verification of the "no real tells in the
sample" claim).

## Handoff

Ready for the CTO to decide and split per the loop (step 3): Finding 1 (build the real AI-tell
lint, `style_warnings` field, retry-on-style-warning — retry plumbing already exists and is
reusable) and Finding 2 (one prompt-rule line against same-opener repetition, folds into the same
change) go to Summarization. Finding 4 (copy-lint regression test, evaluated-exports method) goes
to Frontend. Finding 3 is closed, no build needed. The two new checklist items are confirmed
additions to the issue's "AI tells" list for future audits.
