#!/usr/bin/env node
import { runExplainCli } from './run-cli.js';

process.exitCode = await runExplainCli(process.argv.slice(2));
