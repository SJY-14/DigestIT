// Threads from stored digests (docs/milestone-4-memory.md §1 "thread"): no LLM call, a pure
// re-derivation from `digest`/`explanation` rows plus the project's current terms every time it
// runs, so it is safe to call on every update and never drifts from the stored history.
import type { DatabaseSync } from 'node:sqlite';
import type { ExplainLanguage, ThreadDigestRef, ThreadMemory } from '@digestit/core';
import { MEMORY_LIMITS } from '@digestit/core';
import { getMemoryItem, upsertMemoryItem } from './memory.js';

interface DigestFacts {
  id: number;
  at: string;
  language: ExplainLanguage;
  areas: string[];
  terms: string[];
  l0: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A digest area's memory `area` key: its label (a path), `''` for the project root. Not its `id`,
 * which is a slug (`packages-core`) and matches no memory key. */
export function memoryAreaKey(area: { label: string }): string {
  return area.label === 'project root' ? '' : area.label;
}

/** The digest's own area grouping (`digest.areas`, DIG-75), normalised to the same `''`-for-root
 * convention as a memory area's `path` -- the two groupings are computed independently (one over a
 * digest's changed files, one over the whole tree) but share the same bucketing rule, so their keys
 * usually agree. */
function digestAreaKeys(areasJson: string | null): string[] {
  if (!areasJson) return [];
  try {
    const skeleton = JSON.parse(areasJson) as { label: string }[];
    return skeleton.map(memoryAreaKey);
  } catch {
    return [];
  }
}

function loadDigestFacts(db: DatabaseSync, repoId: number, knownTerms: ReadonlySet<string>): DigestFacts[] {
  const rows = db.prepare(
    `SELECT d.change_unit_id AS id, d.created_at AS createdAt, d.language AS language, d.areas AS areasJson
     FROM digest d WHERE d.repo_id = ? ORDER BY d.created_at, d.change_unit_id`,
  ).all(repoId) as unknown as { id: number; createdAt: string; language: ExplainLanguage; areasJson: string | null }[];

  const facts: DigestFacts[] = [];
  for (const r of rows) {
    const areas = digestAreaKeys(r.areasJson);
    if (areas.length === 0) continue; // no stored areas: predates DIG-75, or nothing to thread on
    const l0Row = db.prepare(
      `SELECT content FROM explanation WHERE change_unit_id = ? AND level = 0 AND status IN ('ok', 'truncated')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(r.id) as { content: string } | undefined;
    let l0 = '';
    if (l0Row) {
      try { l0 = (JSON.parse(l0Row.content) as { text: string }).text; } catch { /* unreadable row */ }
    }
    // L0 is business-level and should name no identifiers, so on its own it rarely yields a term;
    // L2's "how" names the functions and modules changed (DIG-114).
    const l2Row = db.prepare(
      `SELECT content FROM explanation WHERE change_unit_id = ? AND level = 2 AND status IN ('ok', 'truncated')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(r.id) as { content: string } | undefined;
    let l2 = '';
    if (l2Row) {
      try {
        const items = (JSON.parse(l2Row.content) as { items?: { title?: string; effect?: string; how?: string; why?: string }[] }).items ?? [];
        l2 = items.flatMap((it) => [it.title, it.effect, it.how, it.why]).filter((x): x is string => typeof x === 'string').join(' ');
      } catch { /* unreadable row */ }
    }
    const text = `${l0} ${l2}`;
    const terms = [...knownTerms].filter((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i').test(text));
    facts.push({ id: r.id, at: r.createdAt, language: r.language, areas, terms, l0 });
  }
  return facts;
}

interface ThreadAccumulator {
  key: string;
  areas: Set<string>;
  terms: Set<string>;
  digests: ThreadDigestRef[];
  language: ExplainLanguage;
  lastAt: string;
  state: 'open' | 'closed';
}

const THREAD_IDLE_MS = MEMORY_LIMITS.threadIdleDays * 24 * 60 * 60 * 1000;

/**
 * The join rule (docs/milestone-4-memory.md §1): a digest joins an open thread when it touches one
 * of the thread's areas, and either shares a term with it or overlaps at least half of its areas.
 * DIG-114: area overlap only counts when the digest or the thread has no terms; when both have
 * terms and share none, they are different work, even in the same folder (in a project whose code
 * sits in one folder, area overlap alone put an unrelated cache change into the retry thread).
 * A thread with no new digest for `MEMORY_LIMITS.threadIdleDays` closes -- checked both between
 * consecutive digests (so a thread from months ago is not silently kept open by today's digest)
 * and, at the end, against `now` for whatever is still open.
 */
export function buildThreads(facts: readonly DigestFacts[], now: Date): ThreadAccumulator[] {
  const open: ThreadAccumulator[] = [];
  const closed: ThreadAccumulator[] = [];

  const expire = (asOf: number) => {
    for (let i = open.length - 1; i >= 0; i--) {
      if (asOf - new Date(open[i]!.lastAt).getTime() > THREAD_IDLE_MS) {
        const [t] = open.splice(i, 1);
        t!.state = 'closed';
        closed.push(t!);
      }
    }
  };

  for (const d of facts) {
    expire(new Date(d.at).getTime());
    const match = open.find((t) => {
      const overlap = d.areas.filter((a) => t.areas.has(a));
      if (overlap.length === 0) return false;
      if (d.terms.some((term) => t.terms.has(term))) return true;
      if (d.terms.length > 0 && t.terms.size > 0) return false;
      return overlap.length * 2 >= t.areas.size;
    });
    const ref: ThreadDigestRef = { digestId: d.id, seq: (match?.digests.length ?? 0) + 1, at: d.at, l0: d.l0 };
    if (match) {
      d.areas.forEach((a) => match.areas.add(a));
      d.terms.forEach((t) => match.terms.add(t));
      match.digests.push(ref);
      match.lastAt = d.at;
    } else {
      open.push({ key: `d${d.id}`, areas: new Set(d.areas), terms: new Set(d.terms), digests: [ref], language: d.language, lastAt: d.at, state: 'open' });
    }
  }
  expire(now.getTime());

  // At most MEMORY_LIMITS.openThreads stay open; anything older is closed rather than dropped.
  open.sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
  while (open.length > MEMORY_LIMITS.openThreads) {
    const t = open.pop()!;
    t.state = 'closed';
    closed.push(t);
  }

  return [...open, ...closed];
}

/** Recomputes every thread from the project's stored digests and writes the ones that changed.
 * Returns the number of thread items created or updated. */
export function updateThreads(db: DatabaseSync, batchId: number, repoId: number, knownTerms: ReadonlySet<string>, now: () => Date = () => new Date()): number {
  const facts = loadDigestFacts(db, repoId, knownTerms);
  const threads = buildThreads(facts, now());
  let upserted = 0;
  for (const t of threads) {
    const content: ThreadMemory = {
      kind: 'thread',
      title: t.digests[0]!.l0 || `checkpoint thread ${t.digests[0]!.digestId}`,
      areas: [...t.areas].sort(),
      terms: [...t.terms].sort(),
      digests: t.digests,
      state: t.state,
      summary: null,
    };
    const existing = getMemoryItem(db, repoId, 'thread', t.key, t.language);
    if (existing?.status === 'hidden') continue;
    if (existing && existing.status === 'active' && JSON.stringify(existing.content) === JSON.stringify(content)) continue;
    const files: string[] = [];
    upsertMemoryItem(db, batchId, repoId, 'thread', t.key, t.language, content, 'digest', {
      files, checkpointId: null, digestIds: t.digests.map((d) => d.digestId), jobId: null,
    }, now);
    upserted++;
  }
  return upserted;
}
