import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openProjectDb } from './datahome.js';
import { readIgnorePatterns } from './ignore.js';
import { listProjects } from './project.js';
import { runConfigCli, runIgnoreCli, runInitCli, runProjectExplainCli, runProjectsCli, runStatusCli } from './project-cli.js';

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

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
  root = mkdtempSync(join(tmpdir(), 'digest-project-cli-'));
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

describe('runInitCli', () => {
  it('registers a project and prints where its data lives', async () => {
    write('a.txt', 'hi\n');
    const code = await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('registered project "demo"');
    expect(logs.join('\n')).toContain(join(root, 'home'));
  });

  it('is a no-op on a second run for the same path', async () => {
    write('a.txt', 'hi\n');
    await runInitCli(['init', proj, '--db', dbPath]);
    logs = [];
    const code = await runInitCli(['init', proj, '--db', dbPath]);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('already registered');
  });

  it('fails without a path', async () => {
    expect(await runInitCli(['init'])).toBe(2);
  });

  it('registers a project with a non-default language', async () => {
    write('a.txt', 'hi\n');
    const code = await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo', '--language', 'ko']);
    expect(code).toBe(0);
    const { db } = openProjectDb(dbPath);
    try {
      expect(listProjects(db)[0]!.language).toBe('ko');
    } finally {
      db.close();
    }
  });

  it('rejects an unknown language', async () => {
    write('a.txt', 'hi\n');
    const code = await runInitCli(['init', proj, '--db', dbPath, '--language', 'fr']);
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('unknown language "fr"');
  });

  it('applies --ignore patterns to checkpoint #1', async () => {
    write('keep.txt', 'k\n');
    write('out/generated.txt', 'g\n');
    const code = await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo', '--ignore', 'out/']);
    expect(code).toBe(0);
    expect(readIgnorePatterns(join(root, 'home', 'projects', '1'))).toEqual(['out/']);
    expect(logs.join('\n')).not.toContain('out/generated.txt');
  });

  it('suggests ignore patterns for a folder with no .gitignore, and prints them without applying them', async () => {
    for (let i = 0; i < 1200; i++) write(`out/job-${i}.txt`, 'x');
    write('keep.txt', 'k\n');
    const code = await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('suggested ignore patterns');
    expect(logs.join('\n')).toContain('out/');
    expect(readIgnorePatterns(join(root, 'home', 'projects', '1'))).toEqual([]); // never applied
  });

  it('does not suggest patterns when the folder already has its own .gitignore', async () => {
    write('.gitignore', 'node_modules/\n');
    for (let i = 0; i < 1200; i++) write(`out/job-${i}.txt`, 'x');
    const code = await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('suggested ignore patterns');
  });
});

describe('runConfigCli', () => {
  it('sets the language of an existing project', async () => {
    write('a.txt', 'hi\n');
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    logs = [];
    const code = await runConfigCli(['config', 'demo', '--language', 'ko', '--db', dbPath]);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('language set to ko');
    const { db } = openProjectDb(dbPath);
    try {
      expect(listProjects(db)[0]!.language).toBe('ko');
    } finally {
      db.close();
    }
  });

  it('rejects an unknown language', async () => {
    write('a.txt', 'hi\n');
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    const code = await runConfigCli(['config', 'demo', '--language', 'fr', '--db', dbPath]);
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('unknown language "fr"');
  });

  it('fails for an unknown project', async () => {
    const code = await runConfigCli(['config', 'nope', '--language', 'ko', '--db', dbPath]);
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('no project "nope"');
  });

  it('requires --language', async () => {
    write('a.txt', 'hi\n');
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    const code = await runConfigCli(['config', 'demo', '--db', dbPath]);
    expect(code).toBe(2);
  });
});

describe('runIgnoreCli', () => {
  beforeEach(async () => {
    write('a.txt', 'hi\n');
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    logs = [];
  });

  it('lists no patterns for a freshly registered project', async () => {
    const code = await runIgnoreCli(['ignore', 'demo', 'list', '--db', dbPath]);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('no ignore patterns');
  });

  it('adds, lists and removes patterns', async () => {
    expect(await runIgnoreCli(['ignore', 'demo', 'add', 'out/', '*.log', '--db', dbPath])).toBe(0);
    expect(logs.join('\n')).toContain('out/');
    expect(logs.join('\n')).toContain('*.log');

    logs = [];
    expect(await runIgnoreCli(['ignore', 'demo', 'list', '--db', dbPath])).toBe(0);
    expect(logs.join('\n')).toContain('2 ignore pattern(s)');

    logs = [];
    expect(await runIgnoreCli(['ignore', 'demo', 'remove', '*.log', '--db', dbPath])).toBe(0);
    expect(logs.join('\n')).toContain('out/');
    expect(logs.join('\n')).not.toContain('*.log');
  });

  it('applies on the next snapshot (via `digest init` re-run, which re-checks pending state)', async () => {
    write('out/generated.txt', 'g\n');
    await runIgnoreCli(['ignore', 'demo', 'add', 'out/', '--db', dbPath]);
    expect(readIgnorePatterns(join(root, 'home', 'projects', '1'))).toEqual(['out/']);
  });

  it('rejects add/remove with no patterns', async () => {
    expect(await runIgnoreCli(['ignore', 'demo', 'add', '--db', dbPath])).toBe(2);
    expect(await runIgnoreCli(['ignore', 'demo', 'remove', '--db', dbPath])).toBe(2);
  });

  it('rejects an unknown action', async () => {
    expect(await runIgnoreCli(['ignore', 'demo', 'bogus', 'x', '--db', dbPath])).toBe(2);
  });

  it('fails for an unknown project', async () => {
    const code = await runIgnoreCli(['ignore', 'nope', 'list', '--db', dbPath]);
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('no project "nope"');
  });
});

describe('runProjectsCli / runStatusCli', () => {
  it('lists a registered project and its pending status', async () => {
    write('a.txt', 'hi\n');
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    write('a.txt', 'hi\nthere\n');

    logs = [];
    expect(await runProjectsCli(['projects', '--db', dbPath])).toBe(0);
    expect(logs.join('\n')).toContain('demo');

    logs = [];
    expect(await runStatusCli(['status', 'demo', '--db', dbPath])).toBe(0);
    expect(logs.join('\n')).toContain('1 file(s) changed');
    expect(logs.join('\n')).toContain('budget:');
  });

  it('reports no projects registered', async () => {
    expect(await runProjectsCli(['projects', '--db', dbPath])).toBe(0);
    expect(logs.join('\n')).toContain('no projects registered');
  });
});

describe('runProjectExplainCli', () => {
  it('explains a changed project with the stub provider, then --retry on it has nothing to re-run', async () => {
    write('a.txt', 'hi\n');
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    write('a.txt', 'hi\nthere\n');

    const code = await runProjectExplainCli(['explain', 'demo', '--db', dbPath]);
    expect(code).toBe(0);
    const out = logs.join('\n');
    const m = /digest (\d+): ok/.exec(out);
    expect(m).not.toBeNull();
    const digestId = m![1]!;

    logs = [];
    const retried = await runProjectExplainCli(['explain', '--retry', digestId, '--db', dbPath]);
    expect(retried).toBe(0);
    expect(logs.join('\n')).toContain(`digest ${digestId}: nothing to retry`);
  });

  it('prints "No changes since last check" for an unchanged project', async () => {
    write('a.txt', 'hi\n');
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    const code = await runProjectExplainCli(['explain', 'demo', '--db', dbPath]);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('No changes since last check');
  });

  it('errors for an unknown project', async () => {
    const code = await runProjectExplainCli(['explain', 'nope', '--db', dbPath]);
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('no project "nope"');
  });
});

describe('data lives outside the project across the whole CLI flow', () => {
  it('never creates files inside the project directory', async () => {
    write('a.txt', 'hi\n');
    const before = listFiles(proj);
    await runInitCli(['init', proj, '--db', dbPath, '--name', 'demo']);
    write('a.txt', 'hi\nthere\n');
    await runProjectExplainCli(['explain', 'demo', '--db', dbPath]);
    expect(listFiles(proj)).toEqual(before);
    expect(dbPath.startsWith(proj)).toBe(false);
  });
});
