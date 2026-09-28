import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addIgnorePatterns, compileIgnorePatterns, hasOwnGitignore, ignoreFilePath, matchesIgnorePatterns,
  readIgnorePatterns, removeIgnorePatterns, suggestIgnorePatterns,
} from './ignore.js';

let root: string;
let proj: string;
let data: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'digest-ignore-'));
  proj = join(root, 'project');
  data = join(root, 'data');
  mkdirSync(proj, { recursive: true });
  mkdirSync(data, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('read/add/remove', () => {
  it('reads [] when nothing was ever set', () => {
    expect(readIgnorePatterns(data)).toEqual([]);
  });

  it('adds patterns, skipping blanks, comments and duplicates', async () => {
    const r1 = await addIgnorePatterns(data, ['out/', '', '# comment', '*.log']);
    expect(r1).toEqual(['out/', '*.log']);
    const r2 = await addIgnorePatterns(data, ['*.log', 'build/']);
    expect(r2).toEqual(['out/', '*.log', 'build/']);
    expect(readIgnorePatterns(data)).toEqual(['out/', '*.log', 'build/']);
  });

  it('removes by exact text', async () => {
    await addIgnorePatterns(data, ['out/', '*.log', 'build/']);
    const r = await removeIgnorePatterns(data, ['*.log']);
    expect(r).toEqual(['out/', 'build/']);
    expect(readIgnorePatterns(data)).toEqual(['out/', 'build/']);
  });

  it('never touches the project directory', async () => {
    await addIgnorePatterns(data, ['out/']);
    expect(ignoreFilePath(data).startsWith(data)).toBe(true);
    expect(ignoreFilePath(data).startsWith(proj)).toBe(false);
  });
});

describe('matchesIgnorePatterns', () => {
  it('matches an unanchored directory pattern anywhere in the tree', () => {
    const c = compileIgnorePatterns(['out/']);
    expect(matchesIgnorePatterns(c, 'out/')).toBe(true);
    expect(matchesIgnorePatterns(c, 'nested/out/')).toBe(true);
    expect(matchesIgnorePatterns(c, 'nested/out/file.txt')).toBe(true);
    expect(matchesIgnorePatterns(c, 'output/file.txt')).toBe(false);
  });

  it('matches a bare-name glob against the basename anywhere', () => {
    const c = compileIgnorePatterns(['*.log']);
    expect(matchesIgnorePatterns(c, 'a.log')).toBe(true);
    expect(matchesIgnorePatterns(c, 'nested/deep/a.log')).toBe(true);
    expect(matchesIgnorePatterns(c, 'a.log.txt')).toBe(false);
  });

  it('supports gitignore character classes for scheduler job logs', () => {
    const c = compileIgnorePatterns(['*.o[0-9]*', '*.e[0-9]*']);
    expect(matchesIgnorePatterns(c, 'run.o12345')).toBe(true);
    expect(matchesIgnorePatterns(c, 'run.e987')).toBe(true);
    expect(matchesIgnorePatterns(c, 'run.output')).toBe(false);
  });

  it('matches an anchored (slash-containing) pattern only at that path', () => {
    const c = compileIgnorePatterns(['build/output/']);
    expect(matchesIgnorePatterns(c, 'build/output/')).toBe(true);
    expect(matchesIgnorePatterns(c, 'build/output/x.bin')).toBe(true);
    expect(matchesIgnorePatterns(c, 'other/build/output/')).toBe(false);
  });

  it('returns false for an empty pattern list', () => {
    expect(matchesIgnorePatterns(compileIgnorePatterns([]), 'anything.txt')).toBe(false);
  });
});

describe('suggestIgnorePatterns', () => {
  const write = (rel: string, content = '') => {
    mkdirSync(join(proj, rel, '..'), { recursive: true });
    writeFileSync(join(proj, rel), content);
  };

  it('suggests a top-level directory with thousands of entries', async () => {
    for (let i = 0; i < 1200; i++) write(`out/job-${i}.txt`);
    write('keep.txt', 'k');
    const s = await suggestIgnorePatterns(proj);
    expect(s).toContainEqual(expect.objectContaining({ pattern: 'out/' }));
  });

  it('does not suggest a directory with only a handful of files', async () => {
    write('src/index.ts', 'x');
    write('src/util.ts', 'y');
    const s = await suggestIgnorePatterns(proj);
    expect(s.find((x) => x.pattern === 'src/')).toBeUndefined();
  });

  it('suggests scheduler job logs, __pycache__ and *.log from top-level files', async () => {
    write('run.o12345', 'stdout');
    write('run.e12345', 'stderr');
    write('debug.log', 'log');
    mkdirSync(join(proj, '__pycache__'), { recursive: true });
    write('__pycache__/mod.pyc', 'bytecode');
    const s = await suggestIgnorePatterns(proj);
    const patterns = s.map((x) => x.pattern).sort();
    expect(patterns).toEqual(['*.e[0-9]*', '*.log', '*.o[0-9]*', '__pycache__/']);
  });

  it('suggests a directory that is mostly large files even with few entries', async () => {
    const dir = join(proj, 'artifacts');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      const fd = openSync(join(dir, `blob-${i}.bin`), 'w');
      ftruncateSync(fd, 5 * 1024 * 1024); // sparse, cheap
      closeSync(fd);
    }
    const s = await suggestIgnorePatterns(proj);
    expect(s).toContainEqual(expect.objectContaining({ pattern: 'artifacts/', reason: 'mostly large files' }));
  });

  it('returns [] for a folder that does not exist', async () => {
    expect(await suggestIgnorePatterns(join(proj, 'nope'))).toEqual([]);
  });
});

describe('hasOwnGitignore', () => {
  it('is true only when the project root has its own .gitignore', () => {
    expect(hasOwnGitignore(proj)).toBe(false);
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\n');
    expect(hasOwnGitignore(proj)).toBe(true);
  });
});
