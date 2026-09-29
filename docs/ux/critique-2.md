# UX critique 2 — of ai-look-audit.md (DIG-63 cycle 2, step 2)

Scope: DIG-63 loop step 2 (UX Reviewer). Spot-checked every citation in `ai-look-audit.md`
against the actual code and data on `main@164e5ee`: `style.ts` (`boilerplate`, `checkProse`,
retry wiring in `digest.ts`/`area.ts`/`pipeline.ts`), `copy.ts`, `styles.css` (gradient line,
lane colors), `Walkthrough.tsx`/`Reader.tsx` checkmark glyphs, the `prompt.ts`/`digest.ts`/
`area.ts` system-prompt "AI" mentions, and both `walkthrough-snapback.sample.{en,ko}.json`
golden files (re-parsed independently, not just re-read the doc's excerpts). Also ran my own
regex sweep of the golden JSON against the full DIG-63 banned-pattern list, independent of the
audit's method, to check the "none of these happen to appear in the one real sample" claim.
Per-finding verdicts below, most severe first.

## Finding 1 (gap, high priority) — CONFIRMED, keep as the CTO's headline item

`boilerplate()` really is five DIG-47-era patterns (`style.ts:63-77`) with no coverage for
openers, hedges, marketing words, triplets, em-dashes, or vague claims. Grepped for
`style_warnings` across the whole repo: zero hits, so that field genuinely doesn't exist yet.
Traced the retry path (`pipeline.ts`/`digest.ts`/`area.ts`/`context.ts`: `retryFeedback`,
single retry, fed from `v[]`) — it's real and it's generic (any string pushed into `v` becomes
retry feedback), which is good news for the fix: extending `checkProse`'s violations list is
enough to get retry-on-style-warning for free, no new retry machinery needed. Worth adding this
to the fix direction so the Summarization engineer doesn't build a second retry path by mistake.

No objection to scope or priority. This is correctly the thing the CTO should split off first.

## Finding 2 (minor, same-opener repetition) — CONFIRMED, with exact data

Re-parsed the JSON myself instead of trusting the excerpt: `retry-backoff` and `retries-config`
both open `"This area adds ..."`; `upload-error` and `queue-and-exit` don't share an opener. The
Korean sample's four openers are genuinely distinct (새 src/retry.ts의 withRetry는… / 업로드가
재시도를 모두 소진하면… / runQueue가 이제… / loadConfig가…). The audit's claim is exactly right,
including the "English-specific, not systemic" read. Fix direction is sound and cheap (one
prompt-rule line, folds into the Finding 1 change). No changes requested.

## Finding 3 ("Explaining… Ns" progress label) — verdict: not a defect, but the citation is wrong

I opened `.cache/dig47-acceptance/old/shots-claude-code-dig47/light-en-header-running-later.png`
directly (the audit cites `docs/ux/screens (light-en-header-running / running-later)`, but those
filenames don't exist under `docs/ux/screens/` in this worktree — they're only under
`.cache/dig47-acceptance/{shots-stub,old/shots-stub-1,old/shots-stub-2,old/shots-claude-code-dig47}/`).
Minor doc accuracy issue: fix the path before this doc is cited again.

On the substance, I agree with the audit's own call: don't touch this. The button reads
"Explaining… 12s" next to a spinner, which does *visually* rhyme with a chatbot's "Thinking…",
but the audit's distinction holds up once you look at the actual pixels — it names the real
action and a real, ticking elapsed time, which is exactly what a CI status chip does ("Running…
12s"), not what a chat UI's indeterminate "Thinking…" does. Making it *less* concrete (e.g. a
bare spinner with no label, or "Working…") would be a regression: it would remove the one thing
that makes it non-AI-coded in the first place — the honesty of a live counter. If anything, the
"AI tell" here is only the ellipsis; not worth a change on its own. Recommend: close this finding
as "reviewed, no change," not carry it forward as an open judgment call.

## Finding 4 (copy-lint regression test) — the proposed method needs a correction before it's built

The finding is right that a guard doesn't exist yet, and low-priority is the right call. But the
concrete method it proposes — "reading `copy.ts` as source text... against a banned-word list,
`/[emoji ranges]/u`, and `/!/`" — has a real bug: `copy.ts` is TypeScript, not a string table, and
already contains legitimate `!` characters that aren't exclamation marks (`!builtLabel`,
`!/^[a-z][a-z0-9_]*$/.test(code)`, confirmed by grep — two hits, both negation/regex syntax). A
literal `/!/ ` test against the raw source would fail immediately on code that's already merged,
which is worse than no test: a red build the very first time someone touches the file, for a
reason that has nothing to do with copy tone. The doc does mention a second option ("or just
`import * as copy` and check the exported string/function outputs") — that one is correct and
should be the *primary* method, not a fallback, specifically because it only ever sees rendered
string values, never code syntax. The banned-word/emoji checks are fine against source text (they
don't collide with TS syntax the way `!` does), but the `/!/ ` check specifically must run against
evaluated string outputs only. Flag this for whoever builds Finding 4 so they don't ship a
lint that breaks on day one.

## Independent check: is the "none of these appear in the real sample" claim actually true?

Ran my own regex sweep of both golden JSON files against the DIG-63 list (openers, "it's worth
noting", "essentially", "various", "a number of", "ensures that", "helps to", em-dashes, `**`
bold markers, marketing words) rather than trusting the audit's read. Two apparent hits, both
false positives on inspection: "a number of 500 or more" in the English sample is the numeric
phrase "a value of 500 or more," not the hedge "a number of things"; `**` in the Korean sample is
the JS exponentiation operator inside a quoted code formula (`2 ** (attempt - 1)`), not markdown
bold. Net: zero real hits. The audit's empirical claim survives independent re-testing — this is
useful ammunition for the CTO (the prompt's existing voice rules generalize better than the
issue's checklist might suggest; the gap really is "nothing stops it," not "it's already
happening").

## The two new checklist items

Both worth keeping, as written:

- **Same-opener repetition across sibling generations**: right call that this needs a cross-field
  rule, not a regex — a per-field lint can't see it. One addition: scope it explicitly to "within
  one digest" in the checklist text itself (not just the fix direction), so whoever implements the
  Summarization side doesn't build a global opener-tracker across unrelated digests, which would
  be both more expensive and not what was observed.
- **Progress-copy that rhymes with "thinking" language even when factually concrete**: worth
  keeping as a checklist line so future auditors don't have to re-derive Finding 3's reasoning
  from scratch, but given the Finding 3 verdict above (no change needed here), word it as a
  *question to ask*, not a default-to-fix pattern — otherwise a future audit might "fix" a
  legitimately good progress indicator on pattern-match alone.

## Summary for the CTO

Findings 1 and 2 are solid, correctly scoped, and can go to Summarization as-is (Finding 1's fix
direction should explicitly note the retry path is already generic and reusable). Finding 3
should be closed, not carried forward — recommend dropping the ellipsis-rhyme concern rather than
changing the label. Finding 4 needs one correction before anyone builds it: the `/!/ ` check must
run against evaluated copy output, not raw TS source, or it breaks on legitimate code the day it
ships. The "already clean" section held up under independent re-testing, including a sweep the
audit itself didn't run — the interface and the one real sample are genuinely clean against the
issue's list; the only real gap is that nothing *enforces* it going forward.
