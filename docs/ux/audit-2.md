# UX audit 2 — cycle 2 baseline (main @ 32104cc, 2026-09-30)

Scope: DIG-80 cycle 2, step 1 (UX Reviewer). Tested the current `main` (32104cc), which
includes cycle 1 (DIG-55–67), the fast-Explain rework (DIG-73–76) and the DIG-71 step↔code
mapping *decision* — but **not** its build (DIG-81, currently in progress by the Frontend
engineer) and **not** DIG-72's visual-refinement direction B (still open, not merged; it only
exists as static HTML prototypes under `docs/ux/proto/visual-b-editorial/`, not wired into the
app). This audit
therefore covers structure, flow, IA, copy and accessibility on **current tokens**, not
direction B's palette — a token-level contrast pass is deferred to the Designer once B lands
(see Finding 9 and the note in "What I could not verify").

**Method**: built `.cache/acc47` (main), ran the `stub` provider (content-agnostic, layout
evidence only — see limitation under Finding 5) through a purpose-built kit,
`.cache/dig80-audit/` (`run.sh` + `drive2.mjs` for the main journey, `run2.sh` + `drive3.mjs`
for first-run and budget states), driving Firefox over WebDriver BiDi at 1440×900 and
1280×800, light and dark, English and Korean. Two synthetic demo projects ("snapback", a tiny
backup CLI reused from the DIG-47 kit; "logline", a second registration for the multi-project
flow). ~70 screenshots and per-view text/API-error logs were captured; 24 are committed under
`docs/ux/screens/dig80-*.png` as evidence. Wide (1440px) screenshots were cross-checked with a
dependency-free PNG decoder (`.cache/dig80-audit/png-luminance.mjs`, `crop.mjs`) rather than
trusted from the Read-tool preview alone (known preview bug on wide/complex PNGs). Code
citations are against `apps/web/src/{MainV2,App,ProjectHeader,Reader,ProjectGraph}.tsx` and
`copy.ts`, plus a `grep` confirming no project-removal endpoint exists anywhere in the repo.

Personas used throughout: **(a)** a busy owner returning after 2 hours of unattended AI work;
**(b)** a reviewer deciding whether to accept a change; **(c)** a first-time user who has never
seen DigestIT; **(d)** a Korean-speaking user.

## What already works (verified, not re-litigated below)

- **Deep links / back-forward** (journey item 5): `/units`, `/timeline`, `/briefing`,
  `/insights` and `/?project=…&digest=…&level=…` all survive `history.back()`/`forward()` and
  a hard reload without a blank page or a crash (`docs/ux/screens/dig80-light-en-1440-reload-preserved-state.png`,
  log: `reload on http://127.0.0.1:4798/briefing now {"url":"/briefing"}`). This is real
  engineering credit — the routing is more robust than the *content* behind it (Finding 1).
- **1280×800 density**: the L3 area view (code + graph split) and the History menu render with
  no clipping at 1280 (`docs/ux/screens/dig80-light-en-1280-area-view-1280.png`,
  `dig80-light-en-1280-history-menu-open-1280.png`) — the DIG-46 regression class is still fixed.
- **UI chrome now localizes** ("Home"/"History" etc.): audit-1 Finding 1 flagged these as
  English-only; they're Korean now (`홈`, `기록` — captured live in the keyboard-trail log). Closed.
- **Reduced motion**: `styles.css` has exactly two animated rules; both are gated behind
  `prefers-reduced-motion`. One is dead code (two conflicting `.spinner` reduced-motion overrides,
  the later one wins and fully disables the spin) — cosmetic code cleanliness, not user-facing,
  noted for the Designer/Engineer but not filed as its own finding.
- **Budget accounting**: the header badge decrements per Explain/refresh call across a session
  (40 → 38 observed) and the copy for the exhausted state exists and is specific (`copy.ts`:
  `"No Explains left today · resets {time}"`) — see Finding 8 for what's still missing (I could
  not force a live 0-budget screenshot this pass — `DIGESTIT_DAILY_BUDGET=0` is treated as unset
  by `intEnv()` in `serve.ts`, which only accepts `n > 0`; this is a minor operator-facing config
  quirk, not itself a user-facing UX bug, so it isn't filed as a numbered finding).

## Findings

### 1. [blocker] The History menu is four items, three of which lead to dead or foreign-model pages — persona (c) and (b)

`docs/ux/screens/dig80-light-en-1440-history-menu-open.png` shows "OTHER VIEWS" with Units,
Timeline, Briefing, Insights presented as four equally-weighted, equally-styled alternate views
of the product. Clicking each (stub project, freshly registered via `digest init`, i.e. the
*only* path a v2 user has ever taken):

- **Units** → "0 units moved… Nothing moved in the last hour… No work units yet. **Run digest
  watch.**" (`docs/ux/screens/dig80-light-en-1440-history-units.png`)
- **Timeline** → "No commits ingested yet. **Run digest ingest.**" (`dig80-light-en-1440-history-timeline.png`)
- **Briefing** → literally "Daily and weekly briefings aren't available yet." and nothing else —
  a near-blank page (`dig80-light-en-1440-history-briefing.png`)
- **Insights** → a full chart dashboard (Map, Blind spots, Units per day…) where every metric
  reads `0` or `–` and the table says "No work units yet." (`dig80-light-en-1440-history-insights.png`)

`digest watch` and `digest ingest` are Milestone-1/2 commands from the pre-direction-v2 product
(`docs/roadmap.md` Milestones 1–3); a project registered with `digest init` (the only command
the v2 onboarding flow ever mentions — see Finding 2) will **never** populate these views. They
are not "empty because you're new," they are permanently dead for every v2 project that will
ever exist, short of an operator separately running a legacy ingestion pipeline nobody is told
about.

**Why it hurts**: persona (c) opening "History" out of curiosity — the natural thing to do on a
new product — lands on what looks like a broken feature (Insights' zeroed charts) or a
dead end (Briefing) with no explanation that these are vestigial. Persona (b), a reviewer
trying to understand what changed, might reasonably expect "Timeline" to be *the* changes-over-
time view and get "no commits ingested" instead of being pointed at the digest picker, which is
the actual place that answers that question. This is exactly the ambiguity DIG-80 item 5 was
opened to resolve, and it is currently unresolved on `main`.

**Fix direction**: this is the IA decision DIG-80 asks for. My recommendation: cut Units,
Timeline and Briefing entirely (their data model — work units, git-log ingestion, scheduled
narrative briefings — has no v2 producer and no roadmap item to build one; keeping the routes
around "just in case" is what produced this). Insights has salvageable value (it *does* compute
from real digest/review data — `docs/ux/screens/dig80-light-en-1440-history-insights.png`'s
"Local only: derived from git and viewer events" line is honest and good copy) but should either
be rebuilt against the v2 digest/area model or dropped until it is. Either way, "History" as a
grab-bag label for "other, unrelated things" should not survive; if Insights stays, it deserves
its own top-level nav entry with its own honest empty state ("Insights need a few digests first"),
not a menu shared with three dead commands.

### 2. [major] First-run never says what data leaves the machine, or when — persona (c)

`docs/ux/screens/dig80-light-en-1440-firstrun-setup-form.png`: the entire first-run copy is
*"Start your first project / 1. Register a project folder below. / 2. Work in it with any
tool… / 3. Come back and press Explain to see what changed."* (`copy.ts` `EMPTY_EN.noProjects`).
Nowhere on this screen, the ignore-suggestions step that can follow it, or the info popover
opened later (`docs/ux/screens/dig80-light-en-1440-settings-info-popover.png`) is there any
statement that pressing "Explain" sends the diff to an LLM provider, which one, or that
DigestIT never writes to the project. The closest thing anywhere in the product is the
ignore-patterns hint, which is about *ignore patterns*, not the repo: *"stored outside it.
**Never written into the project.**"* — true, but scoped to the wrong object and buried three
clicks deep (ⓘ popover → scroll past language → Ignore patterns section).

**Why it hurts**: DIG-80 names this explicitly ("Is it clear what data leaves the machine and
when?"). For a self-hosted, single-owner tool handling a user's own source code,
this is a trust-surface gap, not a nice-to-have — the first screen a brand-new user sees asks
them to point it at a folder and press a button with no stated boundary on what that button
does with the contents.

**Fix direction**: one sentence on the first-run screen, near the "Start" button: state that
Explain sends the changed diff (not the whole repo) to the configured provider, and that
DigestIT itself only reads. Surface the *provider name* too (Finding 8 — currently shown
nowhere at all).

### 3. [major] No way to remove a registered project — persona (a) and (b), journey item 6

Grepped `apps/server/src`, `apps/web/src`, `packages/core/src` for `removeProject`,
`deleteProject`, any `DELETE`-verb project route, and the CLI's own `--help` output
(`digest.js`: `ingest|watch|explain|init|ignore|projects|status|config|context|serve|token`) —
there is no remove/unregister path anywhere, CLI, API or UI, for a project once created.

**Why it hurts**: DIG-80 explicitly scopes "removing a project" as part of the multi-project
journey. A owner who registers a wrong path, renames/deletes the underlying folder, or just
wants to stop tracking a finished project has no way to get it out of the project switcher
(`docs/ux/screens/dig80-light-en-1440-project-switcher-closed.png`) — it accumulates forever.

**Fix direction**: at minimum a CLI `digest remove <project>` (soft-delete: stop showing it in
`projects`/the switcher, keep the DB rows) mirroring the existing `digest ignore` command
shape; a dashboard action can follow once the CLI path exists, matching how registration itself
started CLI-first.

### 4. [major] Escape on the History menu drops focus to `<body>` instead of returning it to the trigger — persona (d) via screen reader, general keyboard use

Scripted keyboard pass (`.cache/dig80-audit/shots/light-en-1440-keyboard.log`): focused
`.history-menu > summary`, opened it with Enter (`history menu open via keyboard? true`),
Tab'd once into the first menu item, then dispatched Escape. Result: `document.querySelector(
'.history-menu').open` correctly becomes `false`, but `document.activeElement` is `BODY` with
no class — not the "History" trigger, not the "Home" link, nothing. This is a direct DOM query,
not a screenshot artifact (headless BiDi can't reliably show focus rings at all — noted, not
relied on here).

**Why it hurts**: this is a textbook WCAG 2.4.3 (focus order) / "no keyboard trap or focus
loss" violation. A keyboard or screen-reader user who opens the menu and backs out with Escape
has to re-discover where they are by tabbing from the top of the document again — on every
close. It's a native `<details>/<summary>` element, so this isn't hand-rolled focus management
gone wrong; it's the *absence* of an Escape handler that would call `.focus()` on the summary
before/after closing it.

**Fix direction**: add a `keydown` handler on the `<details className="history-menu">` (already
has a ref, `historyMenu`, used for the outside-click close) that, on Escape, closes the menu
*and* calls `historyMenu.current.querySelector('summary')?.focus()`.

### 5. [minor, unresolved confidence] Could not visually confirm the "instant skeleton" — stub provider is too fast to observe it

Journey item 3 asks specifically about the instant skeleton and progressive fill (DIG-74–76).
With the stub provider, a screenshot taken ~600ms after clicking Explain
(`docs/ux/screens/dig80-light-en-1440-explain-skeleton.png`) already shows the **fully landed**
L0 headline, stats line and all three area cards — no placeholder text, no partial state was
observable at any sampled instant. Code confirms the placeholder machinery exists and is wired
correctly (`Reader.tsx`: `partPending()` gates `summaryWriting`/`impactWriting`/`areaWriting`
placeholders, `PartRetry` handles failed/budget-exhausted parts) — this is a testing-method
limitation, not a claim that the feature is broken. The DIG-76 real-provider acceptance kit
(`.cache/dig76-acceptance/`) is the right place to confirm the *lived* timing; I did not re-run
it here since a fresh real-provider run needs the operator (nested `claude` isn't logged in
inside the sandbox) and DIG-77 (real-provider timing/quality acceptance) already exists as an
open, separately-tracked issue for exactly this.

**Fix direction for future audits**: add a `DIGESTIT_STUB_DELAY_MS`-style env knob (dev/test
only) so layout/UX passes with the stub provider can actually observe the skeleton → progressive
→ landed sequence frame-by-frame, instead of needing a real, budget-consuming provider call
every time someone wants to eyeball the loading state.

### 6. [minor] First-run's registration card floats in the right half of the screen with a large empty void to its left — persona (c)

`docs/ux/screens/dig80-light-en-1440-firstrun-setup-form.png`: at 1440×900 the "Start your
first project" card sits right-aligned, occupying roughly the right third of the viewport; the
left ~700px is entirely blank white space below the header. This is the very first thing a
brand-new user sees.

**Why it hurts**: nothing here is broken, but visual weight/hierarchy on a first-run screen
should pull the eye to the one thing to do. An off-center card with more empty space than
content reads as unfinished or as a loading state that hasn't finished loading, and forces the
eye to travel to find the actual content.

**Fix direction**: center the setup card, or add a lightweight explanatory panel to the left
(e.g. a 3-step visual of register → work → Explain, which the copy already describes in prose)
so the layout has intentional two-column content instead of a floated card + void. Direction B
tokens/patterns (still landing via DIG-72) are a natural place to fix this once merged.

### 7. [minor] Multi-project switcher gives no context to choose between projects — persona (a)

`docs/ux/screens/dig80-light-en-1440-project-switcher-closed.png` /
`dig80-light-en-1440-project-switched-to-logline.png`: switching projects is a bare native
`<select>` of project names only (`ProjectHeader.tsx`, `select.project-switcher`) — no last-
digest date, no unread/pending count, no path, nothing to disambiguate two similarly-named
projects or tell an owner which project has waited longest for attention.

**Why it hurts**: persona (a), returning after letting AI work across multiple projects for a
couple of hours, has to switch into *each* project one at a time to find out which one has
unreviewed digests waiting — the switcher itself can't tell them. This compounds with Finding 1
(Insights, which could answer "what needs my attention across projects," is dead).

**Fix direction**: at minimum, append a pending/unread count per project in the option label
(the data already exists — the same signal the welcome-back strip uses per-project). A richer
switcher (list with per-project last-digest time) is a Designer call for brief-2.

### 8. [major] No settings surface states the provider/model or the read-only guarantee, and there's no visible login/token state — persona (a), (b), journey item 7

Full sweep of the two places any "settings" exist — `ProjectHeader.tsx`'s info popover
(`docs/ux/screens/dig80-light-en-1440-settings-info-popover.png`) and the header budget badge —
plus a grep for `login`/`token` strings in `apps/web/src`: nothing shows which explanation
provider or model is configured (the client never receives or displays it; the *only* place a
provider name would ever appear is a fallback error string, `"No explanation provider is
configured on this server."`, i.e. only when it's broken). Nothing shows the write-token/login
state — a user who lands on `/` without `?token=` has no in-app indication of *why* (the API
fails silently to the request layer; I did not find a rendered auth-state banner). And, as in
Finding 2, no explicit read-only statement exists anywhere in the running app.

**Why it hurts**: DIG-80 asks specifically that budget, provider/model, token/login state and
the read-only guarantee be visible "where users care." Budget is the only one of the four that
actually is (badge, always visible, correct — genuine credit). The other three are entirely
absent, which for a tool whose core value proposition includes "this only reads your code" is a
real trust gap for personas making a judgment call about whether to trust the tool with a real,
private repo.

**Fix direction**: this is the natural anchor for DIG-80's "settings and trust" journey item —
consolidate budget (already good), provider/model (new, read-only display), and a one-line
read-only statement into a single settings surface reachable from one predictable place (today
there are two separate popovers for related-but-different things: the ⓘ project-context popover
and the budget badge — neither is labeled "Settings").

### 9. [minor, deferred] Contrast not measured against direction-B tokens

Sampled light-vs-dark screen luminance (245.6/255 vs 25.9/255 average — correctly distinct, no
theme-detection bug) but did not run per-pair WCAG contrast ratios against specific text/
background token combinations, because the running app still uses pre-B tokens and DIG-72
(which builds direction B) is not merged (`todo`, blocked — see the scope note at the top of
this doc). Auditing colors that are about to be replaced wastes the check. **Carried forward**:
the Designer's brief-2 and the eventual build must include a WCAG AA contrast pass against
direction B's actual palette (light and dark) before this cycle's build step is called done —
this audit doesn't stand in for that.

## What I could not verify this pass

- **DIG-71 step↔code mapping** (journey item 4): `docs/ux/screens/dig80-light-en-1440-L3-walkthrough.png`
  shows the current, pre-DIG-81 L3 walkthrough (no gutter step markers or range labels yet) —
  DIG-81 (the build for DIG-71's decision) is in progress concurrently with this audit. The
  roadmap already scopes a post-merge "Reviewer's 2-second check" for that specific change;
  I did not duplicate it here.
- **Direction B visual polish** — DIG-72 is unmerged; see the note at the top of this document
  and Finding 9.
- **Real-provider Explain timing** (journey item 8) — needs the operator; DIG-77 already tracks
  this as its own acceptance issue. I relied on code + stub-provider evidence only (Finding 5).
- **Budget-exhausted UI, live** — `DIGESTIT_DAILY_BUDGET=0` doesn't force the exhausted state
  (see the note under "What already works"); the copy/disabled-retry code path is confirmed by
  reading `Reader.tsx`'s `PartRetry` component, not by a live screenshot.
