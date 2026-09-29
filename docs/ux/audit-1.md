# UX audit 1 — baseline (main @ 456f674, 2026-09-29)

Scope: DIG-55 cycle 1, step 1 (UX Reviewer). Tested against the current `main` (456f674),
which already includes DIG-49/50/52/53/56/57/58/59 — i.e. well past the "UX v3 @ 12c5e1c"
starting point named in the issue. Several of the follow-ups the issue lists as open
turned out to already be fixed on `main`; this audit re-verifies those and looks for what's
still wrong.

**Method**: built `.cache/acc47` (checked out at main), ran the `stub` provider through
`.cache/dig47-acceptance/accept.sh stub` for the standard 34-screenshot walk (1440×900,
light/dark, en/ko), plus a second manual session (`.cache/dig47-acceptance/audit1/`) driving
Firefox over WebDriver BiDi for flows the standard kit doesn't cover: the digest picker
dropdown, the History menu, real keyboard Tab order, the project switcher, and a fresh
project with no digest yet. Screenshots referenced below are committed under `docs/ux/screens/`.
Code citations come from a full read of `apps/web/src/{MainV2,App}.tsx`, `copy.ts`,
`styles.css`, `ProjectGraph.tsx`, `graphLayout.ts`.

Real-provider (claude-code) screenshots were not available this cycle — the nested `claude`
CLI isn't logged in inside this sandbox (known limitation, see `.cache/dig47-acceptance/README.md`).
Everything below is layout/structure/i18n/a11y, verified against the stub provider (content-
agnostic) plus a direct code read, so it doesn't depend on explanation quality. The operator's
pre-DIG-52/53 real-provider shots in `.cache/dig47-acceptance/old/shots-claude-code-dig47/` were
spot-checked only to confirm the *shape* of the density problem DIG-53 fixed still hasn't
regressed; they predate the current main and aren't cited as current-state evidence below.

## Status of the issue's named follow-ups

| Follow-up named in DIG-55 | Status on main | Evidence |
|---|---|---|
| L3 step bodies are dense paragraphs | **Fixed** (DIG-53) | `docs/ux/screens/light-en-L3-walkthrough.png` — steps are 1–3 sentences, hunk-scoped |
| UI chrome stays English when project language is Korean | **Partially fixed** (DIG-49/52) — see Finding 1 | `docs/ux/screens/dark-ko-header-idle.png` |
| Graph pane mostly empty around small clusters | **Fixed** (DIG-50/52) | `docs/ux/screens/light-en-L3-picker.png` — a 1-file area still shows the full, filled project graph |
| Digest picker truncates the L0 | **Fixed** (DIG-52) | Code: `MainV2.tsx` renders `d.l0.text` with no `text-overflow`/`line-clamp`; `.digest-list` scrolls instead of clipping |

Re-litigating fixed items wastes review time, so they're listed here as verified-closed, not
re-opened as findings.

## Findings

### 1. [major] Top-level nav ("Home", "History") and the History submenu never localize — accessibility/i18n

`copy.ts:1-4` says explicitly: *"Explanations themselves come from the LLM in the project's
language; this file is only the UI chrome, which stays English for now."* That's a real,
current gap, not a stale issue-description item: `docs/ux/screens/dark-ko-header-idle.png`
shows the project switched to 한국어 — the breadcrumb, level tabs, badges and buttons *are*
Korean (DIG-49/52 did that work) — but the top bar still reads "DigestIT | Home | History"
in English, and the History dropdown ("Units", "Timeline", "Briefing", "Insights",
`docs/ux/screens/history-open.png`) is 100% English regardless of project language.

**Why it hurts**: for persona (d), a Korean-speaking user, the page now looks half-migrated —
worse than all-English, because it signals "this wasn't finished" rather than "this app
doesn't support Korean." It's also the single most prominent, always-visible text on the
page (top-left, every screen).

**Fix direction**: `App.tsx:21` hardcodes the nav array (`Home/Units/Timeline/Briefing/Insights`)
and `App.tsx:207` hardcodes `History`. These are ~6 strings total, all outside the
LLM-generated content — the smallest possible localization surface. Route them through the
same chrome-copy mechanism already used for the L0–L3 labels (which do translate).

### 2. [major] No visible keyboard focus indicator confirmed via real Tab input, but headless test environment can't fully confirm — needs a manual check

`styles.css:88` defines `:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }`
globally, which is the right pattern. But driving real Tab keypresses through WebDriver BiDi's
`input.performActions` (not JS `.focus()` — that's a different, weaker signal), across Home,
the History summary, the project switcher and the info popover, `document.activeElement`
advanced correctly but **`:focus-visible` never matched, and `getComputedStyle().outlineStyle`
was `none` on every stop** (`docs/ux/screens/focus-digest-picker.png` — the digest-picker-trigger
button is `document.activeElement` in that shot with no ring drawn anywhere).

I could not fully separate a real bug from a known headless-Firefox quirk (`:focus` itself
didn't match either, which usually means the headless window lacks OS-level focus rather than
the app suppressing outlines) — so I'm not marking this CONFIRMED. But it's serious enough,
and cheap enough, that it shouldn't wait for a second review cycle: **open a small ticket to
verify in a real, focused browser window** (not headless) that Tab through the header, level
tabs, digest picker, and L3 step nav shows a visible ring at every stop, especially the
icon-only zoom buttons and the `▾`/`ⓘ` triggers which have no text fallback if the ring is
invisible.

### 3. [minor] Large unused whitespace on L0 and the L3 area picker at 1440×900

`docs/ux/screens/light-en-L0.png` and `light-en-L3-picker.png`: the left content column is a
few short lines/cards, but the pane is exactly as tall as the graph pane on the right
(~700px), leaving 60%+ of the left column blank. Compare `light-en-L2.png`, which has enough
content to fill the space and reads as a finished page — L0 and the L3 picker read as
unfinished or broken by contrast, especially to persona (a), a busy owner glancing at the
page for 5 seconds: the first visual impression is "empty," not "summary."

**Fix direction**: this is a layout problem, not a content problem — don't pad L0 with more
text. Either cap/shrink the graph pane to match content height on these two views, or give
L0 a secondary module (e.g. a compact area list, mirroring L3's cards) so the page has a
reason to use the space.

### 4. [minor] "Explain N changes" pending-count vs. the History submenu's legacy vocabulary

The History menu (`docs/ux/screens/history-open.png`) exposes "Units", "Timeline", "Briefing",
"Insights" — four nouns from the pre-v2 product that are never defined anywhere in the UI.
For persona (c), a first-time user, these sit one click away from the main flow with no
description, tooltip, or visual distinction from the L0–L3 reading flow they just learned.
Heuristically this is a "match between system and the real world" / "recognition rather than
recall" violation (Nielsen #2/#6): a first-timer has no way to know whether clicking
"Timeline" leaves the thing they were just reading.

**Fix direction**: out of scope to redesign those pages this cycle, but the menu itself could
at minimum get a one-line description per item (like the digest cards on L3 do), or a visual
separator/label ("Other views") signaling these are a different, secondary surface.

### 5. [observation, not a defect] No "reviewed / accepted" affordance for persona (b)

Grepped the whole web app for `accept`/`approve`/`reject`/`review` (as UI affordances, not
prose) — none exist. A reviewer persona can read L0→L3 and form a judgment, but there's
nowhere in the product to record "I looked at this" or "flag this hunk," and no shareable
state beyond the URL. This may be intentionally out of scope (DigestIT positions itself as a
digest/explain tool, not an approval tool), so I'm not filing it as a bug — but the Designer
should decide explicitly, since persona (b) is named in this cycle's brief and the product
currently has nothing for them beyond "read and leave."

### 6. [polish] Digest picker and area cards have generous unused width on wide screens

Minor, not worth its own ticket unless bundled with Finding 3: on `light-en-L3-picker.png`
the three area cards are laid out in a loose row with large right margins; at 1440px the
cards could either grow to fill the row or wrap into a denser grid.

## Heuristic + accessibility pass (not itemized above)

- **Visibility of system status**: good — the header shows "running" with a live timer,
  landing state, and remaining call budget at all times (`docs/ux/screens/dark-ko-header-idle.png`
  shows "오늘 남은 호출 37회" / calls-left badge, always visible).
- **Error prevention / recognition**: `role="alert"` used consistently for error text (per code
  read); API failures ≥400 were empty (`[]`) across every driven flow in this audit — no error
  states were exercised, so error-message quality is unverified this cycle.
- **Aesthetic/minimalist design**: the GitHub-benchmarked palette and spacing read as clean and
  professional in both themes; dark mode (`dark-ko-header-idle.png`) has good contrast
  throughout.
- **Graph accessibility**: `ProjectGraph.tsx` marks the entire SVG `aria-hidden="true"` and
  individual clickable nodes have no `role`/`tabIndex`/accessible name. This means the graph —
  a primary navigation surface — is entirely unavailable to screen-reader and keyboard-only
  users; they're limited to whatever the text panes expose. Given the graph is presented as
  supplementary (all the same content is reachable via L0–L3 text and the L3 area cards), this
  is not a blocker, but it should be named explicitly as a known, accepted gap rather than
  silently absent — the aria-hidden was clearly deliberate (comment in the file defers a11y to
  the change list), so this is a documented tradeoff, not an oversight.
- **Consistency**: level tabs, breadcrumb and keyboard shortcuts (0–3, n/p) behave identically
  across L0–L3 and in both languages/themes — no inconsistencies found.

## Persona notes

- **(a) Busy owner, back after 2h of AI work**: header "landed" state answers "what happened"
  in one glance (file count, +/− lines, one-line L0) — this works well. First friction point is
  Finding 3 (L0's empty space reads as "nothing to see" for half a second before the eye finds
  the paragraph).
- **(b) Reviewer deciding whether to accept**: L3's "What to check" callout
  (`light-en-L3-walkthrough.png`) is a genuinely good pattern — it tells the reviewer where to
  spend attention. But per Finding 5, there's no way to close the loop once they've decided.
- **(c) First-time user**: the empty-state copy for a brand-new project
  (`docs/ux/screens/project2-first-run.png`: *"No digests yet. Work in this project with any
  tool, then press Explain above."*) is clear and actionable — good. The History menu
  (Finding 4) is the one place a first-timer would get lost.
- **(d) Korean-speaking user**: Finding 1 is the material issue. Everything downstream of the
  top nav (breadcrumb, tabs, buttons, empty states inside the reading pane) is properly
  localized once you're past the header.

## Handoff

Reassigning to the UX Designer to write `docs/ux/brief-1.md` against these findings (plus
their own reasoning about the first-30-seconds experience, per the issue). Findings 1–4 are
concrete and actionable; Finding 5 needs a product decision before a brief can propose a
design for it; Finding 2 needs a quick manual (non-headless) recheck before anyone designs
around it.
