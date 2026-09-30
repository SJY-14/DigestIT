import { runExplainCli } from '@digestit/explain';
import {
  runConfigCli, runContextCli, runIgnoreCli, runInitCli, runProjectExplainCli, runProjectsCli, runRemoveCli,
  runStatusCli,
} from './project-cli.js';
import { runManualExplainCli, runWatchCli } from './watch.js';

export const INGEST_USAGE = 'usage: digest ingest <path> [--db <file>]\n       digest watch <path> [--interval <seconds>] [--db <file>] [--provider <name>] [--budget <calls/day>] [--no-explain]\n       digest explain --unit <work-unit key>   (on demand, counts toward the daily budget)\n       digest explain --all|--unit <id> [--concurrency N] [--max-calls N] [--budget-tokens N]\n       digest init <path> [--name <name>] [--context <file.md>] [--language <en|ko>] [--ignore <pattern>]...\n       digest ignore <project> add|remove|list [pattern...]   (per-project ignore patterns, gitignore syntax)\n       digest projects\n       digest remove <project>   (soft-remove; history is kept, restored if the same root is registered again)\n       digest status [project]\n       digest config <project> --language <en|ko>\n       digest context [project]   (rebuild the project context now; one LLM call)\n       digest explain [project] [--retry <digestId>]   (project digest; see docs/direction-v2.md)\n       digest serve [--port <n>] [--db <file>]\n       digest token init --host <host[:port]> [--file <path>]   (see docs/operations.md)';

/** Returns an exit code if the command was handled here (explain or usage error), or undefined for `ingest`. */
export async function routeDigest(argv: string[]): Promise<number | undefined> {
  const [cmd, path] = argv;
  if (cmd === 'explain') {
    // `--all`/`--unit` stay on the v1 (commit/work-unit) explain; everything else is the v2 project digest.
    if (argv.includes('--all')) return runExplainCli(argv);
    const i = argv.indexOf('--unit');
    if (i >= 0) {
      const unit = argv[i + 1];
      // A non-numeric --unit is a work-unit key (scheduler, manual reason); numbers stay change-unit ids.
      return unit !== undefined && !/^\d+(,\d+)*$/.test(unit) ? runManualExplainCli(argv) : runExplainCli(argv);
    }
    return runProjectExplainCli(argv);
  }
  if (cmd === 'init' && path) return runInitCli(argv);
  if (cmd === 'ignore' && path) return runIgnoreCli(argv);
  if (cmd === 'projects') return runProjectsCli(argv);
  if (cmd === 'remove' && path) return runRemoveCli(argv);
  if (cmd === 'status') return runStatusCli(argv);
  if (cmd === 'config') return runConfigCli(argv);
  if (cmd === 'context') return runContextCli(argv);
  if (cmd === 'watch' && path) return runWatchCli(argv);
  if (cmd !== 'ingest' || !path) {
    console.error(INGEST_USAGE);
    return 2;
  }
  return undefined;
}
