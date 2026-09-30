// Context `.md` -> `note` items (docs/milestone-4-memory.md §1 "note"): one item per heading
// section, refreshed when the section's own text changes (a whole-file hash would re-touch every
// section on any edit; comparing each section's own text instead means an edit to one heading
// never bumps the version of the others). A note the user already corrected (`source: 'user'`,
// `origin: 'correction'`) is a different item at a different key and is never touched here.
import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { redact } from '@digestit/explain';
import { MEMORY_LIMITS, type NoteMemory } from '@digestit/core';
import { getMemoryItem, listMemoryItems, markStale, upsertMemoryItem } from './memory.js';
import type { ProjectRow } from './project.js';

export interface MarkdownSection {
  slug: string;
  heading: string;
  text: string;
}

function slugifyHeading(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

/** One section per heading (any of `#`..`######`); text before the first heading, if any, becomes
 * a `preamble` section. An empty section (a heading with no body before the next one) is dropped. */
export function splitMarkdownSections(md: string): MarkdownSection[] {
  const lines = md.split(/\r?\n/);
  const raw: { heading: string; body: string[] }[] = [];
  const preamble: string[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (current) raw.push(current);
      current = { heading: h[2]!, body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) raw.push(current);

  const sections: MarkdownSection[] = [];
  const seen = new Set<string>();
  const addSlug = (base: string): string => {
    let slug = base;
    for (let n = 2; seen.has(slug); n++) slug = `${base}-${n}`;
    seen.add(slug);
    return slug;
  };
  const preambleText = preamble.join('\n').trim();
  if (preambleText) sections.push({ slug: addSlug('preamble'), heading: '', text: preambleText });
  for (const r of raw) {
    const text = r.body.join('\n').trim();
    if (!text) continue;
    sections.push({ slug: addSlug(slugifyHeading(r.heading)), heading: r.heading, text });
  }
  return sections;
}

function capNote(text: string): string {
  return text.length > MEMORY_LIMITS.noteChars ? text.slice(0, MEMORY_LIMITS.noteChars) : text;
}

/**
 * Syncs the project's context `.md` into `note` items, one per heading section. Returns the number
 * of sections created or updated. A no-op (0) when the project has no context file, or it no
 * longer exists on disk.
 */
export function updateContextNotes(
  db: DatabaseSync, batchId: number, project: ProjectRow, now: () => Date = () => new Date(),
): number {
  if (!project.contextPath || !existsSync(project.contextPath)) return 0;
  const sections = splitMarkdownSections(readFileSync(project.contextPath, 'utf8'));
  const seenKeys = new Set<string>();
  let upserted = 0;
  for (const s of sections) {
    seenKeys.add(s.slug);
    const content: NoteMemory = { kind: 'note', text: capNote(redact(s.text)), target: null, origin: 'context-md' };
    const existing = getMemoryItem(db, project.id, 'note', s.slug, null);
    if (existing?.status === 'hidden') continue;
    if (existing && existing.status === 'active' && JSON.stringify(existing.content) === JSON.stringify(content)) continue;
    upsertMemoryItem(db, batchId, project.id, 'note', s.slug, null, content, 'user', {
      files: [project.contextPath], checkpointId: null, digestIds: [], jobId: null,
    }, now);
    upserted++;
  }
  for (const existing of listMemoryItems(db, project.id, { kind: 'note' })) {
    if (existing.status === 'hidden' || existing.status === 'stale') continue;
    if ((existing.content as NoteMemory).origin !== 'context-md') continue; // a correction note is never auto-staled
    if (!seenKeys.has(existing.key)) markStale(db, batchId, existing.id, now);
  }
  return upserted;
}
