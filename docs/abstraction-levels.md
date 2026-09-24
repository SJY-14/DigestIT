# Abstraction levels (L0–L3)

Every change unit (MVP: one commit) gets four explanations. Each level is
**standalone** (readable without the others), **grounded** (claims nothing the
diff does not support) and **consistent** with the levels below it. Higher
levels drop detail, never add it.

| Level | Question it answers | Audience | Length limit | Format |
|---|---|---|---|---|
| **L0 Business** | *Why* does this change exist? | Owner / PM / anyone skimming the timeline | 1 sentence, ≤ 20 words; no file names or code identifiers | plain text |
| **L1 Behavior** | *What will a user or operator notice?* | QA, users, PM | 1–3 bullets, ≤ 60 words total. If nothing is observable, say exactly "No user-visible change" plus ≤ 1 bullet on why (e.g. refactor) | bullet list |
| **L2 Structure** | *Which parts of the system changed, and what role does each play?* | Engineer new to this area | ≤ 8 entries, ≤ 25 words each: `path or module — role — what changed`. Group trivially related files (e.g. tests with their subject) | list |
| **L3 Code** | *Which lines matter and what do they do?* | Reviewer | The full diff (rendered as-is, not generated) + ≤ 10 annotations, ≤ 30 words each, each anchored to `path:line` on the new side (old side for deletions) | diff + anchored notes |

Rules that apply to all levels:

- L3's diff is deterministic data from git; only the annotations are generated.
- Generated text is plain text / limited markdown (no HTML, no links other than repo paths).
- Anything filtered out before generation (lockfiles, binaries, generated files,
  oversized files) is listed in L2 as "not analysed", never silently dropped.
- Length limits are enforced by the pipeline's validator; an over-limit output
  is retried once, then truncated and flagged.

## Worked example — commit `3dd6389` "Add Business Source License 1.1 and README"

Diff: adds `LICENSE` (108 lines, BSL 1.1 text with parameters) and `README.md`
(16 lines, product pitch + license summary).

**L0 Business**

> Makes DigestIT source-available: free to use internally, but nobody may offer it as a competing hosted service.

**L1 Behavior**

- Visitors to the repository now see what DigestIT is and a plain-language license summary.
- Anyone may run DigestIT free of charge, including in production for internal use; offering it as competing SaaS is not allowed.
- Each version becomes Apache 2.0 four years after release (first date: 2030-09-24).

**L2 Structure**

- `LICENSE` — legal source of truth — new: BSL 1.1 text plus parameters (licensor, Additional Use Grant, Change Date, Change License).
- `README.md` — project front page — new: one-paragraph pitch and a license summary that links to `LICENSE`.

**L3 Code** (diff shown in full in the UI; annotations below)

- `LICENSE:5-7` — Licensor and copyright holder: SJY-14; Licensed Work: DigestIT.
- `LICENSE:8-17` — Additional Use Grant, the key clause: production and internal use are free; competing hosted/managed/"as-a-service" offerings are excluded.
- `LICENSE:19-21` — Clarifies that giving your own employees and contractors access counts as internal use.
- `LICENSE:23-25` — Change Date 2030-09-24 → the work converts to Apache 2.0 on that date.
- `README.md:3-6` — Product pitch: multi-level explanations of diffs on a timeline dashboard.
- `README.md:12-14` — Plain-language summary of the license; it restates the `LICENSE` parameters, so both files must change together.
