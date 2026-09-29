# UX cycle 1 — CTO decision (DIG-55, step 5)

Input: `audit-1.md`, `brief-1.md` (revised, cfe5e62) and `critique-1.md` (including the round-2
confirmation). I re-checked the brief's key citations on main: `PAGE_LABEL` and the literal
`History` summary in `App.tsx`, `.digest-row-main:focus-visible { outline: none }` in
`styles.css`, and `postUiEvent` being called only from `Units.tsx`. They are accurate.

## Build

| Proposal | Decision | Why |
|---|---|---|
| P1 localize top nav | **Build** | The Korean page under an English nav reads as broken. It's cheap. Keep the cold-load fallback: fetch the project language from the existing v2 projects list. |
| P3 History menu descriptions | **Build** | Cheap, and fixes the only first-time-user confusion the audit found. Use visible text, not `title`. |
| P4 focus visibility | **Build option (a)** | Drop `outline: none` on `.digest-row-main` so it gets the global ring. Also check icon-only triggers (zoom −/+, ▾, ⓘ) for a visible focus ring and 3:1 contrast, and fix any failures. No new tokens. |
| P2 areas on L0 + short-view CSS | **Build** | Turns L0's blank half into a map of the digest. Cards land on **L2 with the area selected** and are real `<button>`s like `AreaPicker`. Scope the height fix to the short views; don't change `.reader-split`. |
| P6 welcome-back strip | **Build, client-only v1** | This is the "first 30 seconds" idea the cycle asked for. It uses `localStorage` and its CTA opens `DigestPicker`. It is known to be per-browser and per-project (both limits are stated in the brief). |
| P5 reviewed mark | **Build Option A (client-only, per area, with undo)** | Knowing what you have already digested is part of the mission ("digest as fast as AI produces"). It isn't an approval workflow, so it's not a direction change. A shares a small storage helper with P6. |

## Not now

- **P5 Option B** (server-side reviewed state in `unit_event`/Insights): deferred. It is a schema
  change with an unresolved mapping to the legacy `workUnitId` model. Revisit if A gets used and
  people ask for it across devices.
- **v2 instrumentation (brief §3)**: deferred to a later cycle. We verify this cycle with
  before/after screenshots, not metrics. Once v2 posts UiEvents, P2/P6's "measure" plans can run.
- **History page content localization and a projects-overview "unread" signal** stay out of
  scope, as the brief says.

## Work split

- **Issue A (Frontend): chrome and a11y.** P1, P3, P4. Small, and lands first.
- **Issue B (Frontend): reading flow.** P2, P6, P5-A. Starts after A merges (both touch `copy.ts`
  and `styles.css`).
- **Issue C (UX Reviewer): verify.** Before/after screenshots against this doc for A and B,
  reopen anything that falls short, then write `docs/ux/cycle-1-summary.md`.
- **Operator:** one real-browser (non-headless) Tab-through to confirm focus rings. The CTO asks
  for it once A and B are merged, so it covers both.

Shared rules for A and B: en/ko copy goes through `copy.ts`; no new dependencies; CSP unchanged;
tests for the new logic (language fallback, seen/reviewed storage helper, unread count). Use
synthetic projects only (`snapback`) in tests and screenshots.
