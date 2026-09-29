#!/usr/bin/env node
import { runLintReportCli } from './lint-report.js';
import { runExplainCli } from './run-cli.js';

const argv = process.argv.slice(2);
process.exitCode = argv[0] === 'lint-report' ? await runLintReportCli(argv.slice(1)) : await runExplainCli(argv);
