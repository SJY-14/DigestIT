# Direction v2: standalone project digester

Board direction DIG-33 (2026-09-26). DigestIT is a standalone tool. The user points it at a
project folder and keeps working with any AI tool. DigestIT sees only file changes. On
**Explain**, it describes what changed since the last check. The primary unit is a **digest**:
the changes between two checkpoints. Commits, branches and `DIG-n` issues become secondary.
Open decisions O1–O3 go to the Board (DIG-33 approval). The recommended option for each is
marked **(rec.)** below, and the build starts on that option.

## 1. Data model (migration 6, additive)

| Table | Purpose |
|---|---|
| `repo` + `mode` (`history`\|`project`), `context_path`, `created_at` | A **project** is a `repo` row with `mode='project'`. Existing FKs (`change_unit`, `file_change`, `explanation`, `explain_call`) keep working. The old commit history keeps `mode='history'`. |
| `checkpoint (id, repo_id, seq, shadow_sha, tree_sha, taken_at, reason init\|explain\|manual, user_head, user_branch, skipped)` | One snapshot of the project in the shadow store. `user_head`/`user_branch` are read-only info from the user's git, if any. `skipped` lists files not stored (too large, denylisted), so nothing is dropped without saying so. |
| `digest (change_unit_id PK, repo_id, from_checkpoint_id, to_checkpoint_id, created_at, stats)` | Changes between two checkpoints. It is also a `change_unit` with `kind='digest'`, so the file rows (`file_change`) and the L0–L2 explanations (`explanation`) reuse the existing tables and pipeline. |
| `area_explanation (change_unit_id, area_id, content, status, provider, model, prompt_version, input_hash, created_at)` | Lazy L3 for one L2 area. Unique on (unit, area, prompt_version). |
| `project_context (id, repo_id, checkpoint_id, content, status, source_hash, user_context_hash, provider, model, prompt_version, created_at)` | Project understanding. Latest `ok` row wins. |
| `explain_call.reason` + `digest`, `area`, `context` | Every LLM call is counted against the one daily budget. |

The types and API DTOs are in `packages/core/src/v2.ts`. `explanation` level 2 for a digest uses
`DigestL2Content`: `items[{ id, paths[], title, how, why }]`. Each `id` is the key the UI clicks to
request L3.

## 2. Shadow tracking (O1)

**(rec.) A: a separate git store in DigestIT's data dir.** Per project: `$DIGESTIT_HOME/projects/<id>/shadow.git`
(bare) with its own index file. Every call runs `git` with an argument array and sets `GIT_DIR`,
`GIT_WORK_TREE=<project>`, `GIT_INDEX_FILE`, `core.hooksPath` = an empty dir,
`core.fsmonitor=false`, and no user or global config (`GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`). A snapshot works like this:
1. List the candidates: `ls-files -z --others --modified --deleted --exclude-standard`. This
   honours every `.gitignore` in the work tree, and it works even if the project is not a git repo.
2. Drop the entries on the default denylist (the shadow's `info/exclude`: `.env*`, `*.pem`/`*.key`/`id_*`/`*.p12`,
   credentials files, `.npmrc`/`.netrc`, `node_modules/`, `dist/`, `build/`, `.venv/`, `target/`, …)
   and files over the size cap (default 1 MiB). Record the reason for each dropped file in `checkpoint.skipped`.
3. `add --pathspec-from-file` (NUL-separated) plus staging of deletions → `write-tree` →
   `update-ref refs/digestit/cp/<seq> <tree>`. A checkpoint is a **tree object**, not a commit, so
   the store never needs a git identity (`checkpoint.shadow_sha` = `tree_sha`). Uncommitted and
   untracked work is included.

Denylisted files never enter the store, so secrets are not even copied into the data dir. The
user's `.git` is never read for content and never written. Git always skips any `.git` directory
in the work tree, and nested repos are listed as not analysed. The diff is `diff-tree -p -M` between
two checkpoint trees, parsed by the existing `ingest/git.ts` parser into `file_change`, then prepared
by the existing `prepare.ts` (filter, budget, redact). A cheap "pending changes" count
(`diff --numstat` of the work tree against the last checkpoint) runs without any LLM call, so the UI
can show "12 files changed since last check". `git gc --auto` runs after a snapshot.
**B: content-addressed snapshots** (our own blob store + manifest). No git dependency, but we would
have to write and maintain our own diff, rename detection and ignore-file handling. Rejected for v2.
Both options sit behind a `ShadowStore` interface (`snapshot`, `diff`, `pending`), so the choice
can be reversed.

## 3. Context building (O2)

**(rec.)** Step 1 is local and deterministic, with no LLM: the **project map**. It holds the
tracked tree after ignores and the denylist (≤ 400 paths, then per-directory counts), the README
(≤ 8 KB), manifest names/scripts (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, …,
never lockfiles), and the headings of top-level docs. Step 2 is **one LLM call** (≤ 12k input
tokens, redacted) over the map plus the optional user `.md` (≤ 4k tokens). It returns
`ProjectContext { purpose, modules[{path, role}] ≤ 25, glossary ≤ 20, conventions ≤ 10 }`. A
compact form (≤ 1.5k tokens) of the context goes into every digest and L3 prompt as grounding.
**Refresh** happens on `init`, on manual refresh, and automatically at Explain time only when the
README, a manifest or the user `.md` changed, or when top-level directories were added or removed.
The automatic refresh runs at most once a day per project. Each build is one call against the
daily budget.

## 4. Explain, lazy L3 and budget

`digest explain` / `POST /api/projects/:id/explain`:
1. Take a snapshot. If the tree is unchanged, reply "no changes since last check" (no LLM call, no checkpoint).
2. Record the checkpoint and the digest, with its `file_change` rows.
3. If the budget allows: one call returns **L0, L1 and L2**. L2 has 1–8 areas, each saying how
   the code changed and why, with a stable `id`. If the budget is exhausted or the call fails,
   the digest still exists with status `pending`/`error` and can be retried later.

Click an L2 area → `POST /api/digests/:id/areas/:areaId/explain`. The response is cached per
(area, prompt_version). This makes one call over only that area's patches (a full budget of its own)
plus the context and the digest's L0–L2. It returns `AreaL3Content`:
- `why` (intent, ≤ 120 words), `design` (the choice made and what it replaces), and `risks` (≤ 3);
- `notes` (≤ 12), each anchored to `path:line`. The validator checks every anchor against the diff.

The grounding rules are unchanged: nothing may be claimed without support in the diff or the
context, and everything is redacted before it is sent. One daily budget (default 40 calls) covers
the context builds, the explains and the L3 clicks. The UI shows the remaining calls. Watching may
refresh the pending count, but it never spends the budget.

**Write endpoints.** Explain, L3, context refresh and project registration are POSTs. They always
require the access token, even on loopback, because another local user could otherwise spend the
budget. They also require a JSON body and an `Origin` that matches the allowed hosts (CSRF).
`digest serve` prints a one-time URL with the token, like Jupyter. A project can be registered from
the UI only under the `DIGESTIT_PROJECT_ROOTS` set by the operator. The CLI `digest init <path>`
can register any path; running it is the consent to send that project's (redacted) code to the provider.

## 5. UI flow

`/` shows the project bar: switcher, path, context status (built at, from N files, user `.md`
yes/no, Refresh), the budget meter, and a primary **Explain changes since last check** button with
the pending count. Below it is the digest timeline, newest first: L0, time span, ±stats. A digest
opens as L0 → L1 → L2 area cards. Clicking a card expands its L3: a why/design/risks block, then
the diff. Hunks of ≤ 20 lines show inline with their notes beside the anchored lines. Longer hunks
are folded to the annotated lines ±3, with "Expand" per fold and "Show all" per file. With no project,
`/` shows setup: path, optional context `.md`, Start. The old commit timeline and Insights move to a
secondary "History" menu. DIG-11 visual language, no CDN.

## 6. Migration from the current model

- The schema change is additive (migration 6). `change_unit` and `explain_call` are rebuilt only
  to widen their CHECKs, and their rows are kept. The old commit, work-unit, roll-up and insights
  data stays readable.
- The data dir moves to `$DIGESTIT_HOME` (default `$XDG_DATA_HOME/digestit`). If
  `.cache/digestit.sqlite` exists it is still used, so dev and tests keep working.
- Paperclip-specific paths are demoted. Work-unit `DIG-n` linking, handoff triggers and the briefing
  stay in code but are not in the main UI or the default `watch`. DIG-20 stays gated and low priority.
- Dogfood: DigestIT itself is the first registered project.

## 7. Open decisions for the Board

- **O1 shadow tracking:** A, a separate git store (rec.), or B, content-addressed snapshots. Files that
  are too large (> 1 MiB), binary, ignored or denylisted are skipped at snapshot time and listed.
- **O2 context:** a deterministic map plus 1 call (≤ 12k tokens) per build (rec.). Automatic
  refresh only on structural change, at most once a day. All calls count toward the daily budget.
- **O3 projects:** several registered projects with a switcher, sharing one budget, with one Explain
  running at a time (rec.). The alternative is one project per instance. Every row is keyed by
  project from day one either way.
