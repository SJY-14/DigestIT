# AI-look verify (DIG-67): before/after, lint counts, blind read

DIG-63 step 5. Verifies DIG-65 (AI-tell lint, Summarization) and DIG-66 (UI-copy lint,
Frontend), both merged to `main`. "Before" is `main @ ac9ff55` (DIG-63 steps 1-2, pre-fix).
"After" is `main @ 94851fc` (DIG-65 + DIG-66 merged, current head at verify time).

## 1. Screens

Fresh stub runs of the synthetic `snapback` project, using the DIG-47 acceptance kit
(`.cache/dig47-acceptance/{accept,project,drive}.{sh,mjs}`, copied into `.cache/dig67-verify/{before,after}`
with private ports so both could run without touching the shared kit). Each run: light theme
English Explain, dark theme English read + switch to Korean, second change Explain in Korean
(dark), then read in light — 37 screenshots per side, 1440×900: header idle/running/running-later/after,
L0, L1, L2, L3 picker, L3 walkthrough, step 1, step 2, ×2 languages ×2 themes.

Representative pairs are committed at `docs/ux/screens/dig67-*.png` (synthetic project only, per
repo rules). Full sets are under `.cache/dig67-verify/{before,after}/shots-stub/` (gitignored,
not part of this PR).

**Result: no visible regressions, and no visible AI-look differences in the stub content.**
`git diff ac9ff55..94851fc -- apps/web/src` touches `App.tsx` (nav `aria-label` now
`T.pagesLabel`) and `MainV2.tsx` (six raw strings in the project-setup form and empty-project
guards moved into a new `setupCopy(lang)` table, plus two `Loading…` sites that ignored `lang`
now use `headerCopy(lang).loadingStatus`). None of those screens appear in this walkthrough,
because the demo project always exists before the kit starts using it — the setup form and
empty-project state are only reachable with zero registered projects. Confirmed by reading the
diff and `copy.ts` instead: both `en` and `ko` tables are populated (`시작하는 중…`, `시작`,
`프로젝트 폴더`, etc.), so the fix is real even though it isn't in a screenshot here.

Digest content itself (L0 text, area titles, diff hunks) is byte-identical before/after, as
expected — the stub provider returns fixed fixture text regardless of prompt changes.

**Duplicate screenshots, explained (not evidence tampering):** `header-running`,
`header-running-later`, `header-after` and the first level view are pixel-identical within a run,
in both before and after — the stub explain completes near-instantly, so by the time the script's
5s/7s sleeps elapse the UI has already landed. Same for `L3-step1`/`L3-step2`: the
README.md area the kit opens has one hunk, so the walkthrough is overview + step 1, and the
second `n` has no further step to move to. That is expected, not a bug.

**Dark-mode report withdrawn (DIG-68):** the first draft of this pass reported that the dark-Korean
L3 walkthrough rendered in the light palette and filed DIG-68. The cited screenshots
(`docs/ux/screens/dig67-dark-ko-L3-walkthrough-{before,after}.png`) are in fact dark: mean
luminance 27, the same as `dig67-dark-ko-header-idle-after.png` and `dig67-dark-ko-L2-after.png`
(light-theme shots measure about 247). DIG-68 was closed as not reproducible.

## 2. Lint counts

Ran `packages/explain/dist/cli.js lint-report` (built from `94851fc`).

| Source | Total hits | By rule | By level | Repeated openers |
|---|---|---|---|---|
| `walkthrough-snapback.sample.en.json` | 2 | `opener-this-x`: 2 | l3: 2 | 2 |
| `walkthrough-snapback.sample.ko.json` | 0 | — | — | 0 |
| Stored real-provider DB (`run-claude-code-WmE2`) — **before** | 0 | — | — | 0 |
| Stored real-provider DB — **after** (operator step 6) | *not run yet* | — | — | — |

These numbers match DIG-65's own CTO-reviewed hand-off comment exactly (independently
reproduced here, not copied).

**Hand review of every hit:**
- The 2 golden-`en` hits are both real: two area overviews open with "This area adds…" — the
  literal pattern from DIG-63's audit Finding 2, kept in the fixture on purpose as a regression
  case for the opener rule and the repeated-opener counter. Not a false positive; nothing to file
  against DIG-65.
- Golden `ko`: read all four area overviews and the L0/L1 text by hand — clean, no missed
  hedges/marketing/번역투 patterns that the lint should have caught. Matches the reported 0.
- The stored real-provider DB (2 digests — en "add `--retries`", ko "add `--dry-run`" — with
  L0/L1/L2, 2 area walkthroughs, 2 project-context rows, all `status='ok'`) genuinely reads
  clean by hand: no boilerplate openers, no hedges, no marketing words, concrete engineering
  detail throughout (e.g. "the reason for the 10 cap is unstated, so ask the author"). Zero
  false negatives found in a full manual pass — corroborates the 0-hit count rather than just
  trusting the tool.
- **No false positives found anywhere in this pass.** Nothing filed back against DIG-65.

**"After" real-provider row:** the DIG-65 hand-off notes the stored DB's md5 was unchanged
after their own report run, and no `run-claude-code-*` directory postdates the DIG-65/66 merge
(`1fd2b0b`/`4ba86e6`, both ~06:00) — the one on disk (`run-claude-code-WmE2`) is from the
DIG-63 prompt-fix stage, before the lint was wired into the retry loop. Per the issue: this is
expected, the "after" row needs DIG-63 step 6 (operator real-provider run) and isn't blocking
this verify. Left as a placeholder above.

## 3. Blind read

Five explanations from the stored real-provider DB (§2; a claude-code run over the synthetic `snapback` project), across levels and both languages. Would
each pass as written by a senior engineer reviewing a teammate's diff?

1. **L0, en** — *"Backups now retry temporary server failures and continue past failed files, so
   one hiccup no longer aborts everything."* **Pass.** Concrete, states the behavior change and
   its user-facing consequence in one sentence, no hedge or opener template. Reads like a PR
   title a person would write.
2. **L2 "why", en** — *"Validating in resolveConfig makes a bad --retries value fail before any
   upload starts; the reason for the 10 cap is unstated, so ask the author."* **Pass, and
   notable.** Flagging an actual open question about the author's intent ("ask the author") is
   not something boilerplate AI summarization does — it's the kind of specific, slightly
   skeptical note a real reviewer leaves.
3. **L3 walkthrough step body, en** (`retry-with-backoff`, step "Add withRetry and
   transient-failure rule") — *"withRetry calls fn(attempt) and rethrows once attempt reaches
   retries or the error is not transient. Otherwise it sleeps baseDelayMs * 2 ** attempt... Caveat:
   any non-HttpError counts as transient, including programming errors thrown inside fn."*
   **Pass.** Precise mechanism description plus a genuine edge-case caveat (a programming error
   would be silently retried as if transient) — exactly the kind of thing a careful engineer
   calls out in a walkthrough.
4. **L0, ko** — *"백업 전에 --dry-run으로 업로드 대상 파일과 총 용량을 서버 연결 없이 미리 확인할 수
   있습니다."* **Pass.** Natural 합니다체, concrete (names the flag and what it shows), no
   부자연스러운 번역투 or banned patterns (전반적으로/다양한/효율적으로/하십시오체 all absent).
5. **L3 walkthrough step body, ko** (`dry-run-upload` area, step "로그 함수 이름 변경 반영") —
   *"log.js의 함수 이름을 따라 fail을 logError로, info를 logInfo로 바꿨고 호출 위치와 메시지는
   그대로라서 동작은 달라지지 않습니다."* **Pass.** States plainly that this is a mechanical rename
   with no behavior change — a real engineer's way of telling a reviewer "skip this one, nothing
   to check here."

**5/5 pass.** Consistent with the 0-hit lint count on this DB (§2): the real-provider output is
genuinely clean, not just lint-clean. No quotes from real (non-synthetic) projects are used
anywhere in this document, per repo rules.

## 4. Reopen what falls short

Nothing found to reopen against DIG-65 or DIG-66. Both lint tools' own numbers reproduce exactly
under independent verification, hand review of every lint hit (golden + stored DB) found no false
positives and no missed cases, the screenshot pass found no visual/copy regressions, and the
blind read passed 5/5. DIG-66's copy fixes for the project-setup form (`setupCopy`, `T.pagesLabel`)
couldn't be exercised by this screenshot pass (see §1) but are correct by code/diff reading.

## 5. What's left

- **DIG-63 step 6** (operator real-provider run): needed to fill the "after" row in §2's
  real-provider table. Not blocking; can run independently of this issue closing.
- No further DIG-65/66 rework requested.
