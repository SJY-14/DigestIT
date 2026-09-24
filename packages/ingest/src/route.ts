import { runExplainCli } from '@digestit/explain';
import { runWatchCli } from './watch.js';

export const INGEST_USAGE = 'usage: digest ingest <path> [--db <file>]\n       digest watch <path> [--interval <seconds>] [--db <file>]\n       digest explain --all|--unit <id> [--concurrency N] [--max-calls N] [--budget-tokens N]';

/** Returns an exit code if the command was handled here (explain or usage error), or undefined for `ingest`. */
export async function routeDigest(argv: string[]): Promise<number | undefined> {
  const [cmd, path] = argv;
  if (cmd === 'explain') return runExplainCli(argv);
  if (cmd === 'watch' && path) return runWatchCli(argv);
  if (cmd !== 'ingest' || !path) {
    console.error(INGEST_USAGE);
    return 2;
  }
  return undefined;
}
