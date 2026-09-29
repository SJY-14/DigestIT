import type { DatabaseSync } from 'node:sqlite';

/** Read-only percentiles per `(part kind, model, effort)`, over the DIG-73 timing columns. */
export interface TimingStat {
  p50: number;
  p90: number;
  p99: number;
}

export interface TimingPercentiles {
  part: string;
  model: string | null;
  effort: string | null;
  /** Calls with a non-null value for each stat; may differ slightly between stats on old rows. */
  count: number;
  startupMs: TimingStat;
  ttftMs: TimingStat;
  genMs: TimingStat;
  inputTokens: Pick<TimingStat, 'p50'>;
  outputTokens: Pick<TimingStat, 'p50'>;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

interface Row {
  part: string;
  model: string | null;
  effort: string | null;
  startup_ms: number | null;
  ttft_ms: number | null;
  gen_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * Percentiles per part/model/effort, over `ok` calls with `part` set (the DIG-73/74 timed calls;
 * pre-DIG-73 rows have no `part` and are excluded). Read-only: no writes, no provider calls.
 */
export function timingReport(db: DatabaseSync, opts: { since?: Date } = {}): TimingPercentiles[] {
  const since = (opts.since ?? new Date(0)).toISOString();
  const rows = db.prepare(
    `SELECT part, model, effort, startup_ms, ttft_ms, gen_ms, input_tokens, output_tokens
       FROM explain_call WHERE part IS NOT NULL AND outcome = 'ok' AND at >= ?
       ORDER BY part, model, effort`,
  ).all(since) as unknown as Row[];

  interface Group {
    part: string; model: string | null; effort: string | null;
    startup: number[]; ttft: number[]; gen: number[]; input: number[]; output: number[];
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    // `area:<id>` and `walkthrough:<id>` are grouped by kind; per-area percentiles say nothing.
    r.part = r.part.replace(/:.*$/, '');
    const key = `${r.part}\u0000${r.model ?? ''}\u0000${r.effort ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { part: r.part, model: r.model, effort: r.effort, startup: [], ttft: [], gen: [], input: [], output: [] };
      groups.set(key, g);
    }
    if (r.startup_ms !== null) g.startup.push(r.startup_ms);
    if (r.ttft_ms !== null) g.ttft.push(r.ttft_ms);
    if (r.gen_ms !== null) g.gen.push(r.gen_ms);
    if (r.input_tokens !== null) g.input.push(r.input_tokens);
    if (r.output_tokens !== null) g.output.push(r.output_tokens);
  }

  return [...groups.values()].map((g) => {
    for (const arr of [g.startup, g.ttft, g.gen, g.input, g.output]) arr.sort((a, b) => a - b);
    return {
      part: g.part, model: g.model, effort: g.effort, count: g.startup.length,
      startupMs: { p50: percentile(g.startup, 50), p90: percentile(g.startup, 90), p99: percentile(g.startup, 99) },
      ttftMs: { p50: percentile(g.ttft, 50), p90: percentile(g.ttft, 90), p99: percentile(g.ttft, 99) },
      genMs: { p50: percentile(g.gen, 50), p90: percentile(g.gen, 90), p99: percentile(g.gen, 99) },
      inputTokens: { p50: percentile(g.input, 50) },
      outputTokens: { p50: percentile(g.output, 50) },
    };
  });
}

export function formatTimingReport(rows: readonly TimingPercentiles[]): string {
  if (rows.length === 0) return 'no timed explain_call rows yet (part/startup_ms/... are set from DIG-74 onward)';
  return rows
    .map((r) =>
      `${r.part} ${r.model ?? '-'}/${r.effort ?? '-'}: n=${r.count}  ` +
      `startup p50/p90/p99=${r.startupMs.p50}/${r.startupMs.p90}/${r.startupMs.p99}ms  ` +
      `ttft p50/p90/p99=${r.ttftMs.p50}/${r.ttftMs.p90}/${r.ttftMs.p99}ms  ` +
      `gen p50/p90/p99=${r.genMs.p50}/${r.genMs.p90}/${r.genMs.p99}ms  ` +
      `tokens in/out p50=${r.inputTokens.p50}/${r.outputTokens.p50}`,
    )
    .join('\n');
}
