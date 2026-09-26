import { describe, expect, it } from 'vitest';
import { buildProjectGraph, type GraphInput } from './graph.js';

const mod = (path: string, additions = 1, deletions = 0) => ({ path, status: 'M' as const, additions, deletions });
const ids = (input: GraphInput) => buildProjectGraph(input).nodes.map((n) => n.id);

const paths = [
  'README.md',
  'package.json',
  'docs/a.md',
  'docs/b.md',
  'src/index.ts',
  'src/util/x.ts',
  'src/util/y.ts',
  'src/api/server.ts',
  'src/api/routes.ts',
];

describe('buildProjectGraph', () => {
  it('opens folders around changes and folds unchanged subtrees into one node', () => {
    const g = buildProjectGraph({ paths, files: [mod('src/api/server.ts', 10, 2)] });
    expect(g.nodes.map((n) => n.id)).toEqual([
      'd:', 'd:docs', 'd:src', 'd:src/api', 'f:src/api/routes.ts', 'f:src/api/server.ts', 'd:src/util',
      'f:src/index.ts', 'f:README.md', 'f:package.json',
    ]);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get('d:docs')).toMatchObject({ collapsed: true, changed: false, fileCount: 2 });
    expect(byId.get('d:src')).toMatchObject({ changed: true, changedFiles: 1, additions: 10, deletions: 2, fileCount: 5 });
    expect(byId.get('d:')).toMatchObject({ kind: 'root', parentId: null, fileCount: 9 });
    expect(byId.get('f:src/api/server.ts')).toMatchObject({ changed: true, status: 'M', depth: 3 });
    expect(g.edges).toContainEqual({ source: 'd:src/api', target: 'f:src/api/server.ts', kind: 'contains' });
    expect(g.edges).toHaveLength(g.nodes.length - 1);
    expect(g).toMatchObject({ totalFiles: 9, truncated: false });
  });

  it('adds deleted files, which are not in the new tree', () => {
    const g = buildProjectGraph({ paths, files: [{ path: 'old/gone.ts', status: 'D', additions: 0, deletions: 40 }] });
    expect(g.nodes.find((n) => n.id === 'f:old/gone.ts')).toMatchObject({ changed: true, status: 'D', deletions: 40 });
    expect(g.nodes.find((n) => n.id === 'd:old')).toMatchObject({ changed: true, collapsed: false });
    expect(g.totalFiles).toBe(10);
  });

  it('groups many unchanged files of an open folder', () => {
    const many = Array.from({ length: 20 }, (_, i) => `lib/f${String(i).padStart(2, '0')}.ts`);
    const g = buildProjectGraph({ paths: many, files: [mod('lib/f03.ts')], maxLooseFiles: 8 });
    expect(g.nodes.map((n) => n.id)).toEqual(['d:', 'd:lib', 'f:lib/f03.ts', 'g:lib']);
    expect(g.nodes[3]).toMatchObject({ kind: 'group', name: '19 files', fileCount: 19, changed: false });
  });

  it('lists every child of a folder the user expanded', () => {
    const many = Array.from({ length: 20 }, (_, i) => `lib/f${String(i).padStart(2, '0')}.ts`);
    expect(ids({ paths: [...many, 'lib/sub/z.ts'], files: [], expand: ['lib'] })).toHaveLength(2 + 20 + 1);
    expect(ids({ paths, files: [], expand: ['src/util'] })).toEqual([
      'd:', 'd:docs', 'd:src', 'd:src/api', 'd:src/util', 'f:src/util/x.ts', 'f:src/util/y.ts', 'f:src/index.ts',
      'f:README.md', 'f:package.json',
    ]);
  });

  it('maps L2 areas onto files and every folder above them', () => {
    const g = buildProjectGraph({
      paths,
      files: [mod('src/api/server.ts'), mod('docs/a.md')],
      areas: [{ id: 'api', paths: ['src/api/server.ts'] }, { id: 'docs', paths: ['docs/a.md'] }],
    });
    const at = (id: string) => g.nodes.find((n) => n.id === id)?.areaIds;
    expect(at('f:src/api/server.ts')).toEqual(['api']);
    expect(at('d:src')).toEqual(['api']);
    expect(at('d:')).toEqual(['api', 'docs']);
    expect(at('f:src/api/routes.ts')).toEqual([]);
  });

  it('stays under the node cap by grouping, then folding deep changed folders', () => {
    const big: string[] = [];
    for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 10; c++) big.push(`m${a}/p${b}/f${c}.ts`);
    const files = big.filter((_, i) => i % 7 === 0).map((p) => mod(p));
    const g = buildProjectGraph({ paths: big, files, maxNodes: 60 });
    expect(g.nodes.length).toBeLessThanOrEqual(60);
    expect(g.truncated).toBe(true);
    const shown = g.nodes.filter((n) => n.changed).reduce((s, n) => s + (n.collapsed || n.kind === 'file' ? n.changedFiles : 0), 0);
    expect(shown).toBe(files.length);
    expect(g.nodes.find((n) => n.id === 'd:')!.changedFiles).toBe(files.length);
  });

  it('is deterministic regardless of input order', () => {
    const a = buildProjectGraph({ paths, files: [mod('src/index.ts'), mod('docs/b.md')] });
    const b = buildProjectGraph({ paths: [...paths].reverse(), files: [mod('docs/b.md'), mod('src/index.ts')] });
    expect(b).toEqual(a);
  });
});
