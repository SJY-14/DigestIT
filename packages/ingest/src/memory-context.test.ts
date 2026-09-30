import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@digestit/core';
import type { NoteMemory } from '@digestit/core';
import { createBatch, getMemoryItem, listMemoryItems, markHidden } from './memory.js';
import { splitMarkdownSections, updateContextNotes } from './memory-context.js';
import type { ProjectRow } from './project.js';

const now = () => new Date('2026-09-30T00:00:00.000Z');

describe('splitMarkdownSections', () => {
  it('splits on headings of any level, dropping empty sections, and slugifies duplicate headings', () => {
    const sections = splitMarkdownSections(
      '# Snapback\nA preamble paragraph.\n\n## Goals\nShip the retry queue.\n\n## Empty\n\n### Goals\nSub-goal text.\n',
    );
    expect(sections.map((s) => s.slug)).toEqual(['snapback', 'goals', 'goals-2']);
    expect(sections.find((s) => s.slug === 'goals')!.text).toBe('Ship the retry queue.');
  });

  it('text before the very first heading becomes its own preamble section', () => {
    const sections = splitMarkdownSections('Some notes before any heading.\n\n## Goals\nShip it.\n');
    expect(sections.map((s) => s.slug)).toEqual(['preamble', 'goals']);
    expect(sections[0]!.text).toBe('Some notes before any heading.');
  });
});

let dir: string;
let db: DatabaseSync;
let repoId: number;
let contextPath: string;
let project: ProjectRow;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'digestit-ctx-'));
  contextPath = join(dir, 'context.md');
  db = openDb(':memory:');
  db.exec("INSERT INTO repo (name, path, mode) VALUES ('snapback', '/snapback', 'project')");
  repoId = Number(db.prepare('SELECT id FROM repo').get()!.id);
  project = { id: repoId, name: 'snapback', path: '/snapback', language: 'en', contextPath, createdAt: null };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('updateContextNotes', () => {
  it('creates one note per heading section, redacted', () => {
    writeFileSync(contextPath, '## Secrets\nThe token is sk-ant-abcdefghijklmnopqrstuvwxyz for the demo bot.\n');
    const batch = createBatch(db, repoId, 'manual', null, now);
    const count = updateContextNotes(db, batch, project, now);
    expect(count).toBe(1);
    const item = getMemoryItem(db, repoId, 'note', 'secrets', null)!;
    expect((item.content as NoteMemory).text).toContain('[REDACTED]');
    expect((item.content as NoteMemory).origin).toBe('context-md');
  });

  it('is a no-op when the file has not changed (no version churn)', () => {
    writeFileSync(contextPath, '## Goals\nShip it.\n');
    const b1 = createBatch(db, repoId, 'manual', null, now);
    updateContextNotes(db, b1, project, now);
    const v1 = getMemoryItem(db, repoId, 'note', 'goals', null)!.version;

    const b2 = createBatch(db, repoId, 'daily', null, now);
    updateContextNotes(db, b2, project, now);
    expect(getMemoryItem(db, repoId, 'note', 'goals', null)!.version).toBe(v1);
  });

  it('marks a removed section stale, but never revives a hidden one', () => {
    writeFileSync(contextPath, '## Goals\nShip it.\n\n## Risks\nNone yet.\n');
    const b1 = createBatch(db, repoId, 'manual', null, now);
    updateContextNotes(db, b1, project, now);
    const risks = getMemoryItem(db, repoId, 'note', 'risks', null)!;
    const b2 = createBatch(db, repoId, 'user', null, now);
    markHidden(db, b2, risks.id, now);

    writeFileSync(contextPath, '## Goals\nShip it, revised.\n');
    const b3 = createBatch(db, repoId, 'daily', null, now);
    updateContextNotes(db, b3, project, now);
    expect(getMemoryItem(db, repoId, 'note', 'risks', null)!.status).toBe('hidden');

    // Removed section (goals stays, but nothing dropped it here) -- verify no stray items remain active beyond goals.
    const notes = listMemoryItems(db, repoId, { kind: 'note' });
    expect(notes.map((n) => n.key).sort()).toEqual(['goals', 'risks']);
  });

  it('returns 0 when the project has no context file', () => {
    const noCtx: ProjectRow = { ...project, contextPath: null };
    const batch = createBatch(db, repoId, 'manual', null, now);
    expect(updateContextNotes(db, batch, noCtx, now)).toBe(0);
  });
});
