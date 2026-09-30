# UX cycle 2 — verification and summary (DIG-80, step 6)

Verifies Issue A (DIG-87), Issue B (DIG-88) and Issue C (DIG-89) against `docs/ux/decision-2.md`
and the nine findings in `docs/ux/audit-2.md`, on `main` at **703640f** (all merged, including
DIG-92 — see "One round trip" below). Every finding holds. Nothing is being reopened.

**Method**: two dedicated worktrees, `main` at `e36f485` ("before" — DIG-81 merged, B/C not yet
built) and `main` at `703640f` ("after" — the full cycle, including the fix below). Both built and
run with the `stub` provider (layout/flow evidence, not content — same limitation audit-2 noted).
Two synthetic projects throughout, `snapback` and `my-project`, driven with headless Firefox over
WebDriver BiDi at 1440×900 and 1280×800, in light and dark, English and Korean, plus a scripted
keyboard-only pass and independent WCAG contrast recomputation from the shipped `styles.css`
hex values (not the DIG-82/83 paperwork). Kit: `.cache/dig90-verify/` (`run-before.sh`,
`run-after.sh`, `drive4.mjs`, `seed-legacy.mjs`, `project.sh` reused from `dig80-audit/`). ~175
screenshots were captured; 30 are committed under `docs/ux/screens/dig90-*.png` as evidence.
402 web + 195 server tests pass on `main`.

**A note on how "ko" was captured, since the first pass got this wrong** (CTO review, `4cfc0ee0`):
the UI chrome's language follows the *current project's* stored `language`, not the browser
locale, once any project exists (`MainV2.tsx:423`) — `browserLang()` is only a fallback before a
project is known (first run). So first-run's `dig90-*-ko-1440-firstrun-after.png` shots are
genuinely Korean (browser locale set to `ko-KR`, no project exists yet), but the first pass's
Settings/project-panel/All-projects "ko" shots were captured the same way and were silently
English throughout (byte-identical to the English shots). Fixed by switching `my-project`'s
language to `ko` through the Settings language selector itself (the real, in-app path a user
would take), then recapturing Settings, the project panel (open + the "Confirm remove?" state,
closed via Escape without actually removing it) and All projects against that project. Every
string in the recaptured shots is Korean; the one intentional exception is a digest's own stored
headline text (e.g. `snapback`'s L0 summary in the All-projects row), which stays in whatever
language it was explained in — exactly what the language-setting's own hint says ("Older digests
stay as they were written") — while the surrounding chrome (labels, "Last activity", the unread
badge, "Confirm remove?") is fully Korean around it.

## One round trip before this passed

The first pass through this kit found a real blocker: removing a project always failed with
HTTP 415 in the actual browser (`apps/web/src/v2Api.ts`'s `del()` sent no `content-type`, and
`app.ts`'s v2 write gate requires one on every write route, DELETE included, since DIG-87 added
it to `isV2WritePath`). Filed as DIG-92 with the exact repro; fixed same-day (`703640f`,
`del()` now sends `content-type: application/json` plus a `{}` body, since Fastify itself
rejects that content type on a truly empty one). Re-verified below — the round trip now holds
live, not just in the (already-passing, pre-existing) test suite.

## Findings 1–9 (audit-2.md), before → after

| # | Finding | Before | After |
|---|---|---|---|
| 1 | History menu → three dead views + Insights | `dig90-light-en-1440-history-menu-before.png`, `dig90-light-en-1440-history-units-dead-before.png`, `dig90-light-en-1440-history-insights-dead-before.png` | Nav is Home (+ All projects at 2+ projects): `dig90-light-en-1440-all-projects-after.png`. Insights demoted behind a gated Settings link (Finding-1's "own top-level nav entry" recommendation was not taken; decision-2 chose the narrower "gated link" instead — see below). |
| 2 | No trust copy, no provider named | `dig90-light-en-1440-firstrun-before.png` | `dig90-light-en-1440-firstrun-after.png`, `dig90-dark-en-1440-firstrun-after.png`, `dig90-light-ko-1440-firstrun-after.png`, `dig90-dark-ko-1440-firstrun-after.png` |
| 3 | No way to remove a project | (no UI existed) | `dig90-light-en-1440-remove-panel-after.png`, `dig90-light-en-1440-remove-confirm-after.png`, `dig90-light-en-1440-after-removal-after.png`, `dig90-light-en-1440-after-restore-after.png` (project panel, both projects back, ko chrome — see note), `dig90-light-ko-1440-remove-panel-after.png`, `dig90-light-ko-1440-remove-confirm-after.png` |
| 4 | Escape drops focus to `<body>` | `dig90-light-en-1440-history-menu-before.png` (the menu itself is gone) | confirmed via `document.activeElement`, not a screenshot — headless BiDi can't render focus rings, and the "still on Home" visual is the same frame as the redirect check, so it isn't cited twice as if it were separate evidence (see "Keyboard pass") |
| 5 | Instant skeleton unverifiable with stub | not re-tested (unrelated to this cycle) | unchanged; still DIG-77's job |
| 6 | First-run dead space | `dig90-light-en-1440-firstrun-before.png` | `dig90-light-en-1440-firstrun-after.png`, `dig90-light-en-1280-firstrun-after.png` — measured, not eyeballed (see below) |
| 7 | Switcher has no context | `dig90-light-en-1440-switcher-before.png` (bare `<select>`) | `dig90-light-en-1440-remove-panel-after.png` (last-activity + unread per row), `dig90-light-en-1440-all-projects-after.png` (+ headline, cross-project) |
| 8 | No settings surface for provider/model/read-only | `dig90-light-en-1440-settings-before.png` | `dig90-light-en-1440-settings-after.png`, `dig90-dark-en-1440-settings-after.png`, `dig90-light-ko-1440-settings-after.png`, `dig90-dark-ko-1440-settings-after.png`, `dig90-light-ko-1280-settings-after.png` |
| 9 | Contrast not measured against direction B | deferred in audit-2 | recomputed from shipped hex values, see "Contrast" below |

## Findings holds, in detail

**1 — IA cleanup.** `App.tsx`'s nav is Home-only, plus "All projects" once 2+ projects exist
(`dig90-light-en-1440-all-projects-after.png`; hidden at 1 project, confirmed in
`App.test.tsx`'s "IA cleanup" describe block and live: `nav links` logged `[/, /projects]` at 2
projects, `[/]` right after a removal drops back to 1). `/units`, `/timeline`, `/briefing` all
redirect to Home via `history.replaceState` — confirmed live by navigating to each directly,
then pressing Back once: it lands on Home, never a dead route
(`dig90-light-en-1440-redirect-from-units-after.png`). `/insights` has no nav link anywhere; it
only appears as "Legacy insights" in Settings, gated on a live `hasLegacyData` query — confirmed
both states live: `false` on a clean pair of projects (`legacy link present? false`, logged on
every `settings` phase run) and `true` after seeding one `unit_event` row
(`dig90-light-en-1440-settings-legacy-link-after.png`, then the link opens `/insights`:
`dig90-light-en-1440-insights-via-legacy-after.png`). Decision-2 scoped this as "demoted, not
deleted" rather than audit-2's original "own top-level nav entry" suggestion — a deliberate,
documented scope call in decision-2's IA section, not a gap.

**2 — first-run trust copy.** `dig90-light-en-1440-firstrun-after.png` (and the dark/ko
variants) show the trust box exactly as `copy.ts`'s `trustCopy()` writes it; spot-checked the
live DOM text against `MainV2.tsx:89-103` (`TrustBox`) line by line, in both languages — verbatim
match, including the provider-specific clause (`providerStub`: "This server is set to the stub
provider, so nothing leaves this machine.").

**3 — remove a project.** Now: `digest remove <project>` CLI (confirmed present at
`packages/ingest/src/project-cli.ts:115`) and `DELETE /api/projects/:id` from the dashboard,
soft-delete (`dig90-light-en-1440-remove-panel-after.png` → `-remove-confirm-after.png`, and the
Korean equivalents `dig90-light-ko-1440-remove-panel-after.png` → `-remove-confirm-after.png`).
Live, end to end, post-DIG-92: removing the open project (`my-project`) redirects to the next one
(`snapback`) and the nav's "All projects" link drops away below 2 projects
(`dig90-light-en-1440-after-removal-after.png`); re-registering the same root restores it with
its full digest history (`digestCount: 2`, same `latestDigest`, not reset to 0 — confirmed via the
live `/api/projects` response, and visually in `dig90-light-en-1440-after-restore-after.png`,
which reopens the project panel to show both `snapback` and `my-project` present again with their
unread state intact), matching `v2.test.ts`'s "is restored, with its digest history" test.

**4 — Escape focus loss.** The History `<details>` that had the bug is gone. The equivalent new
interaction, the project panel's Escape handler, was scripted directly (not eyeballed — headless
BiDi can't reliably show focus rings): open via click, Tab into a row, Escape, then read
`document.activeElement` — it returns to `.proj-trigger`, not `<body>` (log: `after Escape: panel
open? false focused proj-trigger`). `ProjectPanel.test.tsx` covers the same behavior. No
screenshot is cited for this one specifically: the visible frame (Home, panel closed) is
indistinguishable from the redirect-check and restore-check frames, so I'm not presenting the
same image three times as if it showed three different things.

**6 — first-run layout.** Measured `getBoundingClientRect()` on both columns live, not eyeballed:
at 1440×900 the form's right edge sits at x=1128.8 of 1440 (`dig90-light-en-1440-firstrun-after.png`);
at 1280×800, x=1048.8 of 1280 (`dig90-light-en-1280-firstrun-after.png`). No band of empty space
approaching audit-2's original ~465px — the two columns run edge to edge at both widths.

**7 — switcher context.** The project panel row (shared with All-projects, per decision-2 §2 "one
row component") shows last-activity and an unread badge (`dig90-light-en-1440-remove-panel-after.png`,
`dig90-light-ko-1440-remove-panel-after.png`); All-projects adds the newest digest's L0 headline
(`dig90-light-en-1440-all-projects-after.png`, plus dark-en, light-en-1280 and the Korean
`dig90-light-ko-1440-all-projects-after.png`/`dig90-dark-ko-1440-all-projects-after.png` — fully
Korean chrome around `snapback`'s English-language digest headline, per the method note above).

**8 — settings surface.** `dig90-light-en-1440-settings-after.png` (+ dark-en, light-ko, dark-ko,
light-ko-1280): Daily budget, Provider ("stub" / "stub" — the value is the same string in both
languages, only the label "Provider"/"제공자" translates), the read-only line, all under one
"Settings" trigger — the same popover, now correctly labeled ("설정" in Korean). Decision-2's
"Changes to the brief" 1 scoped `/api/about` to
`{provider, model, readOnly, hasLegacyData}` deliberately, with no login/session field, so there
is no explicit "signed in" indicator in Settings — that is decision-2's own scope, not a gap
against it. The 401 story has two distinct, correctly-differentiated cases: a stale session on an
already-loaded page gets `MainV2`'s own in-app message (`projectsUnauthorized` →
`accessLinkNeeded`, "This dashboard needs an access link..." — confirmed via
`MainV2.test.tsx`'s dedicated 401 test); a cold visit to a server with `DIGESTIT_ALLOWED_HOSTS`
configured gets a raw `{"error":"unauthorized"}` JSON body instead of the SPA shell
(`dig90-light-en-1440-unauthorized-cold-after.png`) — that is `app.test.ts`'s explicitly tested,
deliberate behavior (every route, including `/`, needs a credential once a token is required),
not a bug; a cold, never-authenticated visitor has no session to speak of either way.

**9 — contrast.** Independently recomputed WCAG relative-luminance contrast from the actual
shipped hex values in `styles.css` (not trusted from the DIG-82/83 write-ups): `--control-border`
(the token every real control uses — `button`, `input`, `select`, the digest and project
triggers, confirmed by `grep`) is **3.53:1** light / **3.74:1** dark against `--bg`, **3.26:1** /
**3.53:1** against `--bg-inset` — both over the 3:1 non-text bar. `--muted` text is **5.71:1** /
**6.43:1** against `--bg`, both over 4.5:1. The hairline `--border` stays low-contrast on purpose
(decorative dividers, not controls — decision-2 §3's explicit call, confirmed live via
`getComputedStyle` reading the same hex values back out of the running page).

## Checklist (from the issue)

- **Old paths redirect, Back behaves** — holds, see Finding 1.
- **`/insights` reachable only through the gated link** — holds, see Finding 1 (both gate states
  tested live).
- **First-run trust copy matches the code** — holds, see Finding 2 (line-by-line against
  `MainV2.tsx:89-103`/`copy.ts`).
- **The 401 message** — holds, with the two-case nuance above; not a single message.
- **Settings shows budget, provider, sign-in state, read-only** — budget/provider/read-only hold;
  "sign-in state" was scoped out of `/api/about` in decision-2 itself (see Finding 8).
- **Remove plus re-register restores the project** — holds, live, post-DIG-92 (see "One round
  trip" and Finding 3).
- **Unread counts** — the three `computeUnread` states (none/new/count) were verified correct in
  an isolated, clean-profile repro against stable data. One "1 new" reading surfaced once during
  the full multi-profile capture run that didn't match the digest count at that instant, and did
  not reproduce in isolation afterward (same DB, same projects, correct both times) — noted, not
  filed, since I have no reliable repro and the isolated, controlled case is correct.
- **`/projects` sort order** — holds: unread-first, then newest activity
  (`dig90-light-en-1440-all-projects-after.png` — `my-project` with 1 unread ahead of `snapback`
  caught up), matching `sortAllProjects`.
- **Keyboard pass end to end** — holds: Home → All projects → project-switcher trigger → digest
  picker → Settings trigger → breadcrumbs → level tabs → reading pane → next-level button → area
  cards, a sensible tab order throughout at 1440; Escape on the project panel returns focus to
  its trigger (Finding 4).
- **Contrast against the DIG-82 tokens** — holds, see Finding 9.

## What I could not verify this pass

- **Real-provider timing/quality** — unrelated to this cycle; still DIG-77's job, stub-only here
  as in audit-2.
- **The unread-count anomaly above** — one non-reproducible reading, flagged, not filed.

## Board screenshot set

`docs/ux/screens/dig90-*.png` (30 files, listed above per finding) — a curated before/after set,
not the full ~175-shot capture (kept locally under `.cache/dig90-verify/shots/`, not committed:
git-ignored working evidence, reproducible from `run-before.sh`/`run-after.sh` in the same
directory).

## Review history

CTO review of the first pass (`4cfc0ee0`) requested changes: the "ko" Settings/project-panel/
All-projects shots were actually English (see the method note above for why and the fix), and
three "after" shots were the same image cited as if they were three different captures (fixed by
citing one, or none where the screenshot wasn't the real evidence — see Finding 4). Both are
addressed above; no other issue was raised.
