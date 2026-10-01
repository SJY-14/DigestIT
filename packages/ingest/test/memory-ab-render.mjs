// DIG-107/DIG-114 memory A/B kit: the blinded pair files, the reader sheet and the DB-derived
// metrics, split out of memory-ab-kit.mjs so they are unit-tested (memory-ab-render.test.mjs)
// without running a whole replay.
import { formatMemoryDate, relativeAge } from '@digestit/explain';

// ---------------------------------------------------------------------------
// what the memory-on arm was sent for one digest (DIG-114 kit item 1)
// ---------------------------------------------------------------------------

/**
 * Every memory item version the on arm's prompts used for one digest, from `memory_use` joined to
 * the exact `memory_revision` that was sent (not the item's current version: an after-explain update
 * may have moved a thread on since). One entry per item, with the parts that used it. Empty for the
 * off arm, and for an on-arm digest whose slice was empty (nothing specific to send).
 */
export function loadDigestMemory(db, changeUnitId) {
  const rows = db.prepare(
    `SELECT mu.item_id AS itemId, mu.version, mu.part, mi.kind, mi.key, mr.content, mr.at
       FROM memory_use mu
       JOIN memory_item mi ON mi.id = mu.item_id
       JOIN memory_revision mr ON mr.item_id = mu.item_id AND mr.version = mu.version
      WHERE mu.change_unit_id = ?
      ORDER BY mi.kind, mi.key, mu.part`,
  ).all(changeUnitId);
  const byItem = new Map();
  for (const r of rows) {
    const id = `${r.itemId}:${r.version}`;
    let entry = byItem.get(id);
    if (!entry) {
      entry = { kind: r.kind, key: r.key, version: r.version, at: r.at, content: JSON.parse(r.content), parts: [] };
      byItem.set(id, entry);
    }
    if (!entry.parts.includes(r.part)) entry.parts.push(r.part);
  }
  const order = { note: 0, thread: 1, term: 2, area: 3 };
  return [...byItem.values()].sort((a, b) => order[a.kind] - order[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const isoDay = (iso) => iso.slice(0, 10);
const dayLabel = (iso) => `${formatMemoryDate(iso, 'en')} (${isoDay(iso)})`;

function renderEntry(e, digestAt) {
  const c = e.content;
  const usedIn = `_used in: ${e.parts.join(', ')}_`;
  if (e.kind === 'note') {
    const about = c.target ? ` about the ${c.target.kind} \`${c.target.key}\`` : '';
    return `- **User note** of ${dayLabel(e.at)}${about}: "${c.text}" — ${usedIn}`;
  }
  if (e.kind === 'thread') {
    const prior = c.digests.filter((d) => d.at < digestAt).sort((a, b) => (a.at < b.at ? -1 : 1));
    const changes = prior.length === 0
      ? '  - _(no change before this one)_'
      : prior.map((d) => `  - ${dayLabel(d.at)}, ${relativeAge(d.at, digestAt, 'en')}: "${d.l0}"`).join('\n');
    const span = prior.length === 0 ? '' : ` — first ${dayLabel(prior[0].at)}, last ${dayLabel(prior[prior.length - 1].at)}`;
    return `- **Thread** "${c.title}"${span} — ${usedIn}\n${changes}`;
  }
  if (e.kind === 'term') {
    return `- **Term** \`${c.term}\`${c.meaning ? `: ${c.meaning}` : ''} — ${usedIn}`;
  }
  const links = `uses ${c.uses.length ? c.uses.map((u) => `\`${u}\``).join(', ') : 'none'}; used by ${c.usedBy.length ? c.usedBy.map((u) => `\`${u}\``).join(', ') : 'none'}`;
  return `- **Area** \`${c.path === '' ? '(project root)' : c.path}\`: ${links} — ${usedIn}`;
}

/**
 * The "Project memory available for this digest" section that follows both versions in a pair
 * file: what the memory-on arm was sent, with the provenance a reader needs to judge a continuity
 * claim (a user note's text and date, a thread's earlier changes with dates, term and area names).
 */
export function renderMemorySection(entries, digestAt) {
  const head = '## Project memory available for this digest';
  if (entries.length === 0) {
    return `${head}\n\n_None was sent: nothing in project memory was specific to this change, so any continuity claim needs support from the diff or the earlier pairs alone._\n`;
  }
  return [
    head, '',
    'What the memory-on version was given, besides the diff (one of the two versions above saw this, the other did not).',
    '',
    ...entries.map((e) => renderEntry(e, digestAt)),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// pair files and reader sheet
// ---------------------------------------------------------------------------

export function renderWalkthrough(w) {
  if (!w) return '_(no walkthrough for this digest)_\n';
  const steps = w.steps.map((s, i) => `${i + 1}. **${s.title}** — ${s.body}`).join('\n');
  const check = w.check.map((c) => `- ${c}`).join('\n');
  return `${w.overview}\n\n${steps}\n\n**Check:**\n${check}\n`;
}

export function renderVersion(d) {
  if (!d.l0 || !d.l1 || !d.l2) return '_(no stored explanation for this digest)_\n';
  const l1 = d.l1.bullets.map((b) => `- ${b}`).join('\n');
  const l2 = d.l2.items.map((it) => `### ${it.title} (\`${it.paths.join('`, `')}\`)\n\n${it.effect}\n\n${it.how}\n\n${it.why}\n`).join('\n');
  return [
    `**L0.** ${d.l0.text}`, '', '**L1.**', l1, '', '**L2.**', '', l2, '**Walkthrough** (`' + (d.areaId ?? 'n/a') + '`)', '',
    renderWalkthrough(d.walkthrough),
  ].join('\n');
}

/** One blinded pair file: both versions, then what memory the on arm had (`memory`, from `loadDigestMemory`). */
export function renderPair(title, versionA, versionB, memory, digestAt) {
  return [
    `# ${title}`, '', '## Version A', '', renderVersion(versionA), '', '## Version B', '', renderVersion(versionB), '',
    renderMemorySection(memory, digestAt),
  ].join('\n');
}

export const READER_SHEET = `# Memory A/B blind read (DIG-107, round 2: DIG-114)

For each pair (one markdown file per digest and language), read Version A and Version B without
looking at \`key.json\`, then answer:

1. **Continuity** — does one version connect this change to earlier work in a way that reads as
   informed, not guessed?
2. **The project's own names** — does one version use the project's own area/file/identifier names
   more precisely, instead of generic phrasing?
3. **Specificity** — does one version say something more concrete about this specific change,
   rather than something that could apply to almost any change?
4. **Correctness** — is either version wrong about what the diff actually does?

Each pair file ends with **"Project memory available for this digest"**: what one of the two
versions was given besides the diff (user notes with their dates, earlier changes in the same
thread with their dates, term and area names). It does not say which version had it.

**Unsupported claim** (docs/milestone-4-memory.md §6): a claim about earlier work, a convention or a
user decision is unsupported only if **neither** the diff **nor** the listed project memory / project
history (the earlier pairs of the same story) supports it. A claim that matches a listed user note
or an earlier change in the listed thread is supported, even if the diff alone does not show it.
Also note any version that talks about "memory" itself rather than citing its source (a user's note
of a date, an earlier change by name).

For each pair, record: which version you preferred overall (A, B or tie), and any unsupported claim
(name the file and quote it).

Pass bar (docs/milestone-4-memory.md §6): memory wins at least 7 of 10 pairs per language, with no
continuity claim that the slice does not support.
`;

// ---------------------------------------------------------------------------
// DB-derived metrics
// ---------------------------------------------------------------------------

/**
 * Whole-prompt tokens over every logged call (DIG-114 kit item 2): `prompt_tokens` (input + cache
 * creation + cache reads), falling back to `input_tokens` for a row logged without it.
 */
export function promptTokenTotal(db) {
  return db.prepare('SELECT COALESCE(SUM(COALESCE(prompt_tokens, input_tokens)), 0) AS n FROM explain_call').get().n;
}

/** A violation message with its specifics blanked, so the same rule counts once however it fired:
 * quoted and parenthesised text becomes "…"/(…) and standalone numbers become N ("l1: 72 words,
 * limit 60" -> "l1: N words, limit N"; the "1" in a field name such as "l1" is kept). */
export function violationRule(message) {
  return message.replace(/"[^"]*"/g, '"…"').replace(/\([^)]*\)/g, '(…)').replace(/\b\d+\b/g, 'N').trim();
}

/**
 * Per-arm validator findings (DIG-114 kit item 3), from `explain_call.violations` (DIG-94: hard
 * violations, style warnings and in-band length notes, joined with "; "): how many calls had any,
 * and counts per rule and per part kind, so a lower first-try rate can be traced to its rule.
 */
export function violationCounts(db) {
  const rows = db.prepare("SELECT part, violations FROM explain_call WHERE violations IS NOT NULL AND violations <> ''").all();
  const byRule = {};
  const byPart = {};
  let messages = 0;
  for (const r of rows) {
    const kind = (r.part ?? 'unknown').replace(/:.*$/, '');
    for (const m of r.violations.split('; ').filter(Boolean)) {
      const rule = violationRule(m);
      byRule[rule] = (byRule[rule] ?? 0) + 1;
      byPart[kind] = (byPart[kind] ?? 0) + 1;
      messages++;
    }
  }
  const sortedByRule = Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  return { callsWithViolations: rows.length, messages, byPart, byRule: sortedByRule };
}

/** Sums `violationCounts` results (one per pipeline) into one per-arm rollup. */
export function mergeViolationCounts(list) {
  const out = { callsWithViolations: 0, messages: 0, byPart: {}, byRule: {} };
  for (const v of list) {
    out.callsWithViolations += v.callsWithViolations;
    out.messages += v.messages;
    for (const [k, n] of Object.entries(v.byPart)) out.byPart[k] = (out.byPart[k] ?? 0) + n;
    for (const [k, n] of Object.entries(v.byRule)) out.byRule[k] = (out.byRule[k] ?? 0) + n;
  }
  out.byRule = Object.fromEntries(Object.entries(out.byRule).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  return out;
}
