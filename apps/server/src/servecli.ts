import { parseArgs } from 'node:util';
import { resolvePort, startServer } from './serve.js';

export const SERVE_USAGE =
  'usage: digest serve [--port <n>] [--db <file>]\n' +
  '  env: DIGESTIT_PORT, DIGESTIT_DB, DIGESTIT_ALLOWED_HOSTS, DIGESTIT_TOKEN_FILE';

/** `digest serve`: resolves options, then starts listening and returns (the process stays alive on the open socket). */
export async function runServeCli(argv: string[]): Promise<number> {
  let values: { port?: string; db?: string };
  try {
    ({ values } = parseArgs({ args: argv.slice(1), options: { port: { type: 'string' }, db: { type: 'string' } } }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${SERVE_USAGE}`);
    return 2;
  }
  try {
    const port = values.port !== undefined ? resolvePort({ DIGESTIT_PORT: values.port }) : undefined;
    const app = await startServer({ dbPath: values.db ?? process.env.DIGESTIT_DB, port });
    console.log(`DigestIT listening on ${JSON.stringify(app.server.address())}`);
    return 0;
  } catch (e) {
    console.error(`serve failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
