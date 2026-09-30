# macOS font check (DIG-83)

We can't run macOS here, so this is a check for the owner to run by hand. It takes about two
minutes. Direction B (`docs/ux/brief-2-visual-refinement.md` §3) self-hosts two Latin faces, so
only Korean UI chrome and code depend on what's installed on your Mac.

## How

1. Open the dashboard in **Safari or Chrome** on the Mac, on any digest, in both English and
   Korean (the language switch is in the info popover next to "Digests:").
2. For each row below, select the text named, then open the browser's font inspector:
   - **Safari**: Develop menu → Show Web Inspector → Elements tab → select the text → the Fonts
     pane on the right shows "Rendered Fonts."
   - **Chrome**: right-click the text → Inspect → Elements tab → Computed tab → scroll to
     "Rendered Fonts" near the bottom.
3. Compare the name shown against the "Expected" column.

## What to check

| Row | Where to click | Language | Expected rendered font |
| --- | --- | --- | --- |
| L0 headline | The large one-line summary at the top of a digest (e.g. "Retries now back off exponentially...") | English | **Source Serif 4** |
| L0 headline | Same, after switching to Korean | Korean | **Source Serif 4** (Latin is self-hosted regardless of language; a Korean headline is still set in the serif stack, it just has no Hangul glyphs to fall through) |
| Area title | A file/area name in the L2 list or an L0 area card (e.g. "retry.js") | English | **Source Serif 4** |
| Body paragraph | The L1 "what changed" prose, or an L3 step's explanation text | English | **Source Serif 4** |
| Body paragraph | Same, in Korean | Korean | **Noto Serif KR** for the Hangul characters (Source Serif 4 has no Hangul glyphs, so the browser falls through to the next serif in the stack) |
| Tab label | "L0 Summary" / "L2 Structure" etc. in the level switcher | English | **Source Sans 3** |
| Tab label | Same tab labels in Korean ("L0 요약" etc.) | Korean | **Apple SD Gothic Neo** for the Hangul characters (there is no self-hosted Korean sans; the stack falls through to the platform's Korean UI face) |
| Diff line | Any line of code in an L3 step's diff | either | **SF Mono** |

## What a wrong result looks like

- **Any row showing "Helvetica," "Arial," ".AppleSystemUIFont," or "LucidaGrande" for the L0
  headline, an area title, or a body paragraph** — the self-hosted serif failed to load (network
  block, CSP change, or a build that dropped the font files). This is the regression the
  Board originally flagged: the reading text would look like generic system UI again, not a
  considered serif.
- **The Korean body paragraph or tab label showing a Latin fallback face** (e.g. Times, Helvetica)
  **instead of a Korean-specific name** — the Hangul glyphs are being rendered by a font that
  doesn't actually have them (the browser is showing its own tofu/fallback box glyphs), or the
  platform's Korean font is missing entirely.
- **The Korean tab label showing "Noto Serif KR" instead of "Apple SD Gothic Neo"** — the UI
  chrome stack is accidentally pulling in the reading serif for a role that should be sans.
- **The diff line showing a proportional font** (anything other than a monospace name) — code
  would no longer align, which breaks the point of a diff view.

Report back which rows (if any) showed a wrong font, with the exact name the inspector gave.
