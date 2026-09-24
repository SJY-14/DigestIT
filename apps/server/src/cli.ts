#!/usr/bin/env node
import { startServer } from './serve.js';

const app = await startServer({ dbPath: process.env.DIGESTIT_DB });
console.log(`DigestIT listening on ${JSON.stringify(app.server.address())}`);
