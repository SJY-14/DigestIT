// Project graph pane (DIG-42, docs/direction-v2.md §5): folders/files as nodes, containment as
// edges. Changed nodes are accent blue and sized by sqrt(lines changed); everything else is
// muted gray. The drawing is aria-hidden and must never hold information the change list (the
// keyboard/screen-reader path, DIG-40) doesn't also have; the controls are real <button>s.
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { GraphEdge, GraphNode, ProjectGraphDto } from '@digestit/core';
import { bounds, fitView, layoutGraph, nodeRadius, type Point, type View } from './graphLayout.js';

const VIEWPORT = 640;
const ZOOM_STEP = 1.3;
/** Pixels the pointer must move before a press on the canvas becomes a pan. */
const PAN_THRESHOLD = 4;
const MIN_SCALE = 0.05;
const MAX_SCALE = 6;
/** Below this scale, only the "always shown" labels (changed/root/top-level/hover) are drawn. */
const LABEL_ALL_SCALE = 1.5;

/** Draw style for one edge kind; edge kinds with no entry are not drawn, so a future `imports` or
 * `cochange` kind can be added to `packages/core/src/v2.ts` without touching this component. */
const EDGE_STYLE: Partial<Record<GraphEdge['kind'], { className: string }>> = {
  contains: { className: 'graph-edge-contains' },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function isFolder(n: GraphNode): boolean {
  return n.kind === 'root' || n.kind === 'dir';
}

/** Rounded squares for folded folders/groups (the node stands for several hidden children);
 * circles for everything shown as itself. */
function isBoxShaped(n: GraphNode): boolean {
  return n.kind === 'group' || (isFolder(n) && n.collapsed);
}

function alwaysLabeled(n: GraphNode, rootId: string | undefined): boolean {
  return n.changed || n.id === rootId || n.parentId === rootId;
}

/** "14 files changed in 5 folders." — the visually hidden summary; the change list carries the
 * keyboard/screen-reader detail, so this stays a one-line orientation cue. */
export function summarize(graph: ProjectGraphDto): string {
  const changedFiles = graph.nodes.filter((n) => n.kind === 'file' && n.changed).length;
  const changedFolders = graph.nodes.filter((n) => isFolder(n) && n.changed && n.id !== rootIdOf(graph)).length;
  if (changedFiles === 0) return 'No files changed.';
  return changedFolders > 0
    ? `${plural(changedFiles, 'file')} changed in ${plural(changedFolders, 'folder')}. Use the list to open each change.`
    : `${plural(changedFiles, 'file')} changed. Use the list to open each change.`;
}

function rootIdOf(graph: ProjectGraphDto): string | undefined {
  return graph.nodes.find((n) => n.parentId === null)?.id;
}

function tooltipText(n: GraphNode): string {
  const stats = n.changed ? `, +${n.additions} -${n.deletions}` : '';
  const count = n.kind === 'file' ? '' : `, ${plural(n.fileCount, 'file')}`;
  return `${n.path || n.name}${count}${stats}`;
}

export interface ProjectGraphProps {
  graph: ProjectGraphDto;
  /** Nodes matching the hovered/focused change-list row: rung with a 2px ring, rest dimmed. */
  highlightNodeIds?: ReadonlySet<string>;
  selectedNodeId?: string | null;
  /** A changed node was clicked: filter the change list to its areaIds. */
  onSelectNode: (node: GraphNode) => void;
  /** A folded folder or group was clicked: re-fetch the graph with this path expanded. */
  onExpand: (path: string) => void;
}

export function ProjectGraph({ graph, highlightNodeIds, selectedNodeId, onSelectNode, onExpand }: ProjectGraphProps) {
  const priorPositions = useRef<Map<string, Point> | undefined>(undefined);
  const positions = useMemo(() => {
    const next = layoutGraph(graph.nodes, graph.edges, priorPositions.current);
    priorPositions.current = next;
    return next;
  }, [graph]);
  const rootId = useMemo(() => rootIdOf(graph), [graph]);
  const changedIds = useMemo(() => graph.nodes.filter((n) => n.changed).map((n) => n.id), [graph]);
  const fittedToChanges = useMemo(
    () => fitView(bounds(graph.nodes, positions, changedIds.length > 0 ? changedIds : undefined), VIEWPORT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, positions],
  );
  const [view, setView] = useState<View>(fittedToChanges);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const priorGraph = useRef(graph);
  if (priorGraph.current !== graph) {
    priorGraph.current = graph;
    setView(fittedToChanges);
    setHoverId(null);
  }

  const drag = useRef<{ startX: number; startY: number; viewX: number; viewY: number; panning: boolean } | null>(null);

  const fitToChanges = () => setView(fittedToChanges);
  const fitAll = () => setView(fitView(bounds(graph.nodes, positions), VIEWPORT));
  const zoomBy = (factor: number) =>
    setView((v) => ({ ...v, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor)) }));

  // React attaches wheel listeners as passive, so preventDefault() there can't stop the page from
  // scrolling; zoom through a native non-passive listener instead.
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setView((v) => ({ ...v, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor)) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // Pointer capture starts only once the pointer has moved past a small threshold: capturing on
  // pointerdown retargets the following click to the <svg> in some browsers, so node clicks would
  // never reach the node's handler. A real pan still ends up captured (and so is not a click).
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y, panning: false };
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const d = drag.current;
    if (!d.panning) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < PAN_THRESHOLD) return;
      d.panning = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    setView((v) => ({ ...v, x: d.viewX + (e.clientX - d.startX), y: d.viewY + (e.clientY - d.startY) }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const hovered = hoverId ? graph.nodes.find((n) => n.id === hoverId) ?? null : null;
  const showAllLabels = view.scale >= LABEL_ALL_SCALE;

  return (
    <div className="project-graph">
      <p className="visually-hidden">{summarize(graph)}</p>
      <div className="graph-controls">
        <button type="button" className="btn" onClick={fitToChanges}>Fit to changes</button>
        <button type="button" className="btn" onClick={fitAll}>Fit all</button>
        <button type="button" className="btn graph-zoom" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>−</button>
        <button type="button" className="btn graph-zoom" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>+</button>
      </div>
      <svg
        className="graph-canvas"
        viewBox={`0 0 ${VIEWPORT} ${VIEWPORT}`}
        ref={svgRef}
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {graph.edges.map((e, i) => {
            const style = EDGE_STYLE[e.kind];
            if (!style) return null; // unknown/future edge kinds are ignored until styled
            const a = positions.get(e.source);
            const b = positions.get(e.target);
            if (!a || !b) return null;
            return <line key={i} className={`graph-edge ${style.className}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
          {graph.nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const r = nodeRadius(n);
            const box = isBoxShaped(n);
            const lit = highlightNodeIds?.has(n.id) ?? false;
            const selected = selectedNodeId === n.id;
            const dimmed = (highlightNodeIds?.size ?? 0) > 0 && !lit && !selected;
            const clickable = n.collapsed || n.changed;
            const label = alwaysLabeled(n, rootId) || showAllLabels || hoverId === n.id ? n.name : null;
            const cls = [
              'graph-node',
              box ? 'shape-box' : 'shape-circle',
              isFolder(n) && !box && 'folder',
              n.changed && 'changed',
              n.status === 'D' && 'deleted',
              dimmed && 'dimmed',
              (lit || selected) && 'ringed',
              clickable && 'clickable',
            ].filter(Boolean).join(' ');
            return (
              <g
                key={n.id}
                className={cls}
                transform={`translate(${p.x} ${p.y})`}
                onClick={() => {
                  if (n.collapsed) onExpand(n.path);
                  else if (n.changed) onSelectNode(n);
                }}
                onPointerEnter={() => setHoverId(n.id)}
                onPointerLeave={() => setHoverId((h) => (h === n.id ? null : h))}
              >
                {box ? (
                  <>
                    <rect className="graph-shape" x={-r} y={-r} width={r * 2} height={r * 2} rx={4} />
                    <text className="graph-count" y={4} textAnchor="middle">{n.fileCount}</text>
                  </>
                ) : (
                  <>
                    <circle className="graph-shape" r={r} />
                    {isFolder(n) && <circle className="graph-ring" r={r + 3} />}
                  </>
                )}
                {(lit || selected) && <circle className="graph-hilite-ring" r={r + (box ? 5 : 4)} />}
                {label && <text className="graph-label" y={r + 12} textAnchor="middle">{label}</text>}
              </g>
            );
          })}
        </g>
      </svg>
      <p className="chart-tip" aria-hidden="true">{hovered ? tooltipText(hovered) : ' '}</p>
      {graph.truncated && <p className="muted graph-note">Some unchanged folders are folded to keep the graph readable.</p>}
    </div>
  );
}
