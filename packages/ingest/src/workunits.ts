import type { DatabaseSync } from 'node:sqlite';
import type { WorkUnit, WorkUnitKind, WorkUnitState } from '@digestit/core';
import { git, listBranches, readFiles, revList } from './git.js';

export const DEFAULT_QUIET_MS = 15 * 60 * 1000;

export interface WorkUnitOptions {
  /** Branch that "merged" is measured against. */
  baseRef?: string;
  /** A branch with no new commit for this long is handed off. */
  quietMs?: number;
  /** Injected clock for tests. */
  now?: () => Date;
}

/** Branch names `DIG-n` or `DIG-n-anything`. */
const BRANCH_KEY = /^(DIG-\d+)(?:-|$)/;
/** Merge subjects `Merge DIG-n-…` (also git's default `Merge branch 'DIG-n-…'`). */
const MERGE_KEY = /^Merge (?:branch )?'?(DIG-\d+)-/;

export const issueKeyOfBranch = (name: string): string | null => BRANCH_KEY.exec(name)?.[1] ?? null;
export const issueKeyOfMerge = (subject: string): string | null => MERGE_KEY.exec(subject)?.[1] ?? null;

export interface SyncResult {
  created: number;
  transitions: { key: string; from: WorkUnitState | null; to: WorkUnitState }[];
}

interface Candidate {
  key: string;
  kind: WorkUnitKind;
  tips: string[]; // branch tips for this unit
  commits: Set<string>;
  mergeAt?: string; // committed_at of the `Merge DIG-n-…` commit that brought the unit into the base
  baseHint: string | null; // first parent of a `Merge DIG-n-…` commit: where the unit forked from
}

interface Plan {
  c: Candidate; shas: string[]; tip: string; infos: Map<string, { committed_at: string; message: string }>;
  reachable: boolean; base: string | null; title: string;
}

const rowToUnit = (r: Record<string, unknown>): WorkUnit => ({
  id: r.id as number, repoId: r.repo_id as number, key: r.key as string, kind: r.kind as WorkUnitKind,
  title: r.title as string, state: r.state as WorkUnitState, tipSha: r.tip_sha as string,
  baseSha: (r.base_sha as string | null) ?? null, firstCommitAt: r.first_commit_at as string,
  lastCommitAt: r.last_commit_at as string, mergedAt: (r.merged_at as string | null) ?? null,
  latestRangeUnitId: (r.latest_range_unit_id as number | null) ?? null,
});

export function getWorkUnit(db: DatabaseSync, id: number): WorkUnit | null {
  const r = db.prepare('SELECT * FROM work_unit WHERE id = ?').get(id);
  return r ? rowToUnit(r) : null;
}

async function isAncestor(repo: string, sha: string, of: string): Promise<boolean> {
  try { await git(repo, ['merge-base', '--is-ancestor', sha, of]); return true; } catch { return false; }
}

async function mergeBase(repo: string, a: string, b: string): Promise<string | null> {
  try { return (await git(repo, ['merge-base', a, b])).trim() || null; } catch { return null; }
}

/**
 * Links ingested commits to work units and advances the state machine
 * active → handoff → merged. Membership is sticky (a fast-forward merge makes a
 * branch's commits reachable from the base, they stay in their unit). Call after
 * `ingestRepo`. Linking is by branch name and merge subject only.
 */
export async function syncWorkUnits(
  db: DatabaseSync, repoPath: string, opts: WorkUnitOptions = {},
): Promise<SyncResult> {
  const baseRef = opts.baseRef ?? 'main';
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const now = (opts.now ?? (() => new Date()))();
  const repoRow = db.prepare('SELECT id FROM repo WHERE path = ?').get(repoPath) as { id: number } | undefined;
  if (!repoRow) throw new Error(`repo not ingested: ${repoPath}`);
  const repoId = repoRow.id;

  const branches = (await listBranches(repoPath)).filter((b) => b.name !== baseRef);
  const cands = new Map<string, Candidate>();
  const cand = (key: string, kind: WorkUnitKind): Candidate => {
    let c = cands.get(key);
    if (!c) cands.set(key, (c = { key, kind, tips: [], commits: new Set(), baseHint: null }));
    return c;
  };

  const dig = branches.filter((b) => issueKeyOfBranch(b.name));
  const digTips = dig.map((b) => b.sha);
  // Nothing here uses --first-parent: a merge brings its whole side branch along.
  for (const b of dig) {
    const c = cand(issueKeyOfBranch(b.name)!, 'issue');
    c.tips.push(b.sha);
    for (const sha of await revList(repoPath, [b.sha, `^${baseRef}`])) c.commits.add(sha);
  }
  for (const b of branches) {
    if (issueKeyOfBranch(b.name)) continue;
    // Commits already claimed by an issue branch stay with the issue.
    const shas = await revList(repoPath, [b.sha, `^${baseRef}`, ...digTips.map((t) => `^${t}`)]);
    if (shas.length === 0) continue;
    const c = cand(b.name, 'branch');
    c.tips.push(b.sha);
    for (const sha of shas) c.commits.add(sha);
  }

  // Merge commits on the base named `Merge DIG-n-…` join the issue unit, along with
  // the side branch they brought in (this recovers units whose branch is gone).
  const merges = db.prepare(
    "SELECT sha, parents, message, committed_at FROM commit_ WHERE repo_id = ? AND is_merge = 1 ORDER BY committed_at",
  ).all(repoId) as { sha: string; parents: string; message: string; committed_at: string }[];
  for (const m of merges) {
    const key = issueKeyOfMerge(m.message.split('\n')[0]!);
    if (!key || !(await isAncestor(repoPath, m.sha, baseRef))) continue;
    const c = cand(key, 'issue');
    c.commits.add(m.sha);
    c.mergeAt ??= m.committed_at;
    const [p0, p1] = JSON.parse(m.parents) as string[];
    if (p1) {
      for (const sha of await revList(repoPath, [p1, `^${p0}`])) c.commits.add(sha);
      if (c.tips.length === 0) c.tips.push(p1);
      c.baseHint ??= p0 ?? null;
    }
  }

  const known = new Set(
    (db.prepare('SELECT sha FROM commit_ WHERE repo_id = ?').all(repoId) as { sha: string }[]).map((r) => r.sha),
  );
  const commitInfo = db.prepare('SELECT committed_at, message FROM commit_ WHERE sha = ?');

  // Gather git facts before the write transaction.
  const plans: Plan[] = [];
  for (const c of cands.values()) {
    const shas = [...c.commits].filter((s) => known.has(s));
    if (shas.length === 0 || c.tips.length === 0) continue;
    const infos = new Map(shas.map((s) => [s, commitInfo.get(s) as { committed_at: string; message: string }]));
    // Tip: among this unit's branch tips, the one whose commit is newest.
    const tip = [...c.tips].filter((t) => infos.has(t) || known.has(t)).sort((a, b) => {
      const ta = (commitInfo.get(a) as { committed_at: string } | undefined)?.committed_at ?? '';
      const tb = (commitInfo.get(b) as { committed_at: string } | undefined)?.committed_at ?? '';
      return tb < ta ? -1 : tb > ta ? 1 : 0;
    })[0];
    if (!tip) continue;
    const reachable = await isAncestor(repoPath, tip, baseRef);
    plans.push({
      c, shas, tip, infos, reachable,
      base: await mergeBase(repoPath, reachable ? (c.baseHint ?? tip) : baseRef, tip),
      title: (commitInfo.get(tip) as { message: string } | undefined)?.message.split('\n')[0] ?? c.key,
    });
  }

  // A unit whose branch vanished or was fast-forwarded into the base has no candidate commits
  // any more; keep evaluating it from its stored tip so it can still merge.
  const planned = new Set(plans.map((p) => p.c.key));
  const stale = db.prepare("SELECT * FROM work_unit WHERE repo_id = ? AND state != 'merged'").all(repoId) as Record<string, unknown>[];
  for (const r of stale) {
    if (planned.has(r.key as string)) continue;
    const tip = r.tip_sha as string;
    plans.push({
      c: { key: r.key as string, kind: r.kind as WorkUnitKind, tips: [tip], commits: new Set(), baseHint: null },
      shas: [], tip, infos: new Map(), reachable: await isAncestor(repoPath, tip, baseRef),
      base: (r.base_sha as string | null) ?? null, title: r.title as string,
    });
  }

  const transitions: SyncResult['transitions'] = [];
  let created = 0;
  const nowIso = now.toISOString();
  db.exec('BEGIN');
  try {
    const sel = db.prepare('SELECT * FROM work_unit WHERE repo_id = ? AND key = ?');
    const insUnit = db.prepare(
      `INSERT INTO work_unit (repo_id, key, kind, title, state, tip_sha, base_sha, first_commit_at, last_commit_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    );
    const updUnit = db.prepare(
      `UPDATE work_unit SET title = ?, tip_sha = ?, base_sha = ?, first_commit_at = ?, last_commit_at = ? WHERE id = ?`,
    );
    const insMember = db.prepare('INSERT OR IGNORE INTO unit_commit (work_unit_id, sha) VALUES (?, ?)');
    const linkLanded = db.prepare(
      `UPDATE unit_event SET work_unit_id = ? WHERE kind = 'landed' AND work_unit_id IS NULL AND change_unit_id IN
         (SELECT id FROM change_unit WHERE repo_id = ? AND kind = 'commit' AND head_sha = ?)`,
    );
    const event = db.prepare(
      'INSERT INTO unit_event (repo_id, work_unit_id, kind, at, detail) VALUES (?, ?, ?, ?, ?)',
    );

    for (const p of plans) {
      let row: Record<string, unknown> | undefined = sel.get(repoId, p.c.key);
      if (row?.state === 'merged') { // terminal; only pick up late members
        for (const sha of p.shas) { insMember.run(row.id as number, sha); linkLanded.run(row.id as number, repoId, sha); }
        continue;
      }
      let id: number;
      const times = [...p.infos.values()].map((i) => i.committed_at);
      if (row) times.push(row.first_commit_at as string, row.last_commit_at as string);
      times.sort();
      const first = times[0]!, last = times.at(-1)!;
      // The base is frozen once merged (merge-base of a merged tip is the tip itself).
      const base = p.reachable ? ((row?.base_sha as string | null) ?? (p.c.baseHint ? p.base : null)) : p.base;
      if (!row) {
        id = Number(insUnit.run(repoId, p.c.key, p.c.kind, p.title, p.tip, base, first, last).lastInsertRowid);
        created++;
        row = { id, state: null, first_commit_at: first, last_commit_at: last };
      } else {
        id = row.id as number;
        updUnit.run(p.title, p.tip, base, first, last, id);
      }
      for (const sha of p.shas) { insMember.run(id, sha); linkLanded.run(id, repoId, sha); }

      const from = (row.state as WorkUnitState | null) ?? null;
      const to: WorkUnitState = p.reachable ? 'merged'
        : now.getTime() - Date.parse(last) >= quietMs ? 'handoff' : 'active';
      if (to !== (from ?? 'active')) {
        // First seen already merged (history backfill): stamp the merge commit's time, not now,
        // so old units do not look freshly merged.
        const backfill = to === 'merged' && from === null;
        const at = backfill ? (p.c.mergeAt ?? last) : nowIso;
        db.prepare('UPDATE work_unit SET state = ?, merged_at = ? WHERE id = ?')
          .run(to, to === 'merged' ? at : null, id);
        const kind = to === 'merged' ? 'merged' : to === 'handoff' ? 'handoff' : 'resumed';
        event.run(repoId, id, kind, at, JSON.stringify({ from: from ?? 'active', to, tip: p.tip, ...(backfill ? { backfill: true } : {}) }));
        transitions.push({ key: p.c.key, from, to });
      } else if (from === null) {
        transitions.push({ key: p.c.key, from, to });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { created, transitions };
}

/**
 * Snapshots `base..tip` of a work unit as an immutable `range` change unit (base =
 * merge-base(baseRef, tip), frozen at merge) and points `latest_range_unit_id` at it.
 * Files are stored like commit units; filtering/redaction/budgeting happen when the
 * unit is explained (prepareInput), so this snapshot is the raw diff. Idempotent per
 * (head, base): an unmoved tip returns the existing unit.
 */
export async function createRangeUnit(
  db: DatabaseSync, repoPath: string, workUnitId: number,
): Promise<{ changeUnitId: number; created: boolean }> {
  const wu = getWorkUnit(db, workUnitId);
  if (!wu) throw new Error(`no work unit ${workUnitId}`);
  const existing = db.prepare(
    "SELECT id FROM change_unit WHERE repo_id = ? AND kind = 'range' AND head_sha = ? AND COALESCE(base_sha, '') = ?",
  ).get(wu.repoId, wu.tipSha, wu.baseSha ?? '') as { id: number } | undefined;
  const point = db.prepare('UPDATE work_unit SET latest_range_unit_id = ? WHERE id = ?');
  if (existing) {
    point.run(existing.id, wu.id);
    return { changeUnitId: existing.id, created: false };
  }
  const files = wu.baseSha === wu.tipSha ? [] : await readFiles(repoPath, wu.tipSha, wu.baseSha);
  db.exec('BEGIN');
  try {
    const id = Number(db.prepare(
      "INSERT INTO change_unit (repo_id, kind, head_sha, base_sha, title) VALUES (?, 'range', ?, ?, ?)",
    ).run(wu.repoId, wu.tipSha, wu.baseSha, wu.title).lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO file_change (change_unit_id, path, old_path, status, additions, deletions, patch, filtered_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of files) {
      ins.run(id, f.path, f.oldPath, f.status, f.additions, f.deletions, f.patch, f.status === 'B' ? 'binary' : null);
    }
    point.run(id, wu.id);
    db.exec('COMMIT');
    return { changeUnitId: id, created: true };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
