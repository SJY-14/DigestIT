# Milestone 3 — thinking aids (proposal)

**Status:** proposed for Board approval (DIG-22), 2026-09-26. Builds on
[architecture.md](architecture.md) and [milestone-2.md](milestone-2.md); D1–D3 and M1–M9 still hold.

**Goal:** per-change explanations tell you *what* one change did. Thinking aids help a human
*decide across many changes*: what happened, what nobody has looked at, and what needs a decision.
Everything is built from data we already store (`work_unit`, `unit_commit`, `file_change`, L0–L3
`explanation`, `unit_event`, `explain_call`, `rollup`). Every mark on every chart drills down to a
list of work units, and each unit opens in the existing panel at L0–L3.

**Done when:** at 07:00 the owner opens **Briefing** and sees yesterday's work, 3 items that need a
decision (each citing its unit), and the unreviewed list. They open one unit at L0 and drill to L3.
**Insights → Map** shows where change was concentrated this week, and **Blind spots** names the area
with the most unexamined lines. **Insights → Digest** shows whether digest rate kept up with
production. All of it works in light/dark, by keyboard, and on a 90-day fixture as well as this repo.

## Candidates → recommendation

| # | Candidate | Scope | Data | LLM calls | Rec. |
|---|---|---|---|---|---|
| 1 | **Daily / weekly briefing** | One page, four parts. (a) *Numbers*: landed, decided, backlog Δ vs previous period, LLM calls used. (b) *What happened*: units that moved, grouped by area, with L0; the L1 bullets of units whose L1 is `userVisible`. (c) *Unreviewed*: oldest first, with size and deepest level viewed. (d) *Needs a decision*, using fixed rules: handoff not reviewed; merged but never opened; explanation `error`/`truncated`, or `pending (budget)` > 24 h; opened ≥ 3× with no decision; the top blind-spot area. Plus a ≤ 5-sentence *narrative*: "what deserves your attention and why". | work_unit, unit_event, explanation L0/L1, rollup, explain_call | **Daily 1 + weekly 1 (Mondays): ≤ 2 calls/day, 8/week (5 % of the 40/day cap).** | **Build first** |
| 2 | **Digest dashboard** | Extends `/metrics`. 7/30/90-day window. Landed vs decided per day. Unread and undecided backlog trend, rebuilt per day from `unit_event` (no snapshot table). land→open→decide as a dot strip per week with a median tick, plus p50/p90 tiles vs the previous period. Deepest level reached before deciding. LLM calls/day vs the cap, by reason. | unit_event, work_unit, explain_call | 0 | Build |
| 3 | **Change map** | Contribution-graph-style grid: rows = areas, columns = days (weeks for 90 d), 5-step single-hue cells. Measure: units touching the area (default) or lines changed. Rows expand to subdirectories. Selecting a cell lists the units and, for each, the L2 items (role/change) for paths in that area. Lockfiles/generated files are excluded by default. Merge commits are not counted twice. | file_change (commit units), unit_commit, explanation L2 | 0 | Build |
| 4 | **Review blind spots** | Same area rows. Per area: lines changed, split by attention: *reviewed* / *deep look* (L2 or L3 viewed ≥ 10 s) / *opened only* / *not opened*. Sorted by unexamined lines (the last two). Also a "colour by: unexamined" mode on the map. | as 3 + unit_event (opened, level_viewed.ms, reviewed) | 0 | Build (shares 3's query and UI) |
| 5 | Co-change map | Pairs of files/areas that change in the same unit (support, Jaccard); sorted pair list + small matrix. | file_change, unit_commit | 0 | **Later (M3b)**: pure SQL and cheap, but first check that the map gets used |
| 6 | Work-flow view | Where an issue waited between agents. | needs Paperclip (DIG-20, gated) | 0 | **Later.** The git-only part (active → handoff → decided waits) goes into the briefing's "needs a decision" now |

## Decisions (options → recommendation)

| # | Topic | Options | Recommendation |
|---|---|---|---|
| T1 | **Briefing and the LLM** | a) deterministic only; b) deterministic facts + 1 narrative call; c) LLM writes the whole page | **b.** The facts (a–d above) are SQL and are always correct and complete. The narrative call gets only those facts plus unit L0/L1 text. It sees no diffs or code, so there's no new data flow beyond D2. Every sentence must cite ≥ 1 unit key from the facts; sentences citing unknown keys are dropped. The narrative is rendered as text with key chips. Daily runs at 07:00 local, just after the budget resets, so it is normally among the first calls of the day. It is queued after merged/handoff and before roll-up/backfill, and logged as `explain_call.reason = 'briefing'`. Over budget, the briefing still publishes with the facts only and the narrative marked `pending (budget)`. |
| T2 | **Where aggregates are computed** | a) SQL on read in the API process, memoised on `PRAGMA data_version`; b) aggregate tables written by `digest watch` | **a.** The API stays read-only and no second source of truth can drift. Switch to b only if p95 > 300 ms on the 90-day fixture (tested). The briefing is the exception: it is a stored snapshot (`briefing` table) written by `digest watch`, so "what I was told on Monday" stays stable. |
| T3 | **Charts** | a) chart library (Recharts / visx / d3); b) hand-rolled SVG primitives | **b.** Four primitives cover everything: bar series, line series, grid heatmap and dot strip. We extend DIG-19's `PerDayChart`. No new dependencies, no CDN. Colour comes from CSS classes and DIG-11 tokens, so CSP `style-src 'self'` stays unchanged. Style: flat fills, ≤ 2 hues per chart, no gradients or 3-D; every chart has a table view and `<title>` per mark; roving-tabindex arrows + Enter to drill. |
| T4 | **What an "area" is** | a) top-level directory; b) workspace-aware prefix (`apps/*`, `packages/*` from `pnpm-workspace.yaml`, else top-level dir) with expand; c) named areas from config or L2 | **b.** It matches how the repo is organised, needs no configuration and works for other repos. c comes later if b turns out too coarse. |
| T5 | **"Human attention" for blind spots** | a) opened; b) deepest level + dwell time (`level_viewed.ms`) + reviewed; c) per-file L3 viewing (new event field) | **b**, at unit granularity, from existing events. c only if blind spots prove useful. It would add one allowlisted field to `ui-events`. |
| T6 | **Navigation** | — | Top nav **Units · Timeline · Briefing · Insights** (Digest, Map, Blind spots). `/metrics` redirects to Insights → Digest. Chart state lives in the URL (`?window=30d&area=apps/web&day=…`), so briefing items and charts deep-link. |

**Drill-down contract:** every mark carries a query (`area+day`, `day+metric`, `week+bucket`,
`unit ids`). `GET /api/insights/drill` returns work-unit summaries in the `/api/work-units` shape.
The list opens the existing panel with its L0–L3 picker. `opened` events get an optional
`via: briefing|map|digest|blindspots` so we can tell whether the aids speed up decisions.

## Data and API changes

```
briefing      (id, repo_id, kind daily|weekly, window_start, window_end, facts JSON,
               narrative JSON NULL, narrative_status ok|pending|budget|error, created_at,
               UNIQUE(repo_id, kind, window_end))
explain_call  reason += 'briefing'        -- table rebuild, same procedure as migration M2-2
unit_event    detail.via (optional, allowlisted enum) on 'opened'
```

Read-only GETs: `/api/insights/digest?window=`, `/api/insights/areas?window=&root=` (map and blind
spots in one response), `/api/insights/drill?…`, `/api/briefings?kind=&cursor=`,
`/api/briefings/:id|latest`. CLI: `digest brief [--daily|--weekly] [--markdown]` (manual reason,
counts against the budget). Only `digest watch` and the CLI can make LLM calls. There is no new
write route, no new port, no external service, and no data leaves the server beyond D2.

## Build issues

| # | Issue | Owner | Depends on |
|---|---|---|---|
| 1 | Insights query layer + read API: area bucketing, map/blind-spot aggregates, digest series, backlog reconstruction, drill endpoint, memo; **90-day synthetic fixture** used by all tests and screenshots; p95 perf test | Diff engineer | — |
| 2 | Briefing builder: fact rules (a–d), `briefing` table, daily/weekly schedule in `digest watch`, `digest brief` CLI (+ Markdown), `/api/briefings` | Diff engineer | 1 |
| 3 | Briefing narrative: text-only prompt over facts + L0/L1, citation validation, `briefing` reason and priority in the scheduler, budget fallback, golden test | Summarization engineer | — (wired via 2) |
| 4 | Chart primitives + drill list + `/insights` shell and nav: bar, line, grid heatmap, dot strip, table toggle, keyboard, light/dark tokens; migrate `PerDayChart` | Frontend engineer | — (fixture JSON) |
| 5 | Briefing page: latest daily/weekly, history, print stylesheet, key chips → panel, `via` events | Frontend engineer | 2, 3, 4 |
| 6 | Digest dashboard v2 on Insights → Digest | Frontend engineer | 1, 4 |
| 7 | Change map + blind spots on Insights → Map / Blind spots | Frontend engineer | 1, 4 |

Order: 1, 3, 4 start in parallel, then 2, then 5 → 6 → 7 (Board priority). The Frontend engineer is
the critical path, with about four issues in sequence. If that becomes the bottleneck, the Diff
engineer takes 7's area-expand logic. Screenshots (light/dark) go in `docs/ui/` as in DIG-19.

## Risks

- **Misleading signals.** With one human, "opened" or "viewed L3 for 10 s" is not the same as "understood".
  Blind spots is phrased as "not looked at", never "not understood". The numbers are trend signals.
- **Narrative errors / prompt injection.** L0/L1 are LLM output derived from diffs. The facts are
  deterministic and shown next to the narrative; unknown citations are dropped; text is escaped under the strict CSP.
- **Budget contention.** Hourly roll-ups can use many of the 40 calls on busy days. The briefing is
  ≤ 2/day, runs right after the reset, and degrades to facts only.
- **Attribution in the shared checkout** (M2 risk) skews area and unit counts. The drill-down shows
  member commits, so a wrong count can be checked.
- **"AI dashboard" drift.** Only the four primitives are allowed; screenshot review against DIG-11 happens at CTO review.
- **Query cost as history grows.** There's a perf test on the 90-day fixture, and T2-b is the fallback.
