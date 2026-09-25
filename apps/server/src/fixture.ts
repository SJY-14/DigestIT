import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// M3-1 (docs/milestone-3.md): a deterministic 90-day synthetic dataset so frontend (M3-4..7) and
// briefing (M3-2) work, plus this issue's own perf test, don't depend on a real git history.
// `repoPath` defaults to this repo's own root so area bucketing (T4-b) picks up its real
// pnpm-workspace.yaml (`apps/*`, `packages/*`) instead of needing a second fixture just for that.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const intIn = (rnd: () => number, min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[intIn(rnd, 0, xs.length - 1)]!;
const chance = (rnd: () => number, p: number) => rnd() < p;

const FILE_POOL = [
  'apps/web/src/App.tsx', 'apps/web/src/Units.tsx', 'apps/web/src/api.ts', 'apps/web/src/styles.css',
  'apps/server/src/app.ts', 'apps/server/src/live.ts', 'apps/server/src/insights.ts',
  'packages/core/src/db.ts', 'packages/core/src/types.ts',
  'packages/ingest/src/ingest.ts', 'packages/ingest/src/workunits.ts',
  'packages/explain/src/pipeline.ts', 'packages/explain/src/prompt.ts',
  'docs/architecture.md', 'docs/roadmap.md',
  'README.md',
] as const;
const REASONS = ['merged', 'handoff', 'rollup', 'backfill', 'manual'] as const;

const iso = (ms: number) => new Date(ms).toISOString();
const DAY_MS = 86_400_000;

export interface FixtureOptions {
  /** PRNG seed; the same seed always produces the same dataset. */
  seed?: number;
  days?: number;
  now?: Date;
  /** Filesystem repo the synthetic file paths belong to (for pnpm-workspace.yaml area bucketing). */
  repoPath?: string;
  repoName?: string;
}

export interface FixtureInfo {
  repoId: number;
  workUnitIds: number[];
  commitCount: number;
  fileChangeCount: number;
}

/** A synthetic 40-char sha, unique and deterministic per call. */
function fakeSha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

export function buildFixture(db: DatabaseSync, opts: FixtureOptions = {}): FixtureInfo {
  const seed = opts.seed ?? 1;
  const days = opts.days ?? 90;
  const now = opts.now ?? new Date();
  const repoPath = opts.repoPath ?? resolve(import.meta.dirname, '../../..');
  const rnd = mulberry32(seed);
  const startMs = now.getTime() - (days - 1) * DAY_MS;

  const repoId = Number(
    db.prepare('INSERT INTO repo (name, path, head_sha, ingested_at) VALUES (?, ?, ?, ?)')
      .run(opts.repoName ?? 'fixture', repoPath, 'f'.repeat(40), now.toISOString()).lastInsertRowid,
  );

  const insCommit = db.prepare(
    `INSERT INTO commit_ (sha, repo_id, parents, author_name, authored_at, committed_at, message, branch_refs, is_merge, stats)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insChangeUnit = db.prepare(
    "INSERT INTO change_unit (repo_id, kind, head_sha, base_sha, title) VALUES (?, 'commit', ?, ?, ?)",
  );
  const insFile = db.prepare(
    `INSERT INTO file_change (change_unit_id, path, old_path, status, additions, deletions, patch, filtered_reason)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const insWorkUnit = db.prepare(
    `INSERT INTO work_unit (repo_id, key, kind, title, state, tip_sha, base_sha, first_commit_at, last_commit_at, merged_at)
     VALUES (?, ?, 'issue', ?, 'active', ?, ?, ?, ?, ?)`,
  );
  const updWorkUnit = db.prepare(
    'UPDATE work_unit SET state = ?, tip_sha = ?, last_commit_at = ?, merged_at = ? WHERE id = ?',
  );
  const insMember = db.prepare('INSERT INTO unit_commit (work_unit_id, sha) VALUES (?, ?)');
  const insEvent = db.prepare(
    'INSERT INTO unit_event (repo_id, work_unit_id, change_unit_id, kind, at, detail) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insCall = db.prepare(
    'INSERT INTO explain_call (at, change_unit_id, reason, duration_ms, outcome) VALUES (?, ?, ?, ?, ?)',
  );

  const AREA_UNIT_COUNT = 44;
  const ATTENTIONS = ['reviewed', 'deep', 'opened', 'notOpened'] as const;
  let shaCounter = 1;
  let fileChangeCount = 0;
  const workUnitIds: number[] = [];

  db.exec('BEGIN');
  try {
    for (let u = 0; u < AREA_UNIT_COUNT; u++) {
      const key = `DIG-${200 + u}`;
      const homeArea = pick(rnd, FILE_POOL);
      const unitStartOffset = intIn(rnd, 0, days - 2);
      const span = intIn(rnd, 0, Math.min(5, days - 1 - unitStartOffset));
      const commitCount = intIn(rnd, 1, 5);

      const shas: { sha: string; committedAt: string; changeUnitId: number }[] = [];
      for (let c = 0; c < commitCount; c++) {
        const dayOffset = unitStartOffset + (span === 0 ? 0 : intIn(rnd, 0, span));
        const commitMs = startMs + dayOffset * DAY_MS + intIn(rnd, 0, DAY_MS - 1);
        const committedAt = iso(commitMs);
        const sha = fakeSha(shaCounter++);
        const filesTouched = intIn(rnd, 1, 4);
        let additions = 0, deletions = 0;
        insCommit.run(sha, repoId, '[]', pick(rnd, ['ann', 'bo', 'cy', 'dee']), committedAt, committedAt,
          `${key}: change ${c + 1}`, '[]', 0, '{}');
        const changeUnitId = Number(insChangeUnit.run(repoId, sha, null, `${key}: change ${c + 1}`).lastInsertRowid);
        for (let f = 0; f < filesTouched; f++) {
          const path = chance(rnd, 0.7) ? homeArea : pick(rnd, FILE_POOL);
          const add = intIn(rnd, 1, 60), del = intIn(rnd, 0, 30);
          additions += add; deletions += del;
          const isRename = chance(rnd, 0.08);
          const filtered = chance(rnd, 0.1)
            ? pick(rnd, ['lockfile', 'generated', 'too_large'] as const)
            : null;
          try {
            insFile.run(changeUnitId, path, isRename ? `${path}.old` : null, isRename ? 'R' : pick(rnd, ['M', 'M', 'M', 'A']),
              add, del, filtered);
            fileChangeCount++;
          } catch {
            // Two files-touched picks landed on the same path for this commit; skip the duplicate.
          }
        }
        db.prepare('UPDATE commit_ SET stats = ? WHERE sha = ?')
          .run(JSON.stringify({ files: filesTouched, additions, deletions }), sha);
        shas.push({ sha, committedAt, changeUnitId });
      }
      shas.sort((a, b) => (a.committedAt < b.committedAt ? -1 : 1));
      const first = shas[0]!, last = shas.at(-1)!;

      const workUnitId = Number(
        insWorkUnit.run(repoId, key, `Work on ${homeArea}`, last.sha, null, first.committedAt, last.committedAt, null).lastInsertRowid,
      );
      workUnitIds.push(workUnitId);
      for (const s of shas) {
        insMember.run(workUnitId, s.sha);
        insEvent.run(repoId, workUnitId, s.changeUnitId, 'landed', s.committedAt, '{}');
      }

      const outcome = chance(rnd, 0.65) ? 'merged' : chance(rnd, 0.5) ? 'handoff' : 'active';
      let decidedAt: string | null = null;
      if (outcome !== 'active') {
        const afterMs = Date.parse(last.committedAt) + intIn(rnd, 1, 6) * 3_600_000;
        decidedAt = iso(Math.min(afterMs, now.getTime()));
        updWorkUnit.run(outcome, last.sha, decidedAt, outcome === 'merged' ? decidedAt : null, workUnitId);
        insEvent.run(repoId, workUnitId, null, outcome, decidedAt, JSON.stringify({ from: 'active', to: outcome }));
      }

      // Attention archetype (T5-b): spread roughly evenly across reviewed/deep/opened/notOpened.
      const attention = ATTENTIONS[u % ATTENTIONS.length]!;
      if (attention !== 'notOpened') {
        const openedAt = iso(Date.parse(last.committedAt) + intIn(rnd, 1, 12) * 3_600_000);
        insEvent.run(repoId, workUnitId, null, 'opened', openedAt, '{}');
        if (attention === 'deep' || attention === 'reviewed') {
          const level = pick(rnd, [2, 3]);
          const viewedAt = iso(Date.parse(openedAt) + intIn(rnd, 1, 30) * 60_000);
          insEvent.run(repoId, workUnitId, null, 'level_viewed', viewedAt, JSON.stringify({ level, ms: intIn(rnd, 10_000, 60_000) }));
        }
        if (attention === 'reviewed') {
          const reviewedAt = iso(Date.parse(openedAt) + intIn(rnd, 31, 90) * 60_000);
          insEvent.run(repoId, workUnitId, null, 'reviewed', reviewedAt, '{}');
        }
      }
    }

    // explain_call: a handful of provider calls most days, occasionally hitting the daily budget.
    for (let d = 0; d < days; d++) {
      if (!chance(rnd, 0.7)) continue;
      const dayMs = startMs + d * DAY_MS;
      const callCount = intIn(rnd, 1, 5);
      for (let i = 0; i < callCount; i++) {
        const at = iso(dayMs + intIn(rnd, 0, DAY_MS - 1));
        insCall.run(at, null, pick(rnd, REASONS), intIn(rnd, 500, 8000), 'ok');
      }
      if (chance(rnd, 0.08)) insCall.run(iso(dayMs + DAY_MS - 1000), null, pick(rnd, REASONS), 0, 'budget');
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const commitCount = (db.prepare('SELECT count(*) AS n FROM commit_ WHERE repo_id = ?').get(repoId) as { n: number }).n;
  return { repoId, workUnitIds, commitCount, fileChangeCount };
}
