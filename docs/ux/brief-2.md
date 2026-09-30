# UX brief 2 — proposals (DIG-80 cycle 2, step 2)

Built on `docs/ux/audit-2.md` (commit f4e7eb9) plus a direct read of `App.tsx`, `MainV2.tsx`,
`ProjectHeader.tsx`, `DigestPicker.tsx`, `copy.ts`, `storage.ts`, `styles.css`, `v2.ts` (server)
and `packages/core/src/v2.ts` (DTOs), and the direction-B tokens in
`docs/ux/proto/visual-b-editorial/index.html` (DIG-72, still unmerged — see note in §0). Two
things below go beyond citing the audit: a pixel check of the first-run screenshot that corrects
its framing (P3), and the WCAG contrast math against direction B's actual tokens that audit
Finding 9 deferred (P6) — B is a static prototype file, so that math doesn't need to wait for the
merge. Every fix direction cites the line(s) it touches.

## 0. A note on direction B

DIG-72 (three visual directions) is still `todo`, unmerged, prototype-only. Per DIG-80's own
constraint ("B tokens... no new runtime dependencies without the CTO's sign-off"), every mockup
below is built with B's token file, not the app's current pre-B tokens — but the *app itself*
still runs on pre-B tokens today. This brief's fix directions describe the target component
structure (classes, copy, data) independent of which token set is live when each ships; the
Frontend Engineer should build against whichever tokens are current on `main` at build time and
re-skin for B if it lands first. The `.claude/worktrees` build (P1–P7) does not depend on DIG-72
merging first.

## 1. The problem, before the UI

Re-reading `audit-2.md`'s nine findings side by side, they cluster into two things, not nine:

1. **The product can't tell you what it is or what it's doing with your code.** Findings 1
   (a dead four-item menu), 2 (no data/provider statement at the exact moment a new user is
   deciding whether to trust this), and 8 (no settings surface names the provider, the sign-in
   state, or states "read-only" anywhere reachable) are the same failure at three different
   moments: first contact, mid-use, and "let me check what this thing actually does." A tool
   whose entire pitch is "let an AI touch my code, then trust a summary of what it did" cannot
   afford any of those three gaps — trust here isn't a nice-to-have, it's the product.
2. **The product has no memory above a single open project.** Finding 7 (the switcher can't say
   which project needs attention) and the audit's carried-forward note under cycle-1's P6 ("no
   cross-project unread signal... a known gap, not an oversight") are the same problem: cycle 1
   solved "what's new in the project I have open" (the welcome-back strip, already built and
   confirmed working); nothing solves "what's new across every project I've registered." Findings
   3 (no project removal) and 7 are two sides of the same missing surface — a real *place* to see
   and manage the roster of projects, not just switch between them one at a time.

Findings 4 (Escape focus loss), 6 (first-run layout) and 9 (contrast) are smaller and load-bearing
in their own right but don't need this framing — they're addressed directly below (P1 folds in 4,
P3 addresses 6, P6 addresses 9).

Proposals P1–P6 answer the nine findings directly. **P7 is the bolder idea** the issue asks for —
it's the one not triggered by a single finding, aimed at cluster 2 above and named explicitly by
DIG-80 as "making digesting feel effortless" for the persona who owns more than one project.

Cost tiers (same convention as `brief-1.md`): **S** = CSS/copy-only or a few lines, no new state;
**M** = new component or client state, no schema change; **L** = server schema/API change.

## 2. IA decision (journey item 5)

**Cut Units, Timeline and Briefing from the web app entirely** — nav, routes, and the pages
themselves. The audit is right that they have no v2 producer and never will short of a separate
legacy-ingestion pipeline nobody using `digest init` (the only v2 onboarding path — `copy.ts:385`,
`T.noProjects.steps`) is ever told about. Keeping them "just in case" is what produced Finding 1;
there's no roadmap item to build a producer for them (`docs/roadmap.md` has no such line), so
"just in case" has no end date.

**Demote Insights, don't promote it.** It's real infrastructure (`unit_event` table,
`insights.ts`'s aggregation, a working chart dashboard — `Insights.tsx`) but it's built on the
same legacy `workUnitId` model as Units/Timeline, not the v2 digest/area model DIG-80 wants as the
one mental model. Promoting it to a full peer nav item would just relocate Finding 1's confusion
one level up: every real v2 project would still show an honest-but-empty chart dashboard forever,
because nothing populates `unit_event` rows for a `digest init` project. My recommendation: **one
small, clearly-secondary link** ("Legacy insights (pre-v2 data)"), not in the primary nav, but
inside the new Settings surface (P5) — reachable, not deleted, honest about what it is, and out of
the way of every persona who isn't specifically looking for pre-v2 ingestion data. If/when
Insights is rebuilt against v2 digests, it earns a real nav slot at that point, not before.

**Gate the link itself on real data existing.** A project that started clean after v2 shipped will
never have a single `unit_event` row, so an unconditional link is still an honest-but-empty dead
end for every new install — one click deeper than Finding 1's problem, but not solved by it.
`SELECT count(*) FROM unit_event` is already a query the server runs in tests
(`apps/server/src/uievents.test.ts:30`); expose it as one boolean (`hasLegacyData`) on the DTO
backing the settings drawer, and render the link only when it's true. A fresh v2-only project then
never sees it at all, rather than seeing a labeled dead end forever.

**Net result**: the top nav becomes just "Home." No dropdown, no disclosure widget, nothing to
manage — which is also why this decision resolves Finding 4 for free (§3, P1).

This is a product-shape call, so it's the one piece of this brief the CTO should read as a
decision to confirm or push back on, not just a build item to approve.

## 3. Proposals

### P1 — Cut the History menu to "Home" only [S] — the IA decision, §2 above, plus Finding 4 for free

**Problem.** `App.tsx:231–248`: `<details className="history-menu">` renders "OTHER VIEWS" with
all four pages as equal-weight peers of Home. `HISTORY_PAGES` (`App.tsx:23`) drives both the menu
and the `Page` union (`App.tsx:21`) and `PATH_FOR` (`App.tsx:22`).

**Fix direction.** Delete the `<details className="history-menu">` block (`App.tsx:231–248`) and
its supporting state (`historyMenu` ref, `closeHistoryMenu`, the outside-click/Escape `useEffect`
at `App.tsx:143–158`) along with `HISTORY_PAGES`, `HISTORY_DESC_KEY`, the `units`/`timeline`/
`briefing`/`insights` branches of `Page`/`PATH_FOR`/`pageFor`, and the corresponding routes'
render branches (`App.tsx:256–274` and the `Units`/`Insights` JSX further down — grep
`page === 'units'`, `page === 'insights'` etc.). Server-side legacy tables/endpoints are not part
of this brief — that's the CTO/Frontend Engineer's call on whether to delete or leave dormant, out
of scope for a UI brief. `nav` (`App.tsx:227`) becomes a single `<a>` for Home; drop the `NAV`-
table's `history`/`otherViews`/`unitsDesc`/etc. keys from `copy.ts:161–184` (and their `_KO`
counterparts) since nothing renders them anymore.

**Also delete: the client-side plumbing that only existed to feed those pages.** Once every
`page !== 'main'` branch is gone, `useTimeline()` and `useLive()` (`App.tsx:69,90`) have no
caller left — both are used only from `App.tsx`, and `MainV2.tsx` (the actual v2 home) imports
neither. Left in place they're dead code that still runs (the polling/WebSocket subscription,
specifically) with nothing left to display it — delete `useTimeline.ts`, `useLive.ts`, and their
call sites. Same for the repo `<select>`/single-repo name span (`App.tsx:217–226`) and the "Live"/
"Polling" connection badge (`App.tsx:250–254`): both are gated on `page !== 'main'` and exist only
to serve the pages this proposal removes. This is UI-layer cleanup, distinct from the server-side
"legacy tables" question above, which stays the engineer's call.

**Finding 4, resolved as a side effect.** The audit found `closeHistoryMenu` (`App.tsx:144`)
doesn't refocus the trigger on Escape — unlike its two siblings, which already do this correctly:
`ProjectHeader.tsx:89–94`'s `close()` (`el.querySelector('summary')?.focus()`) and
`DigestPicker.tsx:75–80`'s own Escape handler. Deleting the History menu removes the one outlier;
the other two dismissible surfaces already pass. **If any future nav item needs a disclosure
widget again** (e.g. if Insights is ever promoted back to a menu), mirror
`ProjectHeader.tsx:89–94` verbatim rather than re-deriving it — don't reintroduce this bug a
second time.

**Mockup.** `docs/ux/proto/cycle2-b/index.html#settings` (screen 2) shows the resulting header:
`DigestIT | Home` — no menu.

**Expected effect.** Removes every dead-end a first-time user (persona c) or a reviewer (b) could
click into out of curiosity; removes the only focus-loss bug found this cycle.

**Measure.** Binary: no route in the app resolves to a page that says "not available yet" or shows
all-zero charts for a real project. Verified by the Reviewer re-visiting the four now-removed
paths and confirming a 404 or redirect, not a screenshot diff.

### P2 — State what Explain sends, and to whom, at first run [S] — Finding 2

**Problem.** `MainV2.tsx:104–109` (`SetupForm`) renders only `T.noProjects.heading` and
`T.noProjects.steps` (`copy.ts:385–401`) — three steps, none mentioning what leaves the machine.
The only existing "never written into the project" line is scoped to ignore patterns
(`ignoreCopy`, reachable from Settings, three clicks deep), not to the repo itself.

**Fix direction.** Add a `firstRunTrust` entry to `copy.ts` (English/Korean, same table pattern as
`noProjects`) with two sentences: what Explain sends (the changed diff, not the whole repo, to
the configured provider) and what DigestIT itself never does (write to the project). Render it as
a distinct box next to the setup form — not another list item, so it reads as a boundary
statement, not step 4. Needs the provider name available client-side, which doesn't exist yet
(§ P5 covers the one small server addition this needs — both P2 and P5 read from the same new
field, ship together).

**Mockup.** `docs/ux/proto/cycle2-b/index.html#firstrun` — the "WHAT EXPLAIN SENDS" box.

**Expected effect.** Answers DIG-80's own question ("is it clear what data leaves the machine and
when?") at the one moment it matters most: before a brand-new user points this at a real,
possibly-private repo.

**Cost.** S. One new copy entry + one static box; depends on P5's provider-name field (S) shipping
in the same change.

**Measure.** Binary: the string is present and correct on the first-run screen in both languages.
Not worth instrumenting further.

### P3 — First-run: two columns that use the space, not a floated card [S/M] — Finding 6, corrected

**Problem, re-measured.** I cropped `dig80-light-en-1440-firstrun-setup-form.png` (0–720px and
720–1440px halves) rather than trust the audit's framing. The card's left edge sits at x≈505, its
right edge at x≈935 — **its center is x≈720, the exact center of a 1440px viewport. It is already
horizontally centered**, not right-aligned with "700px of blank space to its left" as the audit
described. What's actually true, and the real problem: the card spans only y≈100–435 of a 900px-
tall viewport, leaving **~465px of dead space below it** — a vertical whitespace problem, not a
horizontal one. Root cause: `App.tsx:214` gives the `main` page `'app with-panel home'`
(`.app.with-panel { max-width: 1600px }`, `styles.css:94`) even when there's no project and thus
no graph panel to reserve width for — `.setup { max-width: 480px; margin: 48px auto }`
(`styles.css:373`) then centers a small fixed box inside a container sized for a panel that isn't
there, in both dimensions.

**Fix direction.** Don't just center-tweak the existing card — give the screen a second column
that earns the width and roughly matches the form's height, so the layout reads as intentional
two-column content instead of a card floating in extra room. Left column: the existing 3-step
list (already in `T.noProjects.steps`) rendered as a lightly illustrated sequence (numbered
circles + connecting rule, no new icons/images — CSS only) **plus P2's trust box directly below
it** — the trust statement is content that belongs here anyway, and using it to fill the left
column's height means P2 and P3 solve two findings with one layout change, not two unrelated
patches to the same screen. Right column: the unchanged `SetupForm` fields, given a defined card
height via `align-self: stretch` inside a flex row instead of `margin: 48px auto` block-centering.

**Mockup.** `docs/ux/proto/cycle2-b/index.html#firstrun` (screen 1) — `.firstrun`/`.fr-explain`/
`.fr-steps`/`.fr-trust`/`.fr-form` in the prototype's `<style>` block show the concrete structure;
port the class shapes, not the literal CSS (tokens will follow whichever palette is live, §0).

**Expected effect.** The first screen a brand-new user sees stops reading as unfinished or
mid-load (audit's original intuition was right about the symptom, even though the horizontal
diagnosis was off) — both dimensions now hold content that does real work (explaining the product
+ stating the trust boundary), not empty space.

**Cost.** S/M: mostly CSS restructuring of an existing component; the step-list becomes a small
presentational component (no new data, `T.noProjects.steps` already has the content).

**Measure.** Before/after screenshot at 1440×900 and 1280×800; confirm no dead space taller than
~80px below the fold in either column.

### P4 — Project panel: switcher gains context and a Remove action [M/L] — Findings 3 & 7

**Problem.** `ProjectHeader.tsx:256`: `<select className="project-switcher">` lists project names
only — no last-activity, no pending/unread signal, no way to remove a project. Grepped
`apps/server/src`, `apps/web/src`, `packages/core/src` and the CLI's own `--help`
(`ingest|watch|explain|init|ignore|projects|status|config|context|serve|token`) — no
remove/unregister path exists anywhere, confirming the audit's Finding 3.

**Fix direction.** Replace the bare `<select>` with a small panel, built the same way as the two
overlays that already exist and already handle Escape/outside-click/refocus correctly
(`DigestPicker.tsx`, `ProjectHeader.tsx`'s own info-popover, `ProjectHeader.tsx:82–100`) — reuse
that pattern verbatim rather than re-deriving it a third time (see P1's Finding-4 note). Each row:
project name, `relativeTime(lastCheckpointAt)` (already in `ProjectDto`, `packages/core/src/v2.ts:
120–128`), an unread badge, and a Remove button. Mark the current project the same way
`styles.css`'s `.commit[aria-current='true']` already does — an accent-colored bar
(`box-shadow: inset 2px 0 0 var(--accent)`), not a background tint alone (P6 below explains why).

**The unread count needs one new field.** `ProjectDto` has `digestCount` but not a per-project
"latest digest id" the client can diff against `storage.ts`'s existing `lastSeenKey`/`getLastSeen`
(the same mechanism the cycle-1 welcome-back strip already uses, `MainV2.tsx:189`
`unseenDigests`). Add `latestDigestId: number | null` to `ProjectDto` (server: one more column in
the existing per-project query, `apps/server/src/v2.ts` — cheap, no new table) so the switcher (and
P7's inbox) can compute "N new" for every project without opening each one. This is the one part
of P4 that's server-side (**L** for that piece only); everything else is client (**M**).

**Remove, mechanism.** Soft-delete, mirroring `digest ignore`'s existing shape: a CLI
`digest remove <project>` (stops it appearing in `projects`/the switcher, keeps DB rows — matches
how registration itself started CLI-first before the dashboard form existed) plus the dashboard
Remove button calling the same new endpoint. A destructive action needs a confirm step — a second
click turning "Remove" into "Confirm remove?" inline, no modal dialog needed for a reversible
soft-delete. **No existing precedent for this in the codebase**, corrected from an earlier draft
that cited one: `DigestPicker.tsx` has three interactive elements (row-select, retry, open/close
toggle), none destructive, none two-step; the one real destructive action today,
`ProjectHeader.tsx:132`'s ignore-pattern remove, is a plain one-click button with a `disabled`
state while in flight and no confirm step at all. The inline two-step confirm above is still the
right call on its own merits (low-ceremony, matches the reversible soft-delete underneath) — it's
just new, not a copy-paste of something already built. The Frontend Engineer should build it once
here and treat it as the reusable pattern for any future destructive action, rather than searching
for one that doesn't yet exist.

**Mockup.** `docs/ux/proto/cycle2-b/index.html#projects` (screen 3).

**Expected effect.** Closes Finding 3 outright; closes Finding 7 by surfacing the same "N new"
signal the welcome-back strip already trusts, one level up, where a decision (switch or not) is
actually made.

**Cost.** M (panel component, reusing existing overlay pattern) + L (one DTO field, one soft-
delete endpoint, one CLI command). Ships as one change — the panel is useless without the data.

**Measure.** Before/after: switching projects when the target has unread digests no longer
requires opening it first to find out. Removing a project: it disappears from the switcher and
`GET /api/projects` immediately, confirmed by a test, not a screenshot.

### P5 — Settings & trust: one surface for budget, provider/model, sign-in state, and "read-only" [S/M] — Finding 8

**Problem.** Two unrelated popovers today: the ⓘ info-popover (`ProjectHeader.tsx:146–148`,
context status + language + ignore patterns) and the budget badge (`ProjectHeader.tsx:266–270`,
its own tooltip). Neither is labeled "Settings." Grepped for `login`/`token` in `apps/web/src` —
nothing renders sign-in state; `apps/web/src/v2Api.ts:8` (`ApiError`) already carries `res.status`,
so a 401 is distinguishable client-side, it's just never checked for. Provider/model is resolved
entirely server-side (`apps/server/src/v2.ts:141–152`, `DIGESTIT_PROVIDER`/
`DIGESTIT_CLAUDE_MODEL` env vars) and never sent to the client in any DTO.

**Fix direction.** Relabel the ⓘ trigger "Settings" (still one line, per `ProjectHeader.tsx:1–4`'s
stated header-height constraint) and fold the budget badge's content into the same panel as a
line item (the badge itself can stay in the header too — this isn't removing the at-a-glance
number, it's giving it a second, fuller home). Add to `ProjectStatusDto`
(`packages/core/src/v2.ts:158–166`) two read-only fields: `provider: string` and
`model: string | null` (from the same `providerFactory` config already resolved per-request,
`v2.ts:141–152` — no new lookup, just returning what's already computed). Add a one-line
read-only statement as a static copy string, not conditional on anything — it's always true:
"DigestIT only reads this project. It never writes to your files or commits to your repository."
For sign-in state: in the top-level fetch-error boundary (`MainV2.tsx:736`,
`projectsError`/`TS.projectsLoadError`), special-case `error instanceof ApiError &&
error.status === 401` with a distinct message pointing at needing an access link from the
operator, instead of the current generic network-error string.

**Mockup.** `docs/ux/proto/cycle2-b/index.html#settings` (screen 2) — the `.settings-drawer`.

**Expected effect.** Closes the three-of-four-absent gap Finding 8 named. Budget was already good
(audit's own credit); this brings provider/model, sign-in state and the read-only line to parity,
in the one place someone making a trust judgment would look first.

**Cost.** S/M: one relabel, one new copy string (read-only line, en/ko), two new response fields
(server, cheap), one `status === 401` branch (client).

**Measure.** Binary: all four of budget/provider/sign-in/read-only are visible from one entry
point, verified by a screenshot checklist, not a metric.

### P6 — Direction B's component borders fail WCAG 1.4.11; fix the border, not the hover wash [S] — resolves Finding 9

**Problem.** Finding 9 deferred contrast math until B's tokens were worth measuring against. I ran
it now, since `docs/ux/proto/visual-b-editorial/index.html`'s tokens are a fixed, already-written
file — no need to wait for the merge to check arithmetic. Text-pair contrast is fine everywhere
(`--fg`/`--muted`/`--accent`/`--add`/`--del` against `--bg`/`--bg-inset` all clear 4.5:1, in both
themes, several comfortably above 5:1). `--border` vs `--bg` is 1.25:1 (light) / 1.45:1 (dark) —
WCAG 1.4.11 requires 3:1 for the boundary of a real UI component (a button, an input, a panel
edge), so every card/button/field edge B defines is roughly 2× under threshold, in both themes.

**I initially over-reached this finding and want to flag my own correction, not just the fix.**
My first pass also flagged `--hover` (1.08:1/1.06:1) and `--selected` (1.16:1/1.16:1) as 1.4.11
failures and proposed forcing both to 3:1 too. Checking the actual hex values I'd picked against
the relative-luminance formula (not just eyeballing them) showed they *didn't* clear 3:1 either —
which is what caught the deeper problem: forcing a hover-only background wash to 3:1 makes it look
like a solid color block, not a subtle highlight, and 1.4.11 doesn't actually require it — hover
is a supplementary, mouse-only cue, redundant with the cursor and with the focus-visible ring
keyboard users already get (cycle 1's P4 already made that ring compliant). "Selected/current"
state is a closer call — it *is* a required-to-identify state — but the existing app already has
the right pattern for it: `styles.css`'s `.commit[aria-current='true'] { background:
var(--selected); box-shadow: inset 2px 0 0 var(--accent); }` uses the accent-colored bar (already
5:1+ against `--bg` in both themes) as the real indicator, with the background tint staying
decorative. So the fix is one token, not three, plus reusing an existing pattern rather than
inventing a new one.

**Fix direction.** Darken (light) / lighten (dark) `--border` until it clears 3:1 against `--bg`.
Computed (not eyeballed) via the WCAG relative-luminance formula: light `#938b79` → 3.24:1 against
`#fbfaf7`; dark `#73695d` → 3.24:1 against `#1b1a17` — both keep the same warm-neutral hue as the
rest of B's palette, just darker/lighter. See the `:root`/`html[data-theme="dark"]` blocks in
`docs/ux/proto/cycle2-b/index.html` (`--border-strong`) for the exact values, with a comment
marking this as a fix for `--border` itself, not a new token to keep long-term. **Any new
"current/selected" indicator this cycle adds (P4's project-panel row, in particular) should copy
`.commit[aria-current='true']`'s accent-bar pattern**, not rely on a background tint alone.
`--hover` and `--selected` are otherwise left as B already defines them — no change proposed.

**Mockup.** `docs/ux/proto/cycle2-b/index.html` — component borders (buttons, inputs, the settings
drawer and project panel's edges) use `--border-strong`; `.proj-row.current` shows the accent-bar
treatment.

**Cost.** S. One hex value changes in one place (DIG-72's `--border`) if the value above holds up
in critique; every component built on top inherits the fix automatically.

**Measure.** `--border-strong` vs `--bg` ≥ 3:1, both themes — pass/fail, computed, not a visual
judgment call. Not worth a permanent automated test for one static hex pair, but worth the
one-line comment already in the token file (see mockup) so it doesn't quietly regress under 3:1
later.

### P7 (bold) — A cross-project inbox: "what needs me," not "what's open" [M/L] — not triggered by a single finding

**Reasoning.** DIG-80 names persona (a), the busy owner, first for the same reason cycle 1 did.
Cycle 1 solved "what happened in the project I have open" (the welcome-back strip — confirmed
built and working, `storage.ts`, `MainV2.tsx:339–365,929–933`). It explicitly named the gap one
level up as out of scope: *"a busy owner with 3+ projects running unattended still has to visit
each one to discover which have anything new... out of scope for v1... a known gap, not an
oversight"* (`brief-1.md` §P6). That gap is now this cycle's journey item 6 (multiple projects)
and exactly the shape of DIG-80's "effortless digesting" ask — checked there's still nothing built
for it: no `unread`/cross-project aggregation anywhere in `MainV2.tsx`/`App.tsx` beyond the
single-project strip.

**Fix direction.** A new top-level view — reachable as a second nav item next to "Home" once more
than one project is registered (a single-project install has nothing to triage, so it should stay
hidden rather than show a list of one) — listing every registered project sorted **unread-first,
then most-recent**. **The row is P4's project-panel row component, not a second design**: same
name/`relativeTime`/unread-badge template, plus one added field (the newest digest's one-line L0
headline, already fetched per project's latest digest — reuses P4's `latestDigestId`, not a new
call). Build one row component, shared by both surfaces; the inbox's Remove button can stay
hidden there (row-removal belongs to the switcher's management context, not the triage view) via
a prop, not a fork. A project with nothing new since last visit still appears, just visually
quieter ("You're caught up"), so the list is a complete roster, not just a worry list. Clicking a
row opens that project on its newest digest, same as the switcher does today.

**Why this and not just a richer switcher.** P4 already puts "N new" *inside* the switcher, which
answers "does this specific project have something new" once you've opened the dropdown. It
doesn't answer "across everything I own, where should I spend the next five minutes" without
opening the switcher on every project in turn to compare. The inbox is the same underlying data
(P4's `latestDigestId` + P4's per-project unread math) at a different altitude: a landing page for
comparing, not a control for choosing. They're complementary, not duplicate — P4 ships regardless
of whether P7 is approved; P7 has no reason to exist without P4's data underneath it.

**Scope, named explicitly.** Client-side sort/render only; the "unread" signal is still per-
browser `localStorage` (same limitation P4 and cycle-1's P6 already accepted — stated once here,
not re-litigated). No new schema beyond P4's `latestDigestId` field, which this reuses rather than
duplicating.

**Mockup.** `docs/ux/proto/cycle2-b/index.html#inbox` (screen 4).

**Expected effect.** This is the proposal DIG-80 asked for by name — "making digesting feel
effortless" for someone who let AI work across several projects and is now triaging, not reading
one thing at a time. It turns "check each project" into "read one list, top to bottom."

**Cost.** M/L: one new route/view (M, client-only, no new component patterns — reuses P4's row
styling) sitting entirely on top of P4's `latestDigestId` field (the L part of the cost was
already paid by P4; P7 doesn't add its own server change).

**Measure.** The same clean prediction cycle-1's P6 proposed and never got to instrument (v2 still
posts no UI events, per `brief-1.md` §3, unchanged this cycle): time from landing to opening the
project that actually needed attention should drop for an owner with ≥2 projects carrying unread
digests, versus visiting each project to check. No instrumentation exists yet to measure this
live — noted as a prerequisite, not solved by this proposal, same as cycle 1 left it.

## 4. Not proposed

- **Insights rebuilt on v2 data.** Real, valuable, and explicitly out of scope this cycle (§2) —
  demoted, not deleted, so it stays possible.
- **Server-side "reviewed" state (cycle-1 P5 Option B).** Cycle 1 already deferred this; nothing
  in this cycle's audit reopens it.
- **A richer digest-picker or graph redesign.** Neither surfaced as a finding this cycle; DIG-71/
  DIG-81 already own the L3 step↔code mapping work in flight concurrently with this brief.
- **Real cross-device "unread."** P7 and P4 both inherit the per-browser `localStorage`
  limitation already named and accepted in cycle 1; making it authoritative across devices would
  need a server-side read-state table, a bigger schema change not justified by this cycle's
  findings.
- **Deleting the legacy server routes/tables behind Units/Timeline/Briefing.** P1 only removes the
  web app's nav/routes/pages. Whether to also delete the now-unreachable server code and DB tables
  is an engineering call for whoever builds P1, not a UX decision — named here so it isn't silently
  assumed either way.

## 5. Handoff

**Revised per `docs/ux/dig80-critique.md` (commit 02f7540) — approved pending these edits, now
folded in, no re-audit needed:**

1. §2 (IA decision): the "Legacy insights" settings link is now gated on a `hasLegacyData` boolean
   (`unit_event` row existing) rather than rendered unconditionally on every install.
2. P4: removed the false claim that `DigestPicker` already has a two-step destructive-confirm
   pattern — it doesn't; the inline confirm is a new pattern, stated as such, with the real
   closest analogues cited instead.
3. P1: added `useTimeline.ts`, `useLive.ts`, and the repo-selector/connection-badge header UI to
   the deletion list — all dead code once every non-Home page is removed, all missed in the first
   draft.
4. P7: the inbox row is now specified as P4's project-panel row component plus one field (the L0
   headline), built once and shared, not described as two independent row designs.
5. Minor: P5's DTO citation corrected from `v2.ts:157–162` to `:158–166` (doesn't change scope).

P3's pixel re-measurement and P6's contrast math were independently re-verified by the Reviewer
and ship exactly as originally computed — no changes.

Reassigning to the CTO for the direction decision, per the DIG-80 loop (audit → brief → critique →
revision → **CTO decision** → build → verify). The one product-shape call to confirm or push back
on is still §2 — demote (not delete) Insights, gated behind `hasLegacyData`. Everything else here
is a build item, not a decision. The `.claude/worktrees/DIG-80-ux-cycle2` worktree holds the full
history (audit f4e7eb9, brief 1834558, critique 02f7540, this revision) if you want to read the
loop in order rather than just this file's current state.
