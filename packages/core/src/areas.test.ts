import { describe, expect, it } from 'vitest';
import { groupDigestAreas } from './areas.js';

const f = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions });

describe('groupDigestAreas', () => {
  it('returns [] for no files', () => {
    expect(groupDigestAreas([])).toEqual([]);
  });

  it('buckets a workspace package to <prefix>/<name>', () => {
    const areas = groupDigestAreas([f('apps/web/src/App.tsx'), f('packages/core/src/db.ts')], { workspacePrefixes: ['apps', 'packages'] });
    const ids = areas.map((a) => a.id).sort();
    expect(ids).toEqual(['apps-web', 'packages-core']);
  });

  it('buckets a non-workspace file by its full directory', () => {
    const areas = groupDigestAreas([f('docs/ui/panel.md'), f('docs/ui/notes.md'), f('docs/readme.md')]);
    expect(areas).toHaveLength(2);
    const uiArea = areas.find((a) => a.label === 'docs/ui')!;
    expect(uiArea.paths).toEqual(['docs/ui/notes.md', 'docs/ui/panel.md']);
    const docsArea = areas.find((a) => a.label === 'docs')!;
    expect(docsArea.paths).toEqual(['docs/readme.md']);
  });

  it('puts top-level files in one "project root" area', () => {
    const areas = groupDigestAreas([f('README.md'), f('package.json')]);
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ id: 'project-root', label: 'project root' });
    expect(areas[0]!.paths).toEqual(['README.md', 'package.json'].sort());
  });

  describe('test file joins its subject', () => {
    it('x.test.ts -> x.ts, same directory', () => {
      const areas = groupDigestAreas([f('packages/core/src/db.ts'), f('packages/core/src/db.test.ts'), f('docs/other.md')]);
      const core = areas.find((a) => a.label === 'packages/core/src')!;
      expect(core.paths).toEqual(['packages/core/src/db.test.ts', 'packages/core/src/db.ts']);
    });

    it('test_x.py -> x.py', () => {
      const areas = groupDigestAreas([f('pkg/mod.py'), f('pkg/test_mod.py'), f('docs/other.md')]);
      const pkg = areas.find((a) => a.label === 'pkg')!;
      expect(pkg.paths.sort()).toEqual(['pkg/mod.py', 'pkg/test_mod.py']);
    });

    it('__tests__/x.ts -> x.ts', () => {
      const areas = groupDigestAreas([f('src/utils/x.ts'), f('src/utils/__tests__/x.ts'), f('docs/other.md')]);
      const utils = areas.find((a) => a.label === 'src/utils')!;
      expect(utils.paths.sort()).toEqual(['src/utils/__tests__/x.ts', 'src/utils/x.ts']);
    });

    it('does not redirect when the subject is not in the digest', () => {
      const areas = groupDigestAreas([f('src/utils/x.test.ts'), f('docs/other.md')]);
      const utils = areas.find((a) => a.label === 'src/utils')!;
      expect(utils.paths).toEqual(['src/utils/x.test.ts']);
    });
  });

  it('merges the smallest groups into their parent directory until at most 8 remain', () => {
    const files = Array.from({ length: 12 }, (_, i) => f(`packages/pkg${i}/src/one.ts`));
    const areas = groupDigestAreas(files, { workspacePrefixes: [] });
    expect(areas.length).toBeLessThanOrEqual(8);
    expect(areas.flatMap((a) => a.paths).sort()).toEqual(files.map((x) => x.path).sort());
  });

  it('merges repeatedly up to the workspace package root when still over the cap', () => {
    // 10 distinct sub-directories inside one package: merging must climb past the immediate
    // parent (still >8 groups) all the way to the package root to land at 1 area.
    const files = Array.from({ length: 10 }, (_, i) => f(`packages/big/src/mod${i}/file.ts`));
    const areas = groupDigestAreas(files, { workspacePrefixes: ['packages'], maxAreas: 8 });
    expect(areas.length).toBeLessThanOrEqual(8);
  });

  it('every file (including filtered ones, by construction) ends up in exactly one area', () => {
    const files = [f('a/one.ts'), f('a/two.ts'), f('b/three.ts'), f('README.md')];
    const areas = groupDigestAreas(files);
    const seen = areas.flatMap((a) => a.paths);
    expect(seen.sort()).toEqual(files.map((x) => x.path).sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('is deterministic: same input, same ids/order', () => {
    const files = [f('apps/web/a.ts'), f('apps/api/b.ts'), f('docs/c.md'), f('README.md')];
    const a = groupDigestAreas(files, { workspacePrefixes: ['apps'] });
    const b = groupDigestAreas([...files].reverse(), { workspacePrefixes: ['apps'] });
    expect(a).toEqual(b);
  });

  it('dedupes colliding ids', () => {
    // "docs/a" and "docs-a" both slugify to "docs-a".
    const files = [f('docs/a/one.md'), f('docs-a/two.md'), f('other/three.md')];
    const areas = groupDigestAreas(files, { maxAreas: 8 });
    const ids = areas.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('docs-a');
    expect(ids).toContain('docs-a-2');
  });

  it('stable kebab-case ids, at most 40 chars is not enforced here but ids are always [a-z0-9-]', () => {
    const areas = groupDigestAreas([f('Some Weird_Dir/File.ts')]);
    expect(areas[0]!.id).toMatch(/^[a-z0-9-]+$/);
  });

  it('sums additions/deletions per area', () => {
    const areas = groupDigestAreas([f('a/one.ts', 3, 1), f('a/two.ts', 2, 5)]);
    expect(areas[0]).toMatchObject({ additions: 5, deletions: 6 });
  });
});
