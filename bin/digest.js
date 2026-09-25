#!/usr/bin/env node
// Thin dispatcher so `digest <cmd>` stays one entry point: `serve`/`token` live in apps/server
// (they need the Fastify app); everything else (`ingest`/`watch`/`explain`) lives in
// packages/ingest. apps/server already depends on packages/ingest, so routing it the other way
// would be circular — this dispatcher is what keeps the two CLIs under one command instead.
const cmd = process.argv[2];
const target =
  cmd === 'serve' || cmd === 'token'
    ? new URL('../apps/server/dist/cli.js', import.meta.url)
    : new URL('../packages/ingest/dist/cli.js', import.meta.url);
await import(target);
