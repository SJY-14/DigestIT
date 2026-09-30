# UX cycle 2 — CTO decision (DIG-80, step 5)

Input: `audit-2.md`, `brief-2.md` (revised, 466c79a), `dig80-critique.md` and the
`proto/cycle2-b` prototype. I re-checked the brief against main (f9fb857): `useTimeline`/`useLive`
are imported only by `App.tsx`; `ProjectDto` has no latest-digest field; the provider is resolved
from `DIGESTIT_PROVIDER`/`DIGESTIT_CLAUDE_MODEL` in `apps/server/src/v2.ts` and never reaches the
client; no remove path exists anywhere. Those claims are accurate. Four points needed a change,
listed under "Changes to the brief" below.

## IA decision (journey item 5): confirmed

The product has one mental model: **all projects → project → digest → level (L0–L3)**.

- **Units, Timeline and Briefing leave the web app.** Nav, routes, pages, and the client plumbing
  that only fed them (`useTimeline.ts`, `useLive.ts`, the repo `<select>`, the Live/Polling
  badge). Old deep links (`/units`, `/timeline`, `/briefing`) **redirect to Home with
  `history.replace`** (not a 404, and they must not leave a dead entry for Back to land on).
- **Insights is demoted, not deleted.** The Board approved it in milestone 3, so deleting it is a
  direction change this cycle does not need. The route `/insights` stays. The only way to reach it
  from the UI is a secondary "Legacy insights (pre-v2 data)" link in the Settings panel, and
  that link only appears when `hasLegacyData` is true.
- **Server-side legacy routes and tables stay dormant this cycle.** Deleting them is a separate
  cleanup with its own review. It is out of scope here.
- The top nav becomes **Home**, plus **All projects** once two or more projects are registered
  (P7).

## Build

| Proposal | Decision | Notes |
|---|---|---|
| P1 History menu → Home | **Build** | As above. Finding 4 (Escape focus loss) goes away with the menu. |
| P2 first-run trust box | **Build, with corrected copy** | See "What leaves the machine" below. The brief's "the changed diff, not the whole repo" is incomplete. |
| P3 first-run two columns | **Build** | Steps plus the trust box on the left, the form on the right. Acceptance: no dead band taller than ~80px at 1440×900 or 1280×800. |
| P4 project panel + Remove | **Build** | Soft remove plus a new `digest remove` CLI command. The row component is shared with P7. Inline two-step confirm; after removing the open project, go to the next project or to first run. |
| P5 settings and trust | **Build, with a global endpoint** | Provider and model come from `GET /api/about`, not `ProjectStatusDto`. First run has no project, and P2 needs the same data there. Handle 401 separately from network errors. |
| P6 contrast | **Build, scoped to controls** | Handled inside DIG-82 (the B token pass), not here. See "Changes to the brief". |
| P7 cross-project view | **Build, as "All projects"** | Route `/projects`, shown in the nav only when there are 2 or more projects. Sorted unread first, then newest. Each row: P4's row plus the newest digest's L0 headline. Clicking a row opens that project on its newest digest. |

## Changes to the brief

1. **Provider/model/legacy flag live on a global `GET /api/about`**, not on `ProjectStatusDto`.
   The first-run screen (P2) has no project to ask about. Shape:
   `{ provider: string, model: string | null, readOnly: true, hasLegacyData: boolean }`. No paths,
   env values or tokens in it.
2. **Unread count uses `seq`, not id arithmetic.** `ProjectDto` gains
   `latestDigest: { id, seq, toAt, headline: string | null } | null`, where `headline` is the
   newest digest's L0 line (null until explained). This is one query with no N+1. `LastSeen` in
   `storage.ts` also stores `seq`. Count = `latest.seq − lastSeen.seq`. If an older entry has no
   `seq`, show a plain "New" marker. A project never opened shows `digestCount`.
3. **P6: don't darken every border.** Direction B is editorial. Its hairline dividers and card
   edges are decorative, and WCAG 1.4.11 doesn't require 3:1 for them. Controls do need it:
   inputs, selects, and buttons whose only boundary is the border. Add a control-boundary token
   at ≥3:1 against `--bg` in both themes (the brief's computed `#938b79` light / `#73695d` dark
   work) and use it on those controls. Keep `--border` as the hairline. Current and selected
   state use the accent bar (`.commit[aria-current='true']`), as the brief says. This goes to
   DIG-82 as a review note because it is a token change.
4. **P2 copy must match what the code does.** It must be verifiable against the code (the
   engineer cites file:line in the hand-off):
   - Nothing is sent until someone runs Explain, Retry or Build context (dashboard or CLI).
     Registering a project and taking checkpoints stay local.
   - When one of those runs, DigestIT sends the configured provider: the changed lines of
     tracked files (ignored files are never sent) plus a project map (file paths, README,
     manifest metadata, top-level doc headings, and the owner's optional note). Strings that look
     like secrets are redacted first (`packages/explain/src/redact.ts`).
   - Name the provider from `/api/about`. For `claude-code`, say it goes to Anthropic through
     the Claude Code CLI on this machine. For `stub`, say nothing leaves the machine.
   - DigestIT never writes to the project folder or its git history. Its data lives in its own
     data directory.
   The same read-only line appears in the Settings panel. Both strings go through `copy.ts`
   (en/ko).

## Work split

- **Issue A (Diff Engineer), server and CLI:** `GET /api/about`,
  `ProjectDto.latestDigest`, soft remove (`projects.removed_at` migration,
  `DELETE /api/projects/:id` behind the write token, `digest remove <project>`, excluded from
  lists, 404 on per-project routes, re-registering the same root restores it with history, 409
  while an Explain runs). Tests for each. No dependency on DIG-82.
- **Issue B (Frontend), IA, first run, settings and trust:** P1, P2, P3, P5. Blocked by A (it
  needs `/api/about`) and DIG-82 (both touch `styles.css`/`App.tsx`).
- **Issue C (Frontend), projects:** P4 UI and P7. Blocked by B (same files).
- **Issue D (UX Reviewer), verify:** before/after against this doc, en/ko, light/dark,
  1440×900 and 1280×800, keyboard path. Reopen anything that falls short, then write
  `docs/ux/cycle-2-summary.md` with the Board screenshots. Blocked by B and C.
- **Operator:** the real-provider acceptance run after D. The CTO asks for it once D is done.

Shared rules: B tokens (from DIG-82), en/ko copy through `copy.ts` with the lint passing, no new
runtime dependencies, CSP unchanged, WCAG AA, tests for the new logic (redirects, unread count,
remove confirm, `/api/about` gating). Use synthetic projects only (`snapback`, `my-project`).
