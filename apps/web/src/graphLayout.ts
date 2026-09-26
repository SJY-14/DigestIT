// Pure layout math for the project graph (DIG-42, docs/direction-v2.md §5). No DOM, no React:
// seeded radially from the tree, then relaxed with a fixed d3-force tick count (no timer, no
// animation loop) so the same graph always produces the same picture. Positions are kept by
// node id across re-layouts (see layoutGraph's `prior` param) so expanding a folder does not
// reshuffle nodes the user has already found.
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type SimulationLinkDatum, type SimulationNodeDatum,
} from 'd3-force';
import type { GraphEdge, GraphNode } from '@digestit/core';

export const BASE_R = 5;
export const MAX_R = 22;
const RADIUS_STEP = 90;
// Tuned to relax a ~400-node graph in well under the 200ms test budget: the radial seed already
// puts nodes close to their final position, so fewer ticks and a looser Barnes-Hut theta (less
// exact, faster) are enough to settle collisions without materially changing the picture.
const TICKS = 70;
const CHARGE_THETA = 1.15;
const CHARGE_DISTANCE_MAX = 180;

export interface Point {
  x: number;
  y: number;
}

/** Changed-node radius scales with sqrt(lines changed), clamped; unchanged nodes get a fixed size. */
export function nodeRadius(n: Pick<GraphNode, 'changed' | 'additions' | 'deletions'>): number {
  if (!n.changed) return BASE_R;
  return Math.min(MAX_R, BASE_R + Math.sqrt(n.additions + n.deletions));
}

/** Initial radial position: root at the center, children fanned into their parent's angular
 * sector (angle span proportional to subtree size via `fileCount`). */
export function seedPositions(nodes: GraphNode[]): Map<string, Point> {
  const seed = new Map<string, Point>();
  const root = nodes.find((n) => n.parentId === null);
  if (!root) return seed;
  seed.set(root.id, { x: 0, y: 0 });
  const byParent = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const list = byParent.get(n.parentId);
    if (list) list.push(n);
    else byParent.set(n.parentId, [n]);
  }
  const weight = (n: GraphNode) => Math.max(1, n.fileCount);
  const place = (id: string, start: number, end: number) => {
    const children = byParent.get(id);
    if (!children || children.length === 0) return;
    const total = children.reduce((s, c) => s + weight(c), 0);
    const span = end - start;
    let a = start;
    for (const c of children) {
      const childSpan = (span * weight(c)) / total;
      const mid = a + childSpan / 2;
      const r = c.depth * RADIUS_STEP;
      seed.set(c.id, { x: r * Math.cos(mid), y: r * Math.sin(mid) });
      place(c.id, a, a + childSpan);
      a += childSpan;
    }
  };
  place(root.id, 0, Math.PI * 2);
  return seed;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

/**
 * Deterministic layout: seed radially, then relax with d3-force for a fixed tick count.
 * `prior` positions (from the last layout, keyed by node id) seed nodes that already had a
 * place, so expanding a folder keeps the rest of the graph stable.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], prior?: ReadonlyMap<string, Point>): Map<string, Point> {
  const seed = seedPositions(nodes);
  const startOf = (id: string): Point => prior?.get(id) ?? seed.get(id) ?? { x: 0, y: 0 };
  const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id, ...startOf(n.id) }));
  const simLinks: SimulationLinkDatum<SimNode>[] = edges.map((e) => ({ source: e.source, target: e.target }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Collide radius follows the drawn radius (plus room for a label) so changed siblings with
  // labels don't render fully on top of one another.
  const collideRadius = (id: string) => {
    const n = byId.get(id);
    return n ? nodeRadius(n) + 8 : 8;
  };
  const sim = forceSimulation(simNodes)
    .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks).id((d) => d.id).distance(40).strength(0.6))
    .force('charge', forceManyBody().strength(-50).distanceMax(CHARGE_DISTANCE_MAX).theta(CHARGE_THETA))
    .force('collide', forceCollide<SimNode>((d) => collideRadius(d.id)))
    .force('x', forceX<SimNode>((d) => seed.get(d.id)?.x ?? 0).strength(0.06))
    .force('y', forceY<SimNode>((d) => seed.get(d.id)?.y ?? 0).strength(0.06))
    .stop();
  for (let i = 0; i < TICKS; i++) sim.tick();
  const out = new Map<string, Point>();
  for (const n of simNodes) out.set(n.id, { x: Number.isFinite(n.x) ? n.x! : 0, y: Number.isFinite(n.y) ? n.y! : 0 });
  return out;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box (in layout units, padded by each node's radius) of `ids`, or every node if omitted. */
export function bounds(nodes: GraphNode[], positions: ReadonlyMap<string, Point>, ids?: string[]): Bounds | null {
  const list = ids ?? nodes.map((n) => n.id);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const id of list) {
    const p = positions.get(id);
    const n = byId.get(id);
    if (!p || !n) continue;
    const r = nodeRadius(n);
    minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r);
    minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export interface View {
  x: number;
  y: number;
  scale: number;
}

/** View that centers and scales `b` to fit an area sized `viewport` (default a 640x640 viewBox). */
export function fitView(b: Bounds | null, viewport = 640): View {
  if (!b) return { x: viewport / 2, y: viewport / 2, scale: 1 };
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const scale = Math.min(4, Math.max(0.05, (viewport * 0.85) / Math.max(w, h)));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { x: viewport / 2 - cx * scale, y: viewport / 2 - cy * scale, scale };
}
