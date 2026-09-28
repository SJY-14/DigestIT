# UX v3 — reading experience redesign (DIG-47)

The Board used the v2 dashboard and reported four problems: the levels cannot be selected, L3 does
not walk through the diff, the English reads unnaturally, and the flow is inconvenient. This
document is the shared contract for the child issues. Types live in `packages/core/src/v2.ts`
(section "UX v3"). UI wording lives in `apps/web/src/copy.ts`.

## 1. Reading flow

One path: **L0 → L1 → L2 → L3**, driven by a sticky level switcher.

```
[project ▾]  [Explain 12 changes]  (ⓘ context)  (35 calls left)         ← compact header (sticky)
[Today, 17:05 · 15 files · Adds retry to uploads ▾]                      ← digest picker
Digest · Today, 17:05 › src/api › L3                                      ← breadcrumb (sticky)
[ L0 Summary | L1 Impact | L2 Structure | L3 Code ]                       ← level switcher (sticky)
┌ reading pane (the only long scroll) ─────────────┐ ┌ graph pane (fixed) ┐
│ L0: headline (L0 text, large) + stats line        │ │ auto-fit, legend,  │
│ L1: short bullets                                  │ │ hover labels,      │
│ L2: area cards → click opens that area at L3       │ │ selected area      │
│ L3: area picker, or the walkthrough                │ │ highlighted        │
└────────────────────────────────────────────────────┘ └────────────────────┘
```

- Keys: `0`–`3` switch level; `n` / `p` next/previous step in L3; `Escape` closes popovers.
  Keys are ignored while focus is in a text field or select.
- The switcher is a WAI-ARIA tablist; the current level is visually obvious (GitHub underline tab).
- L3 without an area shows an **area picker** (the L2 cards, compact), never an empty state.
- Clicking an L2 card or a graph node that belongs to one area opens that area at L3; a node that
  touches several areas opens L2 filtered to them.
- The selected level and area are in the URL (`?digest=&level=&area=&step=`), so reload and
  back/forward keep the place.
- New digest after Explain → land on it at L0.

## 2. L3 walkthrough

Replaces `AreaL3Content {why, design, risks, notes}` with `AreaWalkthrough`:

```ts
{ overview: string;                       // 2–3 sentences
  steps: { title: string;                 // ≤ 8 words
           body: string;                  // now / before / why, prose
           hunks: { path: string; hunk: number }[];   // 1-based, ≥ 1
           mechanical: boolean }[];       // at most one step is mechanical
  check: string[] }                       // "What to check", 1–5 items
```

- **Hunk numbering.** The prompt prints each file's hunks as `hunk 1`, `hunk 2`, … in patch order
  (count-aware walk, as in `difflines.ts`). The validator and the UI count the same way on the
  stored patch (`AreaDetailDto.files[].patch`). Hunks cut off by the token budget are not in the
  prompt; the UI lists them after the last step as "not covered by the walkthrough".
- **Coverage.** Every hunk in the prompt is referenced by at least one step. Renames, formatting
  and moves may be grouped in one step with `mechanical: true`. Unknown paths or hunk numbers are
  violations. After the one retry, uncovered hunks are appended to a generated "Other changes"
  step and the row is stored `truncated`.
- **Tone.** A senior engineer explaining to a colleague: concrete names (functions, flags,
  endpoints), active voice, no hedging boilerplate. "Not evident from the diff" is allowed only
  with *what* is unclear and what evidence would settle it. Prompt tests reject the phrases
  listed in DIG-47 (e.g. "may have changed", "reason not evident from the change",
  "Changed here.", "Changes in <dir>").
- The area prompt version is bumped; old `a1` rows are not shown (status `none`, regenerated on
  request).

## 3. Language

- `ExplainLanguage = 'en' | 'ko'`, per project, default `en`. Korean is first-class: same limits,
  same validator, prompt tests and a golden sample in Korean.
- All generated text (digest L0–L2, context, walkthrough overview/steps/check) is written in the
  language; code identifiers, paths and quoted code stay as written.
- The language is part of every input hash. A digest records the language it was generated in
  (`DigestSummaryDto.language`); its areas' L3 is generated in the **digest's** language, so one
  digest never mixes languages. Changing the project language affects new digests and the next
  context build; it does not rewrite old digests.
- API: `ProjectDto.language`, `PATCH /api/projects/:id {language}` (token-gated like the other
  writes). CLI: `digest init --language ko` and `digest config <project> --language ko`.
- UI chrome stays English; every string goes through `copy.ts` so a `ko` copy can be added later.

## 4. Header, picker, progress, graph

- **Header**: project switcher, one primary blue **Explain** button showing the pending count
  ("Explain 12 changes"; when nothing is pending: "No new changes", not a greyed primary), calls
  left as a small badge, context status and the language setting behind an info popover.
- **Digest picker**: dropdown/list rows "Today, 17:05 · 15 files · <L0 headline>".
- **Explain progress**: running state with elapsed seconds (`ProjectStatusDto.explainStartedAt`
  so a reload keeps the timer), then land on the new digest at L0. Errors say what failed and what
  to do.
- **Graph**: auto-fit to changed nodes on load and on digest change, fill the pane, a legend
  ("Blue: changed in this digest"; "Outlined: selected area"), hover/focus labels.
- **First-run empty states** teach: register a folder → work in it with any tool → press Explain.

## 5. Issues

| Key | Issue | Owner |
|---|---|---|
| DIG-48 | L3 walkthrough prompt + schema + validator; natural-language prompts; language in all prompts | Summarization engineer |
| DIG-49 | Language setting (storage, API, CLI, wiring), `explainStartedAt`, compact header, digest picker, Explain progress, first-run empty states, History copy | Diff engineer |
| DIG-50 | Reading flow: level switcher, L0–L3 views, breadcrumb, walkthrough UI with step nav, graph fit/legend/highlight, single scroll | Frontend engineer |

Acceptance for DIG-47 is judged on real `claude-code` output (not the stub): a temp project with a
realistic multi-file change, screenshots of L0, L1, L2, the L3 walkthrough with steps, the Korean
output, and the header during and after Explain, at 1440×900 in light and dark.
