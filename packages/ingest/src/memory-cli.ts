import { parseArgs } from 'node:util';
import type { MemoryKind, MemoryStatus } from '@digestit/core';
import { openProjectDb } from './datahome.js';
import { findProject } from './project.js';
import { clearMemory, exportMemory, getBatch, listMemoryItems, rollbackBatch } from './memory.js';
import { updateProjectMemory } from './memory-update.js';

export const MEMORY_USAGE =
  'usage: digest memory update [project] [--db <file>]\n' +
  '       digest memory show [project] [--kind area|term|thread|note] [--status active|stale|hidden] [--db <file>]\n' +
  '       digest memory export [project] [--db <file>]\n' +
  '       digest memory clear [project] [--db <file>]\n' +
  '       digest memory rollback [project] <batch> [--db <file>]';

const MEMORY_KINDS = ['area', 'term', 'thread', 'note'] as const;
const MEMORY_STATUSES = ['active', 'stale', 'hidden'] as const;
const isMemoryKind = (v: string | undefined): v is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(v ?? '');
const isMemoryStatus = (v: string | undefined): v is MemoryStatus => (MEMORY_STATUSES as readonly string[]).includes(v ?? '');

export async function runMemoryCli(argv: string[]): Promise<number> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: { db: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' } },
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${MEMORY_USAGE}`);
    return 2;
  }
  const [subcommand, projectRef, batchArg] = positionals;
  if (subcommand === undefined || !['update', 'show', 'export', 'clear', 'rollback'].includes(subcommand)) {
    console.error(MEMORY_USAGE);
    return 2;
  }
  if (values.kind !== undefined && !isMemoryKind(values.kind)) {
    console.error(`unknown --kind "${values.kind}"; expected one of: ${MEMORY_KINDS.join(', ')}`);
    return 2;
  }
  if (values.status !== undefined && !isMemoryStatus(values.status)) {
    console.error(`unknown --status "${values.status}"; expected one of: ${MEMORY_STATUSES.join(', ')}`);
    return 2;
  }

  const { db, home } = openProjectDb(values.db ?? process.env.DIGESTIT_DB);
  try {
    if (subcommand === 'rollback') {
      const batchId = Number(batchArg);
      if (!batchArg || !Number.isInteger(batchId)) {
        console.error(`${MEMORY_USAGE}\na batch id is required for rollback`);
        return 2;
      }
      const target = getBatch(db, batchId);
      if (!target) {
        console.error(`no memory batch ${batchId}`);
        return 1;
      }
      const result = rollbackBatch(db, batchId);
      console.log(`rolled back batch ${batchId}: ${result.restored} item(s) restored, ${result.hidden} item(s) hidden (new batch ${result.batchId})`);
      return 0;
    }

    const found = findProject(db, projectRef);
    if ('error' in found) {
      console.error(found.error);
      return 1;
    }

    if (subcommand === 'update') {
      const result = await updateProjectMemory(db, home, found, 'manual');
      console.log(
        `${found.name}: areas ${result.areasChanged} changed / ${result.areasStale} stale, ` +
        `terms ${result.termsChanged} changed / ${result.termsStale} stale, ` +
        `notes ${result.notesChanged} changed, threads ${result.threadsChanged} changed (batch ${result.batchId})`,
      );
      return 0;
    }
    if (subcommand === 'show') {
      const items = listMemoryItems(db, found.id, {
        kind: isMemoryKind(values.kind) ? values.kind : undefined,
        status: isMemoryStatus(values.status) ? values.status : undefined,
      });
      if (items.length === 0) {
        console.log(`${found.name}: no memory items`);
        return 0;
      }
      for (const item of items) {
        console.log(`${item.id}\t${item.kind}\t${item.key}\t${item.status}\tv${item.version}${item.pinned ? '\tpinned' : ''}`);
      }
      return 0;
    }
    if (subcommand === 'export') {
      console.log(JSON.stringify(exportMemory(db, found.id), null, 2));
      return 0;
    }
    // clear
    const result = clearMemory(db, found.id);
    console.log(`${found.name}: cleared ${result.itemsDeleted} item(s), ${result.batchesDeleted} batch(es)`);
    return 0;
  } finally {
    db.close();
  }
}
