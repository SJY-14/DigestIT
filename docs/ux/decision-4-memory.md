# "What DigestIT knows" — CTO decision (DIG-102, step 3)

Input: `brief-4-memory.md`, `critique-4-memory.md` and `proto/memory/index.html`. I checked the
brief and the critique against `packages/core/src/memory.ts`, `docs/milestone-4-memory.md` and the
DIG-103 scope. The critique's findings are right. Findings 2 and 4 and the pinned row from Finding 3
are already fixed on this branch (prototype toggle is a `<button aria-pressed>` with no
`role="switch"`, one pinned row with `Unpin`, `styles.css:675`). The other changes are listed below.

## Decision: build the brief, with the changes below

Accepted as written: IA placement (§2: no new nav entry, `/memory?project=` as a real route, the
link in the Settings popover always visible, the per-digest line under L0), page anatomy as a plain
document reusing `.area-cards`, source badges and status (§4), the per-digest view without
Delete (§5), undo/export/clear as inline two-step controls (§6), both empty states (§7), keyboard
and screen-reader rules (§8), and the open item on the always-visible link (yes, keep it).

## Changes to the brief

1. **"Used in N digests" must count digests (critique F1, option b).** `usedCount` counts prompts
   for the current version only, so it is both inflated and reset by every re-extraction. Contract
   change, owned by DIG-103: `memory_use` rows record the digest (`change_unit_id`) and the prompt
   part (`summary` / `area` + area key / `walkthrough` + area key). `MemoryItemDto.usedCount` is
   replaced by `usedInDigests: number` (distinct digests whose prompts used any version of the
   item). Copy: "used in {n} digests"; hidden when 0.
2. **Per-digest endpoint shape** (answers the brief's open item 1). `GET
   /api/digests/:id/memory-used` returns `{ digestId, items: (MemoryItemDto & { usedVersion:
   number; usedFor: { part: 'summary' | 'area' | 'walkthrough'; area: string | null }[] })[],
   droppedForBudget: number }`. `usedFor` is deduplicated (walkthrough steps of one area collapse to
   one tag). When `usedVersion < version`, the row says "changed since this digest"; the page shows
   the current item, not the old text. `droppedForBudget` is the sum over the digest's prompts and
   is shown as "{n} more were left out for space" (no names; the brief's known gap stands). The L0
   line fetches this endpoint lazily and is omitted when `items` is empty.
3. **Usage counts runs, not summaries (critique F1, secondary).** "Today: {jobsToday} of {share}
   background summary runs, shared across all your projects." The Settings popover shows the same
   short line next to the link ("Background summaries: 2 of 4 runs today"), as the milestone doc
   asks.
4. **Pinned state (critique F3).** Meta row starts with "Pinned" (text, not an icon alone); the
   action reads `Unpin` while pinned (`aria-pressed` is not used here: the label flips, like
   `.proj-remove`). Pinned items sort first.
5. **Row order and length.** Within a kind: pinned, then stale, then by `usedInDigests`
   descending, then key. Each section shows its first 20 rows and a "Show all {n}" button. The
   filter searches all rows, including the collapsed ones. Terms can reach 300, so the page must not
   render as one wall.
6. **The Correct flow was not specified.** Correct opens an inline form under the row: a labelled
   `<textarea>` ("What is right instead", ≤ 2,000 characters, counter), `Save` and `Cancel`. Escape
   or Cancel closes it and returns focus to the Correct button; Save creates the note (`POST
   /api/memory/:itemId/correct`), the row switches to "Overridden by your note →" and focus moves to
   the new note. Correct is offered on threads too (a wrong grouping is what produces a wrong
   "continues" claim); it is not offered on notes.
7. **Editing notes.** Correction notes: `Edit` reuses the same inline form (DIG-103 adds text to
   `PATCH /api/memory/:itemId` for `user`-source notes only). Notes from the context file: no Edit;
   the meta row says "from your context file — edit it there". Pin and Delete work on both.
8. **Privacy copy must match what is sent.** The brief's "nothing beyond what Explain already
   sends" is not accurate: an area summary sends names and README text of folders the diff may not
   touch. Two lines, both through `copy.ts`, both verified against the code with file:line in the
   hand-off:
   - Always shown, top of the page: "Stored on this host. When you Explain, the items that match
     the change are sent to {provider} with it." For `stub`: "Nothing leaves this machine."
   - Under the switch: what DIG-101's `memory` task prompt contains (draft: "a folder's exported
     names, what it imports and the first paragraph of its README, or the one-line summaries of a
     line of work; file contents and diffs are not sent"), the provider from `/api/about`, and "up
     to {share} runs a day across all projects".
9. **Clear is irreversible; say so.** "This deletes all {n} items for {project} and can't be undone.
   Export first if you may want them back. Digests you've already read are not affected." Undo does
   not cover Clear.
10. **Language.** The page lists items in the project's Explain language plus items with
    `language: null`. It does not mix en and ko prose.
11. **Failed writes.** A 401 on any action shows the existing `unauthorized` copy (`copy.ts`)
    inline on that row or control; other errors show the action's own retryable message. The row
    keeps its previous state; nothing is updated optimistically.

## Work split

- **DIG-103 (Diff Engineer), already scoped:** add changes 1, 2 and 7 (the `memory_use` digest and
  part columns, `usedInDigests`, the `memory-used` shape, note text edit). If DIG-100's migration
  lands first, the columns go in DIG-103's migration. A comment on DIG-103 carries this.
- **New Frontend issue (after DIG-103 merges):** the page, the Settings link and usage line, the
  L0 line, all of the above. Acceptance: en/ko, light/dark, 1440×900 and 1280×800, keyboard-only
  path through Correct/Pin/Delete/Restore/Undo/Clear, screen-reader labels checked, copy lint
  passing, tests for sorting, the two-step confirms and the Correct form. Fixtures only (`snapback`,
  `my-project`). Blocked by DIG-103.
- **UX Reviewer verify** after the Frontend issue, against this doc and the prototype.
