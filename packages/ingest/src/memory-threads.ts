// Threads from stored digests (docs/milestone-4-memory.md §1 "thread"): no LLM call, a pure
// re-derivation from `digest`/`file_change` rows plus the project's terms and area links every
// time it runs, so it is safe to call on every update and never drifts from the stored history.
// Grouping reads only code facts (DIG-121); the stored L0 is carried along for display.
import type { DatabaseSync } from 'node:sqlite';
import type { AreaMemory, ExplainLanguage, ThreadDigestRef, ThreadMemory } from '@digestit/core';
import { MEMORY_LIMITS } from '@digestit/core';
import { getMemoryItem, listMemoryItems, upsertMemoryItem } from './memory.js';

interface DigestFacts {
  id: number;
  at: string;
  language: ExplainLanguage;
  areas: string[];
  terms: string[];
  l0: string;
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

/**
 * Known terms named on the lines a digest's diff adds or removes (not its context lines): the code
 * facts a thread is grouped on (DIG-121). Until then terms came from the stored L0 and L2, which
 * the model writes, so the same commits grouped differently per language and per run: an en L2 that
 * named `withRetry` and a ko L2 that did not put one digest in different threads. Context lines are
 * code the change did not touch -- the `request` export sitting next to a new `retryRequest` line
 * would otherwise tie a later logging change in the same file to the retry work.
 */
export function changedTerms(patches: readonly (string | null)[], knownTerms: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  for (const patch of patches) {
    if (patch === null) continue;
    let inHunk = false;
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git')) inHunk = false;
      else if (line.startsWith('@@')) inHunk = true;
      else if (inHunk && (line.startsWith('+') || line.startsWith('-'))) {
        for (const m of line.slice(1).matchAll(WORD)) if (knownTerms.has(m[0])) found.add(m[0]);
      }
    }
  }
  return [...found].sort();
}

function loadDigestFacts(db: DatabaseSync, repoId: number, knownTerms: ReadonlySet<string>): DigestFacts[] {
  const rows = db.prepare(
    `SELECT d.change_unit_id AS id, d.created_at AS createdAt, d.language AS language, d.areas AS areasJson
     FROM digest d WHERE d.repo_id = ? ORDER BY d.created_at, d.change_unit_id`,
  ).all(repoId) as unknown as { id: number; createdAt: string; language: ExplainLanguage; areasJson: string | null }[];
  const patchesOf = db.prepare('SELECT patch FROM file_change WHERE change_unit_id = ? ORDER BY path');

  const facts: DigestFacts[] = [];
  for (const r of rows) {
    const areas = digestAreaKeys(r.areasJson);
    if (areas.length === 0) continue; // no stored areas: predates DIG-75, or nothing to thread on
    // The L0 is kept only to show: the thread's title and its entries. Grouping never reads it.
    const l0Row = db.prepare(
      `SELECT content FROM explanation WHERE change_unit_id = ? AND level = 0 AND status IN ('ok', 'truncated')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(r.id) as { content: string } | undefined;
    let l0 = '';
    if (l0Row) {
      try { l0 = (JSON.parse(l0Row.content) as { text: string }).text; } catch { /* unreadable row */ }
    }
    const patches = (patchesOf.all(r.id) as unknown as { patch: string | null }[]).map((p) => p.patch);
    facts.push({ id: r.id, at: r.createdAt, language: r.language, areas, terms: changedTerms(patches, knownTerms), l0 });
  }
  return facts;
}

/** Each area key's direct neighbours (`uses` and `usedBy`), from the project's area items. */
function loadAreaLinks(db: DatabaseSync, repoId: number): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  for (const it of listMemoryItems(db, repoId, { kind: 'area' })) {
    if (it.status === 'hidden') continue;
    const c = it.content as AreaMemory;
    links.set(c.path, new Set([...c.uses, ...c.usedBy]));
  }
  return links;
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
 * The join rule (docs/milestone-4-memory.md §1), on code facts only (DIG-121): a digest joins an
 * open thread when it shares a term with it (a known term on a line its diff adds or removes, see
 * `changedTerms`) and touches one of the thread's areas or an area directly linked to one (`uses`/
 * `usedBy`, `links`) -- a test folder's change to the code it tests is the same work. Area overlap
 * alone (at least half of the thread's areas) only counts when neither side has a term, i.e. in
 * code the extractor finds no symbols in; a digest with terms never joins a thread on area alone,
 * nor a digest without terms a thread that has some (DIG-114, DIG-121: in a project whose code sits
 * in one folder, that put a cache change and a logging change into the retry thread).
 * A thread with no new digest for `MEMORY_LIMITS.threadIdleDays` closes -- checked both between
 * consecutive digests (so a thread from months ago is not silently kept open by today's digest)
 * and, at the end, against `now` for whatever is still open.
 */
export function buildThreads(
  facts: readonly DigestFacts[], now: Date, links: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): ThreadAccumulator[] {
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
      if (d.terms.length > 0 && t.terms.size > 0) {
        const near = overlap.length > 0 || d.areas.some((a) => [...(links.get(a) ?? [])].some((b) => t.areas.has(b)));
        return near && d.terms.some((term) => t.terms.has(term));
      }
      if (d.terms.length > 0 || t.terms.size > 0) return false;
      return overlap.length > 0 && overlap.length * 2 >= t.areas.size;
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
  const threads = buildThreads(facts, now(), loadAreaLinks(db, repoId));
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
