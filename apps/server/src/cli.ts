#!/usr/bin/env node
import { runTokenCli, TOKEN_USAGE } from './auth.js';
import { runServeCli, SERVE_USAGE } from './servecli.js';

const argv = process.argv.slice(2);
const [cmd] = argv;

if (cmd === 'serve') {
  const code = await runServeCli(argv);
  if (code !== 0) process.exit(code); // on success, stay alive: the server is listening
} else if (cmd === 'token') {
  process.exit(runTokenCli(argv));
} else {
  console.error(`${SERVE_USAGE}\n${TOKEN_USAGE}`);
  process.exit(2);
}
