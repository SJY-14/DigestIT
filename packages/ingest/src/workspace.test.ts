import { describe, expect, it } from 'vitest';
import { parseWorkspacePrefixes } from './workspace.js';

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
