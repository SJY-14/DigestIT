import { runExplainCli } from '@digestit/explain';
import { runManualExplainCli, runWatchCli } from './watch.js';

export const INGEST_USAGE = 'usage: digest ingest <path> [--db <file>]\n       digest watch <path> [--interval <seconds>] [--db <file>] [--provider <name>] [--budget <calls/day>] [--no-explain]\n       digest explain --unit <work-unit key>   (on demand, counts toward the daily budget)\n       digest explain --all|--unit <id> [--concurrency N] [--max-calls N] [--budget-tokens N]';

/** Returns an exit code if the command was handled here (explain or usage error), or undefined for `ingest`. */
export async function routeDigest(argv: string[]): Promise<number | undefined> {
  const [cmd, path] = argv;
  if (cmd === 'explain') {
    // A non-numeric --unit is a work-unit key (scheduler, manual reason); numbers stay change-unit ids.
    const i = argv.indexOf('--unit');
    const unit = i >= 0 ? argv[i + 1] : undefined;
    if (unit !== undefined && !/^\d+(,\d+)*$/.test(unit)) return runManualExplainCli(argv);
    return runExplainCli(argv);
  }
  if (cmd === 'watch' && path) return runWatchCli(argv);
  if (cmd !== 'ingest' || !path) {
    console.error(INGEST_USAGE);
    return 2;
  }
  return undefined;
}
