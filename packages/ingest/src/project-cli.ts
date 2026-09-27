import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openProjectDb } from './datahome.js';
import { DEFAULT_DAILY_BUDGET } from './scheduler.js';
import { intOpt, providerFromArgs } from './watch.js';
import {
  ProjectLockedError, explainProject, findProject, initProject, latestCheckpoint, listProjects,
  projectStatus, retryDigest, type ExplainProjectResult,
} from './project.js';
import { buildContext, ensureContext, latestContextText } from './project-context.js';

export const INIT_USAGE = 'usage: digest init <path> [--name <name>] [--context <file.md>] [--db <file>]';

function summarizeSkipped(skipped: readonly { path: string; reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} ${reason}`).join(', ');
}

export async function runInitCli(argv: string[]): Promise<number> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: { name: { type: 'string' }, context: { type: 'string' }, db: { type: 'string' } },
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${INIT_USAGE}`);
    return 2;
  }
  const path = positionals[0];
  if (!path) {
    console.error(INIT_USAGE);
    return 2;
  }
  const { db, home } = openProjectDb(values.db ?? process.env.DIGESTIT_DB);
  try {
    const r = await initProject(db, home, path, { name: values.name, contextPath: values.context });
    if (!r.created) {
      console.log(`project "${r.name}" (id ${r.repoId}) is already registered at ${r.path}`);
      console.log(`data dir: ${r.dataDir}`);
      return 0;
    }
    console.log(`registered project "${r.name}" (id ${r.repoId}) at ${r.path}`);
    console.log(`data dir: ${r.dataDir}`);
    console.log(
      `checkpoint #1 taken: ${r.tracked} file(s) will be sent to the provider on the next \`digest explain\`` +
        (r.skipped.length > 0 ? `; skipped ${summarizeSkipped(r.skipped)}` : ''),
    );
    if (values.context) console.log(`context file: ${resolve(values.context)}`);
    return 0;
  } catch (e) {
    console.error(`init failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }
}

export async function runProjectsCli(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: argv.slice(1), options: { db: { type: 'string' } } }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { db } = openProjectDb(values.db ?? process.env.DIGESTIT_DB);
  try {
    const projects = listProjects(db);
    if (projects.length === 0) {
      console.log('no projects registered; run `digest init <path>`');
      return 0;
    }
    for (const p of projects) {
      const latest = latestCheckpoint(db, p.id);
      console.log(`${p.id}\t${p.name}\t${p.path}\t${latest ? `checkpoint #${latest.seq} at ${latest.takenAt}` : 'no checkpoints'}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function runStatusCli(argv: string[]): Promise<number> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: { db: { type: 'string' } } }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const limit = intOpt(process.env.DIGESTIT_DAILY_BUDGET);
  const { db, home } = openProjectDb(values.db ?? process.env.DIGESTIT_DB);
  try {
    const found = findProject(db, positionals[0]);
    if ('error' in found) {
      console.error(found.error);
      return 1;
    }
    const s = await projectStatus(db, home, found, new Date(), limit && !Number.isNaN(limit) ? limit : DEFAULT_DAILY_BUDGET);
    console.log(`${found.name}: ${s.pending.files} file(s) changed, +${s.pending.additions} -${s.pending.deletions} since last check`);
    console.log(`budget: ${s.budget.used}/${s.budget.limit} used today, ${s.budget.remaining} remaining (resets ${s.budget.resetsAt})`);
    if (s.explaining) console.log('an explain is currently running for this project');
    return 0;
  } finally {
    db.close();
  }
}

export const EXPLAIN_PROJECT_USAGE =
  'usage: digest explain [project] [--retry <digestId>] [--provider <name>] [--allow <repo,...>] [--budget <n>] [--db <file>]';

function report(r: ExplainProjectResult): void {
  const suffix = r.detail ? ` (${r.detail.slice(0, 160)})` : '';
  console.log(`digest ${r.digestId}: ${r.outcome}${suffix}, ${r.calls} provider call(s)`);
  if (r.outcome === 'budget' || r.outcome === 'error') console.log(`retry with: digest explain --retry ${r.digestId}`);
}

const outcomeExit = (r: ExplainProjectResult): number => (r.outcome === 'error' ? 1 : 0);

export async function runProjectExplainCli(argv: string[]): Promise<number> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        retry: { type: 'string' }, provider: { type: 'string' }, allow: { type: 'string' },
        budget: { type: 'string' }, db: { type: 'string' },
      },
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${EXPLAIN_PROJECT_USAGE}`);
    return 2;
  }
  const budget = intOpt(values.budget ?? process.env.DIGESTIT_DAILY_BUDGET);
  if (Number.isNaN(budget)) {
    console.error(EXPLAIN_PROJECT_USAGE);
    return 2;
  }
  const { db, home } = openProjectDb(values.db ?? process.env.DIGESTIT_DB);
  try {
    if (values.retry) {
      const digestId = Number(values.retry);
      if (!Number.isInteger(digestId)) {
        console.error('--retry expects a digest id');
        return 2;
      }
      const row = db.prepare(
        'SELECT r.id AS id, r.name AS name FROM digest d JOIN repo r ON r.id = d.repo_id WHERE d.change_unit_id = ?',
      ).get(digestId) as { id: number; name: string } | undefined;
      if (!row) {
        console.error(`no digest ${digestId}`);
        return 1;
      }
      const provider = providerFromArgs({ provider: values.provider, allow: values.allow ?? process.env.DIGESTIT_ALLOWLIST ?? row.name });
      if (!provider) {
        console.error('unknown provider');
        return 2;
      }
      const r = await retryDigest(db, home, digestId, provider, { context: latestContextText(db, row.id), budget: budget ?? DEFAULT_DAILY_BUDGET });
      report(r);
      return outcomeExit(r);
    }
    const found = findProject(db, positionals[0]);
    if ('error' in found) {
      console.error(found.error);
      return 1;
    }
    const provider = providerFromArgs({ provider: values.provider, allow: values.allow ?? process.env.DIGESTIT_ALLOWLIST ?? found.name });
    if (!provider) {
      console.error('unknown provider');
      return 2;
    }
    const limit = budget ?? DEFAULT_DAILY_BUDGET;
    const context = async () => {
      try {
        if (await ensureContext(db, home, found, provider, { budget: limit })) console.log(contextLine(db, found.id));
      } catch (e) {
        console.error(`project context not built: ${e instanceof Error ? e.message : String(e)}`);
      }
      return latestContextText(db, found.id);
    };
    const r = await explainProject(db, home, found, provider, { context, budget: limit });
    if (r.noChanges) {
      console.log('No changes since last check');
      return 0;
    }
    report(r);
    return outcomeExit(r);
  } catch (e) {
    if (e instanceof ProjectLockedError) {
      console.error(e.message);
      return 1;
    }
    console.error(`explain failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }
}

function contextLine(db: import('node:sqlite').DatabaseSync, repoId: number): string {
  const row = db.prepare(
    'SELECT status, from_files AS fromFiles FROM project_context WHERE repo_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
  ).get(repoId) as { status: string; fromFiles: number | null } | undefined;
  return row ? `project context: ${row.status}, from ${row.fromFiles ?? '?'} file(s)` : 'project context: none';
}

export const CONTEXT_USAGE = 'usage: digest context [project] [--provider <name>] [--allow <repo,...>] [--budget <n>] [--db <file>]';

/** `digest context [project]`: rebuilds the project context now (one call against the daily budget). */
export async function runContextCli(argv: string[]): Promise<number> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: { provider: { type: 'string' }, allow: { type: 'string' }, budget: { type: 'string' }, db: { type: 'string' } },
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${CONTEXT_USAGE}`);
    return 2;
  }
  const budget = intOpt(values.budget ?? process.env.DIGESTIT_DAILY_BUDGET);
  if (Number.isNaN(budget)) {
    console.error(CONTEXT_USAGE);
    return 2;
  }
  const { db, home } = openProjectDb(values.db ?? process.env.DIGESTIT_DB);
  try {
    const found = findProject(db, positionals[0]);
    if ('error' in found) {
      console.error(found.error);
      return 1;
    }
    const provider = providerFromArgs({ provider: values.provider, allow: values.allow ?? process.env.DIGESTIT_ALLOWLIST ?? found.name });
    if (!provider) {
      console.error('unknown provider');
      return 2;
    }
    const r = await buildContext(db, home, found, provider, { budget: budget ?? DEFAULT_DAILY_BUDGET });
    if (r.outcome === 'budget') {
      console.error('daily LLM budget exhausted; context not rebuilt');
      return 1;
    }
    console.log(contextLine(db, found.id));
    return r.outcome === 'error' ? 1 : 0;
  } catch (e) {
    console.error(`context failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }
}
