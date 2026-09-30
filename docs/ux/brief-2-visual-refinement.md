# UX brief 2 — visual refinement, 3 directions (DIG-72)

Board feedback on `main` (current `styles.css`, 639 lines): the app still reads as an AI
template. This is a visual-design brief, not a copy brief — `docs/ux/ai-look-audit.md` /
`ai-look-summary.md` (DIG-63/65/66/67) already cleared the *content* voice; this is the first pass
at typography, layout weight, color and detail.

## 0. The problem, read from the actual pixels

Before proposing anything, I re-read the Board's four complaints against `main`'s real rendering
(`docs/ux/screens/light-en-L0.png`, `light-en-L2.png`), not just the CSS source, because a
stylesheet can say one thing and render another.

**1. "A geometric sans (Montserrat-like) everywhere."** `styles.css:35` already sets the exact
stack the issue recommends — `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', …,
Helvetica, Arial, sans-serif` — so the code is not shipping Montserrat. But every name in that
stack except the generic keyword at the end is a **named font that has to actually be
installed** to resolve: `-apple-system`/`BlinkMacSystemFont` only exist on macOS, `Segoe UI` only
on Windows, and plain `Noto Sans` (Latin) isn't installed on this box at all (checked via
`fc-list`: only `Noto Sans CJK *` is present). On this Linux screenshot host the whole stack
**silently falls through to the browser's generic `sans-serif` default** (Liberation
Sans/DejaVu Sans here), which is a wide, geometric grotesque — visually close to what a template
generator would ship, and exactly what `light-en-L0.png` shows. **This is very likely the actual
mechanism behind the complaint**: the font *choice* in the code is already correct in intent, but
nothing about it is guaranteed to render as intended off Mac/Windows, so the "crafted" identity
disappears into whatever the OS/browser happens to have. A self-hosted, named webfont (allowed by
the issue) is the only way to make the typographic identity actually deterministic — this is
central to two of the three directions below, not an aside.

**2. "Box-in-box layout."** Real, and easy to point at: `.project-header` (`styles.css:371`),
`.digest-picker-panel`, `.graph-pane` (`:478`), `.area-card` (`:554`), `.area-glance-card`
(`:539`), `.check` (`:614`), `.hunk-block` (`:616`), `.file` (`:162`) are all `border: 1px solid
var(--border); border-radius: 6px` — nine-plus containers of identical visual weight nested and
stacked on one screen, so nothing tells the eye which border is structural (the graph viewport)
and which is just a list item that happens to have a rectangle around it.

**3. "Oversized elements."** `.l0-headline` is 28px/600 (`:526`) — bigger than any other text in
the app by a wide margin, on a page that otherwise runs 12–16px. The graph nodes are solid-filled
circles scaled continuously by change size (confirmed in `light-en-L0.png`: the two "src" nodes
are ~24px diameter filled disks) — size *is* the only channel encoding magnitude, so it dominates
the pane visually before a label is read.

**4. "Generic chrome."** Confirmed: `.areas-glance-label` and `.history-menu-label`
(`:537`,`:357`) are `text-transform: uppercase; letter-spacing: .02–.03em` — the "AREAS IN THIS
DIGEST" pattern named in the issue. `.ref`, `.badge`, `.suggestion-chip` (`:127,:242,:414`) are
`border-radius: 2em` pill shapes. `--accent: #0969da` is used for links, buttons, selected rows,
focus rings, the level-switcher key chip and the graph's changed-node fill — one color carrying
every kind of meaning (navigation, action, state, data) is the actual mechanism behind "one
generic blue for everything," not just a subjective impression.

**One more thing found while reading the CSS that's worth fixing regardless of which direction
ships**: `.level-tab[aria-selected='true']` (`styles.css:513`) uses a hardcoded `#fd8c73` (coral)
for the current-tab underline — not `var(--accent)`, not any token. It's a stray third brand
color nobody decided on. All three directions below replace it with a deliberate choice.

## 1. Method

Real content, not lorem ipsum: the `snapback` retry-backoff fixture already in the repo
(`packages/explain/test/golden/walkthrough-snapback.sample.{en,ko}.json`,
`packages/explain/test/fixtures/walkthrough-snapback.json`) — this is the same golden sample
DIG-63/67 used to blind-read the generated prose, a synthetic demo project per the repo's
public-content rules, with a real L0/L1/L2 and a full L3 walkthrough with real diff hunks in both
languages. All three prototypes show the *same* digest (`src/retry.ts` exponential backoff) so
they're comparable pixel-for-pixel, not different demos.

Each direction is a static, self-contained HTML+CSS file (no build step, no network request) at
`docs/ux/proto/visual-{a,b,c}-*/index.html`. Each covers the three requested screens — L0 with
areas, L2, L3 walkthrough — stacked in one scrollable page for easy side-by-side review, with:
- a **light/dark toggle** (top-left, proto-only chrome) that reloads via `location.hash` rather
  than mutating `data-theme` live — headless Firefox's BiDi screenshot API was observed to return
  a stale compositor tile for regions painted before a live attribute-only theme change (confirmed
  by comparing `getComputedStyle` — correct immediately — against the actual screenshot pixels —
  stale for the region that hadn't scrolled since the change). A real user never hits this; it's a
  screenshot-tooling gotcha, but worth recording for whoever takes the CTO's official screenshots:
  **reload for a theme change, don't just mutate the attribute, if you're driving a headless
  capture.**
- the **L3 walkthrough in Korean** as its own section (`#l3-ko`), using the `ko` golden sample
  verbatim, not a placeholder.

I self-verified all 12 screen/theme/language combinations by screenshot (1440×900, headless
Firefox, `FONTCONFIG_FILE` pointed at the system font set so Korean CJK glyphs render) before
sending this to Review — not just opening the files and eyeballing them.

## 2. Direction A — "GitHub-native"

**Typography.** No change to the font *choice* — the system-UI stack is the right call for a
GitHub-adjacent tool and matches what the issue's own example (GitHub) actually ships. Scale
tightened to 12/13/14/16/20/**22**px (was up to 28px), weight capped at 600 everywhere (no 700).

**Spacing.** Strict 4/8/12/16/24/32 grid, tightened from the current ad hoc values.

**Color.** Same token set as `main`, but `--accent` usage narrowed to: primary button, links,
current-tab underline, focus ring. Everything else (hover, selected row, unread) uses neutral
grays or a same-hue-as-background tint, not blue.

**Border/radius/shadow.** L2 area list and the walkthrough's "what to check" panel drop their
`border-radius:6px` boxes for **hairline row dividers** (`border-bottom` only) — a GitHub
file-list / PR-conversation pattern. `border-radius:6px` survives only on things that are real
controls or genuinely separate panels: buttons, inputs, popovers, the graph pane.

**Graph nodes.** Octicon-scale: 5–7px filled circles for files/folders (not continuously scaled
by LOC), a 2px outline ring (not a re-fill) for the selected node. Labels regain visual priority
because the marks stop competing with them.

**Chrome.** "Areas in this digest" → sentence case, 13px/600, no letter-spacing. Pills lose the
`border-radius:2em` treatment in favor of small mono tags with a hairline border and 4px radius.

**Rationale.** Lowest risk, closest to `main`'s existing bones — the fix is discipline (fewer
borders, smaller type, narrower blue) more than new tokens. It does **not** solve problem #1
above (font-stack reliability off Mac/Windows) — that's the tradeoff for staying dependency-free.

## 3. Direction B — "Editorial / documentation"

**Typography.** A **self-hosted serif for reading content** (production choice: something in the
Source Serif 4 / Charter family — open-licensed, well-hinted at UI sizes) for L0 headlines, area
titles and body prose; a single self-hosted humanist sans for UI chrome (buttons, tabs, meta
text); monospace unchanged. This prototype's font stack names the real intended faces first and
falls back through Georgia/Liberation Serif/system serif — on this screenshot host (no Source
Serif 4 installed) it visibly falls back to a plain serif and still looks like a considered
choice, not a broken one, which is itself a useful test of the fallback chain. Scale: L0 headline
30px/1.35 serif, area titles 18px serif, body/overview 15–16px/1.6, UI chrome 12–13px sans.
Prose width capped ~65–70ch.

**Spacing.** More generous vertical rhythm — 8/16/24/40/64 — with paragraph spacing tied to
line-height, not padding.

**Color.** Near-monochrome ink-on-paper (warm off-white `#fbfaf7` / warm near-black in dark, not
GitHub's cool grays), one muted terracotta accent (`#9a5b32` light / `#d99a6c` dark) for links and
current-state only.

**Border/radius/shadow.** Almost none. L2 becomes a table-of-contents-style list separated by
whitespace and a single hairline rule, not cards. The diff table keeps a background tint (its
monospace font already marks it as quoted code) with top/bottom rules only, no radius.

**Graph nodes.** Small uniform 4–5px dots, one size class, no continuous LOC scaling; labels set
in the reading serif at small size so the graph reads like a figure inside a document.

**Rationale.** The most differentiated option, and the one that most directly answers "does this
look hand-designed": borrowing the typographic discipline of a well-set technical document (line
length, rhythm, restraint) is a register that template generators essentially never reach for.
Cost: one webfont to self-host, and the reading pane's character changes more than A or C — worth
flagging to the Board explicitly, since it's the biggest departure from `main`'s current identity.

## 4. Direction C — "Quiet structure" (my own proposal)

Keeps direction A's calm, hairline-over-box bones, but adds one deliberate signature a template
wouldn't have, and fixes the "one blue for everything" complaint at its root rather than just
diluting it.

**Two-color system, not one.** `--accent` (blue) means *"this is clickable / the primary
action"* — nothing else. A new `--structure` token (warm graphite, `#8a6a3d` light / `#d9b98a`
dark, checked for AA text contrast against both surfaces) means *"this is where you are / how
things are grouped"* — the level-switcher's current-tab rule, the "Areas in this digest" label,
area-row left borders, step numbers, the selected graph node's ring. This is a direct, structural
fix for `styles.css:513`'s stray unlabelled `#fd8c73` — that accidental third color becomes an
intentional, named second one instead of being deleted back to blue.

**Typography.** One **named, self-hosted humanist sans** for everything (production choice: Inter
or IBM Plex Sans — picked and stated, not a sixteen-name fallback chain hoping something matches),
plus `font-variant-numeric: tabular-nums` everywhere a count appears, so stats/file counts/call
counters align like a real data product instead of jittering. Scale 12/13/14/15/18/22 — the L0
headline drops from 28px to 22px but gains a small muted eyebrow line above it ("Today, 09:13 · 6
files · +85 −16"), so hierarchy comes from a considered two-line combination instead of one very
large bold sentence.

**Spacing.** Strict 4/8/16/24/32/48.

**Border/radius/shadow.** Area rows and L2 items lose their all-around border; a 3px
`--structure`-colored left rule plus a flat `--bg-inset` tint takes over the grouping job, sitting
directly on the page rather than boxed. The graph pane keeps its one border deliberately — it's a
genuinely distinct viewport, not decoration, so the one remaining full border earns its keep by
contrast with everything around it that dropped one.

**Graph nodes.** Shape encodes kind, not just color: small squares for files, circles for
folders/packages, a 3-step size class (not continuous LOC scaling) so the largest node is never
more than ~2× the smallest. `--structure` ring marks the selected node (not `--fg` black, not
`--accent` blue — neither of those was free).

**Rationale.** Solves the font-reliability problem (self-hosted, named face) and the "one blue"
problem at once, with the smallest total surface change of the three — most of `main`'s bones
survive, and the new token is additive, not a repaint. Risk: a second color token is one more
thing to keep consistent going forward; worth the Reviewer's eye on whether `--structure` reads as
intentional or as a second accent competing with the first.

## 5. What I'm not proposing

- No icon set change (no Octicons import, no icon font) — none of the three directions need one;
  the current glyph-plus-word pattern for reviewed/unreviewed state (DIG-61 P5-A, kept per
  `ai-look-audit.md`'s "already clean" list) stays as-is in all three.
- No change to the reading-flow structure (L0→L3 tabs, sticky level switcher, single-scroll
  reading pane) — DIG-50/61's IA is not in question here, only its skin.
- Dark-mode token values for A are unchanged from `main`'s existing dark palette (already
  WCAG-checked per the `styles.css` comments); B and C introduce new dark values, called out
  inline above, that still need the Reviewer's contrast pass.

## 6. Open question for the Board, via the CTO

All three keep the existing L0→L3 IA and copy untouched — this is a skin decision. The one
substantive tradeoff to flag explicitly: **B and C both require self-hosting a webfont** (allowed
by the issue, no CSP change needed beyond serving a local file), while **A stays zero-dependency
but does not fix the font-reliability root cause** in §0.1. Worth the Board knowing that
distinction going in, not just seeing three pictures.
