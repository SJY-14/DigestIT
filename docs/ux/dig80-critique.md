# UX critique — of brief-2.md (DIG-80 cycle 2, step 3)

(Named `dig80-critique.md`, not `critique-2.md`: that filename is already taken by DIG-63's
critique of `ai-look-audit.md`, referenced by three other files including a test comment —
see `docs/ux/ai-look-audit.md` and `apps/web/src/copy.lint.test.ts`. Renaming that file to fit
the cycle-numbering convention would touch code comments outside this brief's scope, so this
critique gets an issue-prefixed name instead, matching the `dig71-step-code-mapping.md`
precedent already in this directory.)

Scope: DIG-80 loop step 3 (UX Reviewer). Re-checked every code citation in `brief-2.md` against
`main` on the `DIG-80-ux-cycle2` worktree (`App.tsx`, `ProjectHeader.tsx`, `DigestPicker.tsx`,
`copy.ts`, `packages/core/src/v2.ts`, `apps/web/src/v2Api.ts`, `apps/server/src/insights.ts`,
`styles.css`), independently recomputed P3's pixel measurement from the raw screenshot bytes
(not the brief's numbers) and P6's WCAG contrast ratios from the raw hex values pulled from
DIG-72's actual branch file (not the brief's arithmetic), and opened `docs/ux/proto/cycle2-b/
index.html` to confirm every mockup anchor (`#firstrun`, `#settings`, `#projects`, `#inbox`)
contains what the brief says it does. This is a well-grounded brief — most citations check out
exactly, to the line. My job here is what still breaks. Answers to the Designer's four named
questions first, then per-proposal verdicts, most severe first.

## Answers to the four questions in brief-2.md §5

**(1) Demote vs. delete Insights — demote is right, but tighten the gate.** Agree with keeping
it reachable rather than deleting it (real infrastructure, `insights.ts`'s aggregation and
`Insights.tsx`'s chart dashboard genuinely work against real data, just the *wrong* data model).
But as scoped, the "Legacy insights (pre-v2 data)" link in the settings drawer
(`docs/ux/proto/cycle2-b/index.html:228`) renders unconditionally for every install, including
ones that started clean after v2 shipped and will *never* have a single `unit_event` row. A
"legacy" label doesn't fully fix Finding 1's "looks broken" problem if it's still visible on
every install — it just moves the honest-but-empty dead end one click deeper, permanently, for
users who have no legacy data to find. `SELECT count(*) FROM unit_event` is already a trivial
query the server runs in tests (`apps/server/src/uievents.test.ts:30`); expose it as one boolean
(`hasLegacyData`) on whatever DTO backs the settings drawer, and only render the link when it's
true. New installs then never see it at all — the "already good" case (a fresh v2-only project)
gets a strictly cleaner settings surface than "demote" alone provides.

**(2) P3's pixel re-measurement — confirmed exactly, adopt as-is.** Independently decoded
`dig80-light-en-1440-firstrun-setup-form.png` (dependency-free PNG inflate, not trusting either
audit's or brief's numbers) and scanned for the card's border color (`209,217,224`) directly:
left edge x=505, right edge x=934/935 → center x≈720, dead center of a 1440px viewport, and top
edge y≈112, bottom edge y≈436 → ~464px of empty space below the card in a 900px-tall viewport.
That's a byte-for-byte match to the brief's "x≈505... x≈935... center x≈720... ~465px of dead
space." P3's correction of the audit's original horizontal-framing claim is right, and its
`.app.with-panel` / `styles.css:94`/`:373` root-cause citation is accurate on inspection.

**(3) P6's `--border-strong` values — confirmed exactly, adopt as-is.** Pulled the real hex
values from `DIG-72-visual-refinement`'s actual `docs/ux/proto/visual-b-editorial/index.html`
(not the brief's copy of them) and recomputed WCAG relative-luminance contrast independently:
border-vs-bg 1.25:1 (light) / 1.45:1 (dark), hover-vs-bg 1.08:1 / 1.06:1, selected-vs-bg 1.16:1 /
1.16:1, and the proposed `--border-strong` 3.24:1 / 3.24:1 — every one of these matches the
brief's numbers to two decimal places. The text-pair contrast claim also holds (`--muted` is the
tightest at 5.22:1/6.43:1, both well above 4.5:1). The call to leave `--hover`/`--selected` alone
and reuse `styles.css:133`'s existing `.commit[aria-current='true']` accent-bar pattern for
"current" state is correct — that rule exists exactly as cited, and the self-correction the brief
documents (hover doesn't need 3:1 under 1.4.11 because it's a redundant, mouse-only cue) is sound
reasoning, not just an assertion.

**(4) Is P7 scoped tightly enough — yes on cost, but it overlaps P4 more than the brief admits.**
Once P4 ships, the project switcher panel *already* becomes "every registered project, with an
unread count and last-activity time, in one list you open with one click" — which is most of what
Finding 7 and P7's own stated goal ask for. P7's actual marginal value over that panel is two
things: (a) it's a standing nav destination, not something you have to think to open, and (b)
each row shows the digest's L0 headline text, not just a count. That's real but it's a thin
delta for a whole second surface with its own visibility rule ("once more than one project is
registered") and its own row template, described independently of P4's row template (name +
`relativeTime` + unread badge + Remove button vs. name + L0 headline + unread count +
last-activity). Two near-identical "list of my projects" components, styled and speced
separately, is exactly the kind of duplication a Frontend engineer will build twice slightly
differently unless told not to. Recommendation: keep P7 (the cost argument holds — it's genuinely
cheap on top of P4's data), but have the brief say explicitly that the inbox row *is* the project-
panel row plus one field (the L0 headline), sharing one component, not two designs that happen to
look similar.

## Per-proposal findings

### P4 — the cited precedent for the "confirm remove" interaction doesn't exist [should fix before CTO decision]

**Problem.** P4 says the destructive Remove action should use "the same low-ceremony pattern
`DigestPicker` already uses for its own destructive-ish actions — no modal dialog needed." I
read all of `DigestPicker.tsx` looking for that pattern: it has exactly three interactive
elements — a row-select button, a retry button, and an open/close toggle — none of them
destructive, none of them two-step. I also checked the one actually-destructive action that
exists today, ignore-pattern removal (`ProjectHeader.tsx:132`, `onRemovePattern`): it's a plain
one-click button with a `disabled` state while in flight, no confirm step at all. **There is no
existing precedent anywhere in this codebase for an inline "click again to confirm" destructive
control.** The brief isn't wrong that a two-step inline confirm is a reasonable, low-ceremony
choice — it's a fine design decision on its own merits — but citing it as something that "already"
exists will send the Frontend engineer looking for a pattern to copy that isn't there, and could
plausibly cause them to under-scope the work (a copy-paste job vs. a small new interaction to
design and test). Fix: say what's actually true — no existing precedent, closest analogues are
`ProjectHeader.tsx`'s one-click remove (no confirm) and `DigestPicker`'s non-destructive retry —
and that this is a new, small pattern the engineer should build once and note as reusable for any
future destructive action.

### P1 — the fix direction under-scopes the dead code it creates [should fix before CTO decision]

**Problem.** P1's deletion list (History menu block, `HISTORY_PAGES`/`Page`/`PATH_FOR` branches,
the `units`/`insights` render branches, the `NAV` copy keys) is accurate for what it covers, but
it misses a whole subsystem that becomes unreachable once every `page !== 'main'` branch is gone:
`useTimeline()` and `useLive()` (`App.tsx:69,90`) are called only from `App.tsx`, and grepping
confirms `MainV2.tsx` (the actual v2 home) doesn't import either one — they exist purely to
drive the pages P1 deletes. Same for the repo `<select>`/single-repo name span
(`App.tsx:217–226`, gated on `page !== 'main'`) and the "Live"/"Polling" connection badge
(`App.tsx:250–254`, same gate). None of `useTimeline.ts`, `useLive.ts`, or this header UI is on
P1's deletion list. Left in place, they're dead code that still runs (the polling/WebSocket
subscription, specifically) with nothing left to display it. Fix: add `useTimeline.ts`,
`useLive.ts`, and the repo-selector/connection-badge JSX to P1's deletion list — this is UI-layer
cleanup, not the server-side "legacy tables" question P1 already correctly deferred to the
engineer.

### Minor: one citation is imprecise, not wrong

`brief-2.md`'s P5 cites `packages/core/src/v2.ts:157–162` for `ProjectStatusDto`; the interface
actually opens at line 158 and closes at line 166 (157 is its doc comment, and 162 lands mid-
interface, before `explaining`/`explainStartedAt`). Doesn't change where the two new fields
(`provider`, `model`) would go — inside 158–166 either way — so this doesn't block anything, just
flagging it since every other citation in this brief checked out exactly and this one didn't.

## What's solid — don't re-litigate

- Every other code citation checked (App.tsx's `Page`/`PATH_FOR`/`HISTORY_PAGES`/`historyMenu`/
  `closeHistoryMenu`/the outside-click-Escape effect/`nav`; `ProjectHeader.tsx`'s `close()`,
  info-popover trigger, project-switcher `<select>`, budget badge; `DigestPicker.tsx`'s own
  Escape handler; `v2Api.ts`'s `ApiError`; `copy.ts`'s `NAV_EN`/`NAV_KO`; the "no project-removal
  endpoint anywhere" and "nothing renders login/token state" grep claims; `insights.ts`'s
  `unit_event` dependency) is accurate.
- The IA decision's core framing (cut the three dead pages outright, no roadmap item exists to
  ever populate them) is correct and matches what the audit independently found.
- P2, P5, and P6's copy/token/DTO proposals are cheap, correctly scoped, and don't introduce new
  runtime dependencies — no CTO sign-off needed on that front.
- The mockup (`docs/ux/proto/cycle2-b/index.html`) genuinely contains what the brief says it
  does at every anchor checked: the first-run trust box with a provider placeholder, the settings
  drawer's read-only line and legacy-insights link, the project panel's accent-bar current-row
  treatment, and the inbox screen.

## Verdict

Approve, pending three small revisions to the brief text (not a redesign): (1) correct P4's
false "DigestPicker already does this" precedent claim, (2) add `useTimeline.ts`/`useLive.ts`/
the repo-selector UI to P1's deletion list, (3) gate the "Legacy insights" settings-drawer link
on an actual `unit_event` row existing, rather than showing it on every install. P3 and P6's
independently-verified math should ship exactly as computed. P7 should ship, explicitly sharing
its row component with P4 rather than duplicating it. None of this should require another audit
pass — these are text edits to brief-2.md and small scope additions to P1/P4/the IA decision,
ready for the CTO decision once folded in.
