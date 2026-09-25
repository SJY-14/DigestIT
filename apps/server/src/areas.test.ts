import { describe, expect, it } from 'vitest';
import { areaOf, parseWorkspacePrefixes } from './areas.js';

describe('parseWorkspacePrefixes', () => {
  it('reads single-level package globs', () => {
    expect(parseWorkspacePrefixes('packages:\n  - packages/*\n  - apps/*\nallowBuilds:\n  esbuild: false\n'))
      .toEqual(['packages', 'apps']);
  });

  it('ignores non-glob or deep patterns', () => {
    expect(parseWorkspacePrefixes("packages:\n  - tools/one\n  - vendor/**\n  - 'apps/*'\n")).toEqual(['apps']);
  });

  it('returns [] when there is no packages key', () => {
    expect(parseWorkspacePrefixes('allowBuilds:\n  esbuild: false\n')).toEqual([]);
  });
});

describe('areaOf', () => {
  const prefixes = ['apps', 'packages'];

  it('buckets a workspace package to <prefix>/<name>', () => {
    expect(areaOf('apps/web/src/App.tsx', prefixes)).toBe('apps/web');
    expect(areaOf('packages/core/src/db.ts', prefixes)).toBe('packages/core');
  });

  it('falls back to the workspace prefix itself for a file directly under it', () => {
    expect(areaOf('apps/README.md', prefixes)).toBe('apps');
  });

  it('buckets a non-workspace top-level dir as itself, without expanding', () => {
    expect(areaOf('docs/ui/panel.png', prefixes)).toBe('docs');
  });

  it('buckets a root-level file as "."', () => {
    expect(areaOf('README.md', prefixes)).toBe('.');
  });

  it('counts a rename under the new path (caller passes path, never oldPath)', () => {
    // file_change.path is always the current path; areaOf has no old_path parameter by design.
    expect(areaOf('packages/explain/src/moved.ts', prefixes)).toBe('packages/explain');
  });

  it('root expands one level under the given root and excludes paths outside it', () => {
    expect(areaOf('apps/web/src/App.tsx', prefixes, 'apps/web')).toBe('apps/web/src');
    expect(areaOf('apps/web/package.json', prefixes, 'apps/web')).toBe('apps/web');
    expect(areaOf('apps/server/src/app.ts', prefixes, 'apps/web')).toBeNull();
  });
});
