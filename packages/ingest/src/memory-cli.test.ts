import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInitCli } from './project-cli.js';
import { runMemoryCli } from './memory-cli.js';

let root: string;
let proj: string;
let dbPath: string;
let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const write = (name: string, content: string) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'digest-memory-cli-'));
  proj = join(root, 'project');
  dbPath = join(root, 'home', 'digestit.sqlite');
  mkdirSync(proj, { recursive: true });
  logs = [];
  errs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(s); });
  errSpy = vi.spyOn(console, 'error').mockImplementation((s: string) => { errs.push(s); });
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('runMemoryCli', () => {
  it('update|show|export|clear|rollback round-trip against a real project', async () => {
    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\n`);
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);

    expect(await runMemoryCli(['memory', 'update', 'demo', '--db', dbPath])).toBe(0);
    expect(logs.join('\n')).toContain('areas 1 changed');
    logs = [];

    expect(await runMemoryCli(['memory', 'show', 'demo', '--db', dbPath, '--kind', 'area'])).toBe(0);
    expect(logs.join('\n')).toContain('area\tsrc\tactive\tv1');
    logs = [];

    expect(await runMemoryCli(['memory', 'export', 'demo', '--db', dbPath])).toBe(0);
    const dump = JSON.parse(logs.join('')) as { items: { kind: string; key: string }[] };
    expect(dump.items.some((i) => i.kind === 'area' && i.key === 'src')).toBe(true);
    logs = [];

    expect(await runMemoryCli(['memory', 'clear', 'demo', '--db', dbPath])).toBe(0);
    expect(logs.join('\n')).toContain('cleared 2 item(s), 1 batch(es)'); // the area and its one term
  });

  it('rollback restores a rolled-back batch\'s items and reports the new batch id', async () => {
    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\n`);
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    await runMemoryCli(['memory', 'update', 'demo', '--db', dbPath]);
    logs = [];

    write('src/index.ts', `export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n`);
    await runMemoryCli(['memory', 'update', 'demo', '--db', dbPath]);
    const batchLine = logs.find((l) => l.includes('batch'))!;
    const secondBatchId = Number(/batch (\d+)/.exec(batchLine)![1]);
    logs = [];

    expect(await runMemoryCli(['memory', 'rollback', 'demo', String(secondBatchId), '--db', dbPath])).toBe(0);
    expect(logs.join('\n')).toContain('1 item(s) restored');

    logs = [];
    await runMemoryCli(['memory', 'show', 'demo', '--db', dbPath, '--kind', 'term', '--status', 'active']);
    expect(logs.join('\n')).not.toContain('sub'); // 'sub' only existed after the rolled-back batch
    logs = [];
    await runMemoryCli(['memory', 'show', 'demo', '--db', dbPath, '--kind', 'term', '--status', 'hidden']);
    expect(logs.join('\n')).toContain('sub'); // hidden, not silently dropped (items are never hard-deleted)
  });

  it('rejects an unknown --kind, and a missing batch id for rollback', async () => {
    write('a.ts', 'export const x = 1;\n');
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    expect(await runMemoryCli(['memory', 'show', 'demo', '--db', dbPath, '--kind', 'bogus'])).toBe(2);
    expect(errs.join('\n')).toContain('unknown --kind');
    expect(await runMemoryCli(['memory', 'rollback', 'demo', '--db', dbPath])).toBe(2);
  });

  it('fails for an unregistered project', async () => {
    expect(await runMemoryCli(['memory', 'update', 'nope', '--db', dbPath])).toBe(1);
    expect(errs.join('\n')).toContain('no project "nope"');
  });

  it('rejects an unknown subcommand', async () => {
    expect(await runMemoryCli(['memory', 'bogus'])).toBe(2);
  });
});
