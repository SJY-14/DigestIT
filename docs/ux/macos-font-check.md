# macOS font check (DIG-83)

We can't run macOS here, so the owner runs this check by hand. It takes about five minutes.
Direction B (`docs/ux/brief-2-visual-refinement.md` §3) self-hosts Source Serif 4, Source Sans 3
and Noto Serif KR. Only the Korean UI face and the code face come from the Mac itself.

## How

1. Open the dashboard in **Safari or Chrome** on the Mac. You need one digest written in English
   and one written in Korean. The explanation language is set in the info popover in the project
   header. It only applies to digests explained *after* you change it; older digests keep their
   language. If you have no Korean digest yet, switch to Korean and Explain one.
2. For each row below, select the text, then open the font inspector:
   - **Safari**: Develop → Show Web Inspector → Elements → select the node → the **Font** panel
     in the details sidebar lists the rendered fonts.
   - **Chrome**: right-click → Inspect → Elements → **Computed** → scroll to **Rendered Fonts** at
     the bottom. Self-hosted faces are marked "Network resource", Mac faces "Local file".
3. Compare the name shown with the Expected column. Mixed Korean/Latin text lists two fonts:
   one for the Latin glyphs and one for the Hangul glyphs. Check both.

## What to check

| Row | Where | Digest language | Expected |
| --- | --- | --- | --- |
| L0 headline | The large one-line summary at the top of a digest | English | **Source Serif 4** |
| L0 headline | Same | Korean | Hangul: **Noto Serif KR**. Latin letters and digits in it: Source Serif 4 |
| Area title | An area name in the L0 "Areas in this digest" list or the L2 list | either | **Source Serif 4** (plus Noto Serif KR for any Hangul) |
| Body paragraph | L1 prose, or an L3 step's explanation | English | **Source Serif 4** |
| Body paragraph | Same | Korean | Hangul: **Noto Serif KR** |
| Tab label | The level switcher ("L0 Summary", "L2 Structure") | English | **Source Sans 3** |
| Tab label | Same ("L0 요약") | Korean | Hangul: **Apple SD Gothic Neo**. "L0": Source Sans 3 |
| Diff line | Any code line in an L3 step's diff | either | **SF Mono** in Safari. Chrome may show **Menlo** (Chrome can't use SF Mono by name); that is fine |

The names may carry a suffix: Chrome can show "Source Serif 4 Variable" or add a weight, and Safari
can show SF Mono as "SFMono-Regular" or ".SF NS Mono". These still count as correct. If you have
installed Noto Serif CJK KR yourself, it can appear instead of Noto Serif KR. That is also fine.

## What a wrong result looks like

- **Headline, area title or body in "Times", "Helvetica", "Georgia" or ".AppleSystemUIFont".** The
  self-hosted serif didn't load (blocked request, or a build without the font files). The reading
  text falls back to generic system type, which is the look the Board originally rejected. In
  Chrome the entry would also say "Local file" where it should say "Network resource".
- **Korean headline or body with Hangul in "AppleMyungjo" or "Apple SD Gothic Neo".** The
  self-hosted Noto Serif KR didn't load. The browser used the Mac's default Korean serif or sans
  instead.
- **Korean tab label with Hangul in "Noto Serif KR".** The UI stack pulls in the reading serif,
  so the chrome would look like body text.
- **Diff line in any proportional font** (not SF Mono, Menlo or another monospace). Code columns
  no longer line up.

Report which rows were wrong and the exact name the inspector showed. A screenshot of the font
panel is enough.
