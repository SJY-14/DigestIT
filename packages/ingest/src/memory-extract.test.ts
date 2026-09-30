import { describe, expect, it } from 'vitest';
import type { AreaMemory } from '@digestit/core';
import { extractProjectMemory, groupMemoryAreas, type TreeReader } from './memory-extract.js';

function reader(files: Record<string, string>): TreeReader {
  return { paths: Object.keys(files), read: (p) => files[p] ?? null };
}

const areaOf = (result: ReturnType<typeof extractProjectMemory>, path: string): AreaMemory =>
  result.areas.find((a) => a.path === path)!.content;

describe('groupMemoryAreas', () => {
  it('buckets files by top-level folder, root files under the root group', () => {
    const groups = groupMemoryAreas(['src/a.ts', 'src/b.ts', 'lib/c.ts', 'README.md']);
    expect(groups.map((g) => g.path).sort()).toEqual(['', 'lib', 'src']);
    expect(groups.find((g) => g.path === '')!.paths).toEqual(['README.md']);
  });

  it('bucketing at the package root for a recognised workspace prefix, two levels deep', () => {
    const groups = groupMemoryAreas(['packages/core/src/a.ts', 'packages/core/src/b.ts', 'packages/explain/src/c.ts'], ['packages']);
    expect(groups.map((g) => g.path).sort()).toEqual(['packages/core', 'packages/explain']);
  });

  it('merges the smallest group into its parent directory until at most maxAreas remain', () => {
    const paths = ['a/x.ts', 'a/y.ts', 'a/z.ts', 'a/sub/tiny.ts', 'b/w.ts'];
    const groups = groupMemoryAreas(paths, [], 2);
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.path === 'a')!;
    expect(a.paths).toContain('a/sub/tiny.ts'); // the smaller a/sub group merged up into a
  });
});

describe('extractProjectMemory: TS/JS', () => {
  it('extracts exported functions/classes/consts/types and resolves a relative import to the owning area', () => {
    const result = extractProjectMemory(reader({
      'src/index.ts': `export function add(a: number, b: number) {\n  return a + b;\n}\nexport class Widget {}\nexport const VERSION = '1';\nexport interface Shape {}\n`,
      'lib/consumer.ts': `import { add } from '../src/index.js';\nexport function use() { return add(1, 2); }\n`,
    }));
    const src = areaOf(result, 'src');
    expect(src.exports.map((e) => e.name).sort()).toEqual(['Shape', 'VERSION', 'Widget', 'add']);
    expect(src.exports.find((e) => e.name === 'add')!.kind).toBe('function');
    expect(src.usedBy).toEqual(['lib']);
    const lib = areaOf(result, 'lib');
    expect(lib.uses).toEqual(['src']);
  });

  it('ranks exports most-imported first', () => {
    const result = extractProjectMemory(reader({
      'src/index.ts': `export function popular() {}\nexport function rare() {}\n`,
      'a/one.ts': `import { popular } from '../src/index.js';\n`,
      'b/two.ts': `import { popular } from '../src/index.js';\n`,
      'c/three.ts': `import { rare } from '../src/index.js';\n`,
    }));
    expect(areaOf(result, 'src').exports.map((e) => e.name)).toEqual(['popular', 'rare']);
  });

  it('resolves a workspace-package import via package.json name, not just relative paths', () => {
    const result = extractProjectMemory(reader({
      'packages/core/package.json': JSON.stringify({ name: '@acme/core' }),
      'packages/core/src/index.ts': `export function helper() {}\n`,
      'packages/webapp/src/main.ts': `import { helper } from '@acme/core';\n`,
    }), { workspacePrefixes: ['packages'] });
    expect(areaOf(result, 'packages/core').usedBy).toEqual(['packages/webapp']);
  });

  it('reads a folder README\'s first paragraph as the area doc, redacted and capped', () => {
    const result = extractProjectMemory(reader({
      'src/README.md': `# Src\n\nThis module talks to the api with token sk-ant-abcdefghijklmnopqrstuvwxyz and does things.\n\nMore detail below.`,
      'src/index.ts': `export function f() {}\n`,
    }));
    const doc = areaOf(result, 'src').doc!;
    expect(doc).toContain('This module talks to the api with token');
    expect(doc).not.toContain('sk-ant-');
    expect(doc).toContain('[REDACTED]');
  });

  it('redacts before capping, so a token straddling the 400-char limit never leaks a raw fragment', () => {
    const prefix = `${'x'.repeat(394)} `; // a space keeps the token's own \b word boundary intact
    const token = 'sk-ant-abcdefghijklmnopqrstuvwxyz'; // starts at index 395, spans past the 400-char cap
    const result = extractProjectMemory(reader({
      'src/README.md': `# Src\n\n${prefix}${token} end.\n`,
      'src/index.ts': `export function f() {}\n`,
    }));
    const doc = areaOf(result, 'src').doc!;
    expect(doc.length).toBeLessThanOrEqual(400);
    expect(doc).not.toMatch(/sk-an/); // no raw fragment of the secret survives the cap
  });

  it('falls back to the leading doc comment of the main file when there is no README', () => {
    const result = extractProjectMemory(reader({
      'src/index.ts': `/**\n * Talks to the widget service.\n */\nexport function f() {}\n`,
    }));
    expect(areaOf(result, 'src').doc).toBe('Talks to the widget service.');
  });

  it('attaches a doc comment directly above a declaration as the term\'s meaning', () => {
    const result = extractProjectMemory(reader({
      'src/index.ts': `// Adds two numbers together.\nexport function add(a: number, b: number) { return a + b; }\n`,
    }));
    const term = result.terms.find((t) => t.term === 'add')!;
    expect(term.meaning).toBe('Adds two numbers together.');
    expect(term.definedAt).toEqual({ file: 'src/index.ts', line: 2 });
  });

  it('the fingerprint changes when exports change and stays stable when they do not', () => {
    const v1 = extractProjectMemory(reader({ 'src/index.ts': `export function f() {}\n` }));
    const v1b = extractProjectMemory(reader({ 'src/index.ts': `export function f() {}\n` }));
    const v2 = extractProjectMemory(reader({ 'src/index.ts': `export function f() {}\nexport function g() {}\n` }));
    expect(areaOf(v1, 'src').fingerprint).toBe(areaOf(v1b, 'src').fingerprint);
    expect(areaOf(v1, 'src').fingerprint).not.toBe(areaOf(v2, 'src').fingerprint);
  });
});

describe('extractProjectMemory: Python', () => {
  it('extracts top-level def/class, ignores indented (nested) ones, and resolves a relative import', () => {
    const result = extractProjectMemory(reader({
      'pkg/__init__.py': ``,
      'pkg/core.py': `class Widget:\n    def method(self):\n        pass\n\ndef helper():\n    pass\n`,
      'pkg/consumer.py': `from .core import helper\n`,
    }));
    const core = areaOf(result, 'pkg').exports.map((e) => e.name).sort();
    expect(core).toEqual(['Widget', 'helper']); // 'method' is indented, not top-level
  });
});

describe('extractProjectMemory: Go', () => {
  it('extracts only exported (capitalised) top-level identifiers', () => {
    const result = extractProjectMemory(reader({
      'pkg/widget.go': `package pkg\n\nfunc Public() {}\n\nfunc private() {}\n\ntype Widget struct{}\n`,
    }));
    expect(areaOf(result, 'pkg').exports.map((e) => e.name).sort()).toEqual(['Public', 'Widget']);
  });
});

describe('extractProjectMemory: Rust', () => {
  it('extracts pub items only', () => {
    const result = extractProjectMemory(reader({
      'src/lib.rs': `pub fn add(a: i32, b: i32) -> i32 { a + b }\nfn helper() {}\npub struct Widget;\n`,
    }));
    expect(areaOf(result, 'src').exports.map((e) => e.name).sort()).toEqual(['Widget', 'add']);
  });
});

describe('extractProjectMemory: other languages', () => {
  it('gets no exported symbols but still counts toward the area\'s file count', () => {
    const result = extractProjectMemory(reader({ 'assets/logo.svg': `<svg></svg>` }));
    const area = areaOf(result, 'assets');
    expect(area.exports).toEqual([]);
    expect(area.fileCount).toBe(1);
  });
});

describe('extractProjectMemory: denylist trust boundary', () => {
  it('never reports a path it was not given (the shadow store, not this module, applies the denylist)', () => {
    const result = extractProjectMemory(reader({ 'src/index.ts': `export function f() {}\n` }));
    const allPaths = result.areas.flatMap((a) => a.content.exports.map((e) => e.file));
    expect(allPaths.every((p) => p === 'src/index.ts')).toBe(true);
    expect(allPaths.join(',')).not.toMatch(/\.env|node_modules|\.pem/);
  });
});
