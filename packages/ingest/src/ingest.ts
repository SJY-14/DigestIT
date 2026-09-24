import { basename, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { headSha, listBranches, readCommit, readFiles, revList } from './git.js';

export interface IngestResult {
  repoId: number;
  commitsAdded: number;
  fileChangesAdded: number;
  refsUpdated: number;
}

function ensureRepo(db: DatabaseSync, path: string): number {
  const found = db.prepare('SELECT id FROM repo WHERE path = ?').get(path) as { id: number } | undefined;
  if (found) return found.id;
  const base = basename(path);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!db.prepare('SELECT 1 FROM repo WHERE name = ?').get(name)) {
      return Number(db.prepare('INSERT INTO repo (name, path) VALUES (?, ?)').run(name, path).lastInsertRowid);
    }
  }
}

/**
 * Stores every commit reachable from any local branch. Commits are immutable,
 * so known SHAs are skipped; only `branch_refs`/`head_sha` are refreshed.
 */
export async function ingestRepo(db: DatabaseSync, repoPath: string): Promise<IngestResult> {
  const path = resolve(repoPath);
  const branches = await listBranches(path);
  const repoId = ensureRepo(db, path);

  const refsBySha = new Map<string, string[]>();
  for (const b of branches) {
    for (const sha of await revList(path, [b.sha])) {
      (refsBySha.get(sha) ?? refsBySha.set(sha, []).get(sha)!).push(b.name);
    }
  }
  // One combined walk gives a global parents-first order.
  const ordered = branches.length ? await revList(path, branches.map((b) => b.sha)) : [];

  const known = new Set(
    (db.prepare('SELECT sha FROM commit_ WHERE repo_id = ?').all(repoId) as { sha: string }[]).map((r) => r.sha),
  );

  // Read git output before opening the write transaction.
  const fresh = [];
  for (const sha of ordered) {
    if (known.has(sha)) continue;
    const c = await readCommit(path, sha);
    const files = await readFiles(path, sha, c.parents[0] ?? null);
    fresh.push({ c, files });
  }

  const insCommit = db.prepare(
    `INSERT INTO commit_ (sha, repo_id, parents, author_name, authored_at, committed_at, message, branch_refs, is_merge, stats)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insUnit = db.prepare(
    'INSERT INTO change_unit (repo_id, kind, head_sha, base_sha, title) VALUES (?, ?, ?, ?, ?)',
  );
  const insFile = db.prepare(
    `INSERT INTO file_change (change_unit_id, path, old_path, status, additions, deletions, patch, filtered_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updRefs = db.prepare('UPDATE commit_ SET branch_refs = ? WHERE sha = ? AND branch_refs != ?');

  let commitsAdded = 0, fileChangesAdded = 0, refsUpdated = 0;
  db.exec('BEGIN');
  try {
    for (const { c, files } of fresh) {
      const stats = {
        files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
      };
      insCommit.run(
        c.sha, repoId, JSON.stringify(c.parents), c.authorName, c.authoredAt, c.committedAt,
        c.message, JSON.stringify((refsBySha.get(c.sha) ?? []).sort()), c.parents.length > 1 ? 1 : 0,
        JSON.stringify(stats),
      );
      const unitId = Number(
        insUnit.run(repoId, 'commit', c.sha, c.parents[0] ?? null, c.message.split('\n')[0] ?? '').lastInsertRowid,
      );
      for (const f of files) {
        insFile.run(unitId, f.path, f.oldPath, f.status, f.additions, f.deletions, f.patch,
          f.status === 'B' ? 'binary' : null);
        fileChangesAdded++;
      }
      commitsAdded++;
    }
    for (const sha of known) {
      const refs = JSON.stringify((refsBySha.get(sha) ?? []).sort());
      refsUpdated += Number(updRefs.run(refs, sha, refs).changes);
    }
    db.prepare('UPDATE repo SET head_sha = ?, ingested_at = ? WHERE id = ?')
      .run(await headSha(path), new Date().toISOString(), repoId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { repoId, commitsAdded, fileChangesAdded, refsUpdated };
}
