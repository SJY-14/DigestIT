import { buildProjectGraph } from '@digestit/core';
import { describe, expect, it } from 'vitest';
import { bounds, fitPadding, fitView, layoutGraph, MAX_FIT_SCALE, nodeRadius, rotatePositions, seedPositions, shouldRotate } from './graphLayout.js';

const small = buildProjectGraph({
  paths: ['src/a.ts', 'src/b.ts', 'src/sub/c.ts', 'docs/readme.md'],
  files: [
    { path: 'src/a.ts', status: 'M', additions: 10, deletions: 2 },
    { path: 'src/sub/c.ts', status: 'A', additions: 40, deletions: 0 },
  ],
});

/** A wide-and-deep tree with ~400 changed+unchanged files, expanded everywhere so the graph
 * itself (not the folding heuristics) is what gets layout-stress-tested. */
function bigGraph() {
  const paths: string[] = [];
  const files: { path: string; status: 'M'; additions: number; deletions: number }[] = [];
  for (let d = 0; d < 20; d++) {
    for (let f = 0; f < 20; f++) {
      const path = `pkg${d}/mod${f}.ts`;
      paths.push(path);
      if ((d + f) % 3 === 0) files.push({ path, status: 'M', additions: f + 1, deletions: d });
    }
  }
  return buildProjectGraph({ paths, files, expand: paths.map((p) => p.split('/')[0]!), maxNodes: 1000 });
}

describe('nodeRadius', () => {
  it('is a fixed base radius for unchanged nodes regardless of stats', () => {
    expect(nodeRadius({ changed: false, additions: 999, deletions: 999 })).toBe(5);
  });
  it('grows with sqrt(lines changed) for changed nodes, clamped to MAX_R', () => {
    expect(nodeRadius({ changed: true, additions: 0, deletions: 0 })).toBe(5);
    expect(nodeRadius({ changed: true, additions: 16, deletions: 0 })).toBe(9);
    expect(nodeRadius({ changed: true, additions: 10000, deletions: 0 })).toBe(22);
  });
});

describe('seedPositions', () => {
  it('places the root at the origin and gives every node a finite position', () => {
    const seed = seedPositions(small.nodes);
    const root = small.nodes.find((n) => n.parentId === null)!;
    expect(seed.get(root.id)).toEqual({ x: 0, y: 0 });
    for (const n of small.nodes) {
      const p = seed.get(n.id)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('layoutGraph', () => {
  it('is deterministic for the same graph', () => {
    const a = layoutGraph(small.nodes, small.edges);
    const b = layoutGraph(small.nodes, small.edges);
    for (const n of small.nodes) expect(a.get(n.id)).toEqual(b.get(n.id));
  });

  it('places every node with finite, non-NaN coordinates', () => {
    const pos = layoutGraph(small.nodes, small.edges);
    expect(pos.size).toBe(small.nodes.length);
    for (const n of small.nodes) {
      const p = pos.get(n.id)!;
      expect(Number.isNaN(p.x)).toBe(false);
      expect(Number.isNaN(p.y)).toBe(false);
    }
  });

  it('keeps existing nodes close to their prior position when a folder is expanded (new nodes added)', () => {
    const before = layoutGraph(small.nodes, small.edges);
    const expanded = buildProjectGraph({
      paths: ['src/a.ts', 'src/b.ts', 'src/sub/c.ts', 'src/sub/d.ts', 'src/sub/e.ts', 'docs/readme.md'],
      files: [
        { path: 'src/a.ts', status: 'M', additions: 10, deletions: 2 },
        { path: 'src/sub/c.ts', status: 'A', additions: 40, deletions: 0 },
      ],
      expand: ['src/sub'],
    });
    const after = layoutGraph(expanded.nodes, expanded.edges, before);
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    // A from-scratch layout (no prior) is free to reseed shared nodes anywhere in their radial
    // sector; passing `before` as `prior` is what keeps the picture recognizably in place across
    // an expand. Check that relatively, not against a hardcoded pixel budget.
    const fresh = layoutGraph(expanded.nodes, expanded.edges);
    const totalDist = (layout: Map<string, { x: number; y: number }>) =>
      small.nodes.reduce((sum, n) => sum + dist(layout.get(n.id)!, before.get(n.id)!), 0);
    expect(totalDist(after)).toBeLessThan(totalDist(fresh));
  });

  it('lays out 400+ nodes deterministically in well under 200ms', () => {
    const big = bigGraph();
    expect(big.nodes.length).toBeGreaterThanOrEqual(400);
    layoutGraph(big.nodes, big.edges); // warm up the JIT before timing
    const start = performance.now();
    const a = layoutGraph(big.nodes, big.edges);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(a.size).toBe(big.nodes.length);
    for (const n of big.nodes) {
      const p = a.get(n.id)!;
      expect(Number.isNaN(p.x) || Number.isNaN(p.y)).toBe(false);
    }
    const b = layoutGraph(big.nodes, big.edges);
    for (const n of big.nodes) expect(a.get(n.id)).toEqual(b.get(n.id));
  });
});

describe('bounds/fitView', () => {
  it('returns null bounds for an empty id list and a default centered view', () => {
    expect(bounds(small.nodes, new Map(), [])).toBeNull();
    expect(fitView(null, 640)).toEqual({ x: 320, y: 320, scale: 1 });
  });

  it('centers the fitted view on the bounding box of the given ids', () => {
    const pos = layoutGraph(small.nodes, small.edges);
    const changedIds = small.nodes.filter((n) => n.changed).map((n) => n.id);
    const b = bounds(small.nodes, pos, changedIds);
    expect(b).not.toBeNull();
    const view = fitView(b, 640);
    expect(Number.isFinite(view.x)).toBe(true);
    expect(Number.isFinite(view.y)).toBe(true);
    expect(view.scale).toBeGreaterThan(0);
  });

  it('caps the fitted scale for a tiny bounding box, so a small project does not zoom in far enough to clip labels', () => {
    const tiny = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const view = fitView(tiny, 640);
    expect(view.scale).toBe(MAX_FIT_SCALE);
  });

  it('does not cap the scale for a bounding box that genuinely needs to zoom out', () => {
    const huge = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };
    const view = fitView(huge, 640);
    expect(view.scale).toBeLessThan(MAX_FIT_SCALE);
  });

  it('auto-fit: every changed node (with its radius) lands inside a wide or tall pane, with the padding kept', () => {
    const pos = layoutGraph(small.nodes, small.edges);
    const changed = small.nodes.filter((n) => n.changed);
    expect(changed.length).toBeGreaterThan(1);
    for (const [w, h] of [[900, 420], [360, 820], [640, 640]] as const) {
      const view = fitView(bounds(small.nodes, pos, changed.map((n) => n.id)), w, h);
      const pad = fitPadding(w, h);
      for (const n of changed) {
        const p = pos.get(n.id)!;
        const r = nodeRadius(n) * view.scale;
        const x = view.x + p.x * view.scale;
        const y = view.y + p.y * view.scale;
        expect(x - r).toBeGreaterThanOrEqual(pad.x - 0.5);
        expect(x + r).toBeLessThanOrEqual(w - pad.x + 0.5);
        expect(y - r).toBeGreaterThanOrEqual(pad.y - 0.5);
        expect(y + r).toBeLessThanOrEqual(h - pad.y + 0.5);
      }
    }
  });

  it('auto-fit fills the pane: the changed bounds span the full width or height (less padding) unless capped', () => {
    const b = { minX: -600, minY: -100, maxX: 600, maxY: 100 };
    const view = fitView(b, 900, 420);
    const pad = fitPadding(900, 420);
    expect((b.maxX - b.minX) * view.scale).toBeCloseTo(900 - 2 * pad.x);
  });

  it('turns a tall layout sideways in a wide pane (and not a layout that already fits the shape)', () => {
    const tall = { minX: -50, minY: -300, maxX: 50, maxY: 300 };
    expect(shouldRotate(tall, 900, 420)).toBe(true);
    expect(shouldRotate(tall, 360, 820)).toBe(false);
    expect(shouldRotate({ minX: -100, minY: -100, maxX: 100, maxY: 100 }, 900, 420)).toBe(false);
    expect(shouldRotate(null, 900, 420)).toBe(false);
    const turned = rotatePositions(new Map([['a', { x: 1, y: 2 }]]));
    expect(turned.get('a')).toEqual({ x: 2, y: -1 });
  });
});
