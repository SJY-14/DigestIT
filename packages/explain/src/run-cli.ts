import { parseArgs } from 'node:util';
import { openDb } from '@digestit/core';
import { createProvider } from './config.js';
import { DEFAULT_BUDGET, explainAll } from './pipeline.js';

export const USAGE = `usage: digest explain --all|--unit <id,...> [options]   (also: digest-explain ...)
  --db <file>             SQLite file (default $DIGESTIT_DB or .cache/digestit.sqlite)
  --provider <name>       stub | claude-code (default $DIGESTIT_PROVIDER or stub)
  --allow <repo,...>      repo allowlist (default $DIGESTIT_ALLOWLIST or DigestIT)
  --unit <id,...>         only these change unit ids instead of --all
  --concurrency <n>       parallel provider calls (default 2)
  --max-calls <n>         per-run cap on provider calls, retries included (default ${DEFAULT_BUDGET.maxCalls})
  --budget-tokens <n>     per-run cap on estimated input tokens (default ${DEFAULT_BUDGET.maxTokens})`;

function num(name: string, v: string | undefined): number | undefined | 'bad' {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--${name} must be a positive integer`);
    return 'bad';
  }
  return n;
}

/** Runs `digest-explain` / `digest explain`; argv excludes node and script. Returns the exit code. */
export async function runExplainCli(args: string[]): Promise<number> {
  const argv = [...args];
  if (argv[0] === 'explain') argv.shift();

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        all: { type: 'boolean' }, db: { type: 'string' }, provider: { type: 'string' }, allow: { type: 'string' },
        unit: { type: 'string' }, concurrency: { type: 'string' }, 'max-calls': { type: 'string' }, 'budget-tokens': { type: 'string' },
      },
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  if (!values.all && !values.unit) {
    console.error(USAGE);
    return 2;
  }
  const providerName = values.provider ?? process.env.DIGESTIT_PROVIDER ?? 'stub';
  if (providerName !== 'stub' && providerName !== 'claude-code') {
    console.error(`unknown provider: ${providerName}`);
    return 2;
  }
  const only = values.unit?.split(',').map(Number);
  if (only?.some((n) => !Number.isInteger(n))) {
    console.error('--unit expects comma-separated integers');
    return 2;
  }
  const concurrency = num('concurrency', values.concurrency);
  const maxCalls = num('max-calls', values['max-calls']);
  const maxTokens = num('budget-tokens', values['budget-tokens']);
  if (concurrency === 'bad' || maxCalls === 'bad' || maxTokens === 'bad') return 2;

  const provider = createProvider({
    provider: providerName,
    repoAllowlist: (values.allow ?? process.env.DIGESTIT_ALLOWLIST ?? 'DigestIT').split(',').map((s) => s.trim()).filter(Boolean),
    claudeBin: process.env.DIGESTIT_CLAUDE_BIN,
    claudeModel: process.env.DIGESTIT_CLAUDE_MODEL,
  });

  const db = openDb(values.db ?? process.env.DIGESTIT_DB);
  try {
    const s = await explainAll(db, provider, {
      concurrency,
      budget: { maxCalls, maxTokens },
      only,
      onResult: (r) => {
        if (r.outcome !== 'cached') console.log(`unit ${r.changeUnitId}: ${r.outcome}${r.detail ? ` (${r.detail.slice(0, 120)})` : ''}`);
      },
    });
    console.log(
      `explain (${provider.id}): ${s.total} units — ${s.ok} ok, ${s.truncated} truncated, ${s.error} error, ${s.cached} cached, ` +
        `${s.skippedByBudget} not started (budget); ${s.calls} provider calls, ~${s.estimatedTokens} input tokens`,
    );
    if (s.skippedByBudget > 0) console.log('budget cap reached; run again to continue');
    return s.error > 0 ? 1 : 0;
  } catch (e) {
    console.error(`explain failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }
}
