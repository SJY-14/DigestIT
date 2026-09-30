// Project graph pane (DIG-42, DIG-50; docs/direction-v2.md §5, docs/ux-v3.md §4): folders/files as
// nodes, containment as edges. Every node is the same small dot (DIG-82): changed ones in ink,
// the rest light gray; lines changed are in the tip and the accessible name, not the dot size. The canvas takes the pane's real size and fits the changed nodes
// on load and whenever the digest changes. Clickable nodes (changed, or folded) are one roving tab
// stop: arrow keys move between them, focus shows the same label and tip as hover, Enter opens.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { GraphEdge, GraphNode, ProjectGraphDto } from '@digestit/core';
import { bounds, fitView, layoutGraph, rotatePositions, shouldRotate, type Point, type View } from './graphLayout.js';
import { useRovingIndex } from './charts/roving.js';
import { graphCopy, lineDelta, type Lang } from './copy.js';

/** Canvas size before the first measurement (and in environments without layout, e.g. tests). */
const DEFAULT_SIZE = { w: 640, h: 640 };
const ZOOM_STEP = 1.3;
/** Pixels the pointer must move before a press on the canvas becomes a pan. */
const PAN_THRESHOLD = 4;
const MIN_SCALE = 0.05;
const MAX_SCALE = 6;
/** Below this scale, only the "always shown" labels (changed/root/top-level/hover/focus) are drawn. */
const LABEL_ALL_SCALE = 1.5;
/** Screen radius of a node's dot, whatever the zoom (one size class, DIG-82). */
const DOT_R = 4.5;
/** Half the side of a folded folder/group's square. */
const BOX_R = 5;
/** Screen radius of a clickable node's invisible hit area (a 24px target, WCAG 2.5.8). */
const HIT_R = 12;

/** Draw style for one edge kind; edge kinds with no entry are not drawn, so a future `imports` or
 * `cochange` kind can be added to `packages/core/src/v2.ts` without touching this component. */
const EDGE_STYLE: Partial<Record<GraphEdge['kind'], { className: string }>> = {
  contains: { className: 'graph-edge-contains' },
};

function isFolder(n: GraphNode): boolean {
  return n.kind === 'root' || n.kind === 'dir';
}

/** Rounded squares for folded folders/groups (the node stands for several hidden children);
 * circles for everything shown as itself. */
function isBoxShaped(n: GraphNode): boolean {
  return n.kind === 'group' || (isFolder(n) && n.collapsed);
}

function isClickable(n: GraphNode): boolean {
  return n.collapsed || n.changed;
}

function alwaysLabeled(n: GraphNode, rootId: string | undefined): boolean {
  return n.changed || n.id === rootId || n.parentId === rootId;
}

function rootIdOf(graph: ProjectGraphDto): string | undefined {
  return graph.nodes.find((n) => n.parentId === null)?.id;
}

/** "14 files changed in 5 folders." — the one-line orientation cue read before the nodes. */
export function summarize(graph: ProjectGraphDto, lang: Lang = 'en'): string {
  const T = graphCopy(lang);
  const changedFiles = graph.nodes.filter((n) => n.kind === 'file' && n.changed).length;
  const changedFolders = graph.nodes.filter((n) => isFolder(n) && n.changed && n.id !== rootIdOf(graph)).length;
  return changedFiles === 0 ? T.summaryNone : T.summary(changedFiles, changedFolders);
}

export function tooltipText(n: GraphNode, lang: Lang = 'en'): string {
  const T = graphCopy(lang);
  const parts = [n.path || n.name];
  if (n.kind !== 'file') parts.push(T.nodeFiles(n.fileCount));
  if (n.changed) parts.push(lineDelta(n.additions, n.deletions));
  return parts.join(' · ');
}

function nodeLabel(n: GraphNode, lang: Lang = 'en'): string {
  const T = graphCopy(lang);
  return `${tooltipText(n, lang)}. ${n.collapsed ? T.expandHint : T.openHint(n.areaIds.length)}`;
}

function changedBounds(graph: ProjectGraphDto, positions: ReadonlyMap<string, Point>) {
  const changedIds = graph.nodes.filter((n) => n.changed).map((n) => n.id);
  return bounds(graph.nodes, positions, changedIds.length > 0 ? changedIds : undefined);
}

/** The fitted view for a graph: its changed nodes (or every node if none changed), plus whether
 * the layout is turned a quarter to fill the pane's shape. */
export function fitToChanged(graph: ProjectGraphDto, positions: ReadonlyMap<string, Point>, width: number, height: number): { view: View; rotated: boolean } {
  const rotated = shouldRotate(changedBounds(graph, positions), width, height);
  const shown = rotated ? rotatePositions(positions) : positions;
  return { view: fitView(changedBounds(graph, shown), width, height), rotated };
}

export interface ProjectGraphProps {
  graph: ProjectGraphDto;
  /** Nodes of the selected (or hovered) area: outlined with a ring, the rest dimmed. */
  highlightNodeIds?: ReadonlySet<string>;
  selectedNodeId?: string | null;
  /** A changed node was clicked (or activated with the keyboard). */
  onSelectNode: (node: GraphNode) => void;
  /** A folded folder or group was clicked: re-fetch the graph with this path expanded. */
  onExpand: (path: string) => void;
  /** The UI chrome's language; defaults to English for callers (mostly tests) that don't care. */
  lang?: Lang;
}

export function ProjectGraph({ graph, highlightNodeIds, selectedNodeId, onSelectNode, onExpand, lang = 'en' }: ProjectGraphProps) {
  const T = graphCopy(lang);
  const priorPositions = useRef<Map<string, Point> | undefined>(undefined);
  const layout = useMemo(() => {
    const next = layoutGraph(graph.nodes, graph.edges, priorPositions.current);
    priorPositions.current = next;
    return next;
  }, [graph]);
  const rootId = useMemo(() => rootIdOf(graph), [graph]);

  // The canvas's real size in CSS pixels; the viewBox matches it, so one layout unit at scale 1 is
  // one pixel and "fit" really fills the pane.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      if (w > 0 && h > 0) setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [initialFit] = useState(() => fitToChanged(graph, layout, size.w, size.h));
  const [view, setView] = useState<View>(initialFit.view);
  const [rotated, setRotated] = useState(initialFit.rotated);
  const positions = useMemo(() => (rotated ? rotatePositions(layout) : layout), [layout, rotated]);
  const refit = () => {
    const f = fitToChanged(graph, layout, size.w, size.h);
    setRotated(f.rotated);
    setView(f.view);
  };
  // Re-fit when the digest changes, and on resize until the user pans or zooms. Unfolding a folder
  // (same digest, new graph) keeps the current view so the user doesn't lose their place.
  const fitted = useRef({ digestId: graph.digestId, w: size.w, h: size.h, userMoved: false });
  useLayoutEffect(() => {
    const f = fitted.current;
    const digestChanged = f.digestId !== graph.digestId;
    const resized = f.w !== size.w || f.h !== size.h;
    if (digestChanged || (resized && !f.userMoved)) {
      fitted.current = { digestId: graph.digestId, w: size.w, h: size.h, userMoved: digestChanged ? false : f.userMoved };
      refit();
    } else {
      fitted.current = { ...f, w: size.w, h: size.h };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, layout, size]);

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const drag = useRef<{ startX: number; startY: number; viewX: number; viewY: number; panning: boolean } | null>(null);

  const moveView = (next: View | ((v: View) => View)) => {
    fitted.current.userMoved = true;
    setView(next);
  };
  const fitToChanges = () => {
    fitted.current.userMoved = false;
    refit();
  };
  const fitAll = () => moveView(fitView(bounds(graph.nodes, positions), size.w, size.h));
  const zoomBy = (factor: number) => moveView((v) => {
    // Zoom around the canvas center, not the layout origin.
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
    const k = scale / v.scale;
    return { scale, x: size.w / 2 - (size.w / 2 - v.x) * k, y: size.h / 2 - (size.h / 2 - v.y) * k };
  });

  // React attaches wheel listeners as passive, so preventDefault() there can't stop the page from
  // scrolling; zoom through a native non-passive listener instead.
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      zoomRef.current(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
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
    moveView((v) => ({ ...v, x: d.viewX + (e.clientX - d.startX), y: d.viewY + (e.clientY - d.startY) }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const interactive = useMemo(() => graph.nodes.filter(isClickable), [graph]);
  const activate = (n: GraphNode) => {
    if (n.collapsed) onExpand(n.path);
    else if (n.changed) onSelectNode(n);
  };
  const roving = useRovingIndex(interactive.length, (i) => {
    const n = interactive[i];
    if (n) activate(n);
  });
  const rovingIndex = useMemo(() => new Map(interactive.map((n, i) => [n.id, i])), [interactive]);

  const tipNode = (hoverId ?? focusId) ? graph.nodes.find((n) => n.id === (hoverId ?? focusId)) ?? null : null;
  const showAllLabels = view.scale >= LABEL_ALL_SCALE;
  const anyHighlight = (highlightNodeIds?.size ?? 0) > 0;

  return (
    <div className="project-graph">
      <div className="graph-toolbar">
        <ul className="graph-legend">
          <li><span className="legend-dot changed" aria-hidden="true" /> {T.legendChanged}</li>
          <li><span className="legend-dot selected" aria-hidden="true" /> {T.legendSelected}</li>
        </ul>
        <div className="graph-controls">
          <button type="button" className="btn" onClick={fitToChanges}>{T.fitChanges}</button>
          <button type="button" className="btn" onClick={fitAll}>{T.fitAll}</button>
          <button type="button" className="btn graph-zoom" aria-label={T.zoomOut} onClick={() => zoomBy(1 / ZOOM_STEP)}>−</button>
          <button type="button" className="btn graph-zoom" aria-label={T.zoomIn} onClick={() => zoomBy(ZOOM_STEP)}>+</button>
        </div>
      </div>
      <p className="visually-hidden" id="graph-summary">{summarize(graph, lang)} {T.keysHint}</p>
      <div className="graph-canvas-wrap" ref={wrapRef}>
        <svg
          className="graph-canvas"
          viewBox={`0 0 ${size.w} ${size.h}`}
          ref={svgRef}
          role="group"
          aria-label={T.label}
          aria-describedby="graph-summary"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            <g aria-hidden="true">
              {graph.edges.map((e, i) => {
                const style = EDGE_STYLE[e.kind];
                if (!style) return null; // unknown/future edge kinds are ignored until styled
                const a = positions.get(e.source);
                const b = positions.get(e.target);
                if (!a || !b) return null;
                return <line key={i} className={`graph-edge ${style.className}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
              })}
            </g>
            {graph.nodes.map((n) => {
              const p = positions.get(n.id);
              if (!p) return null;
              const box = isBoxShaped(n);
              const lit = highlightNodeIds?.has(n.id) ?? false;
              const selected = selectedNodeId === n.id;
              const focused = focusId === n.id;
              const dimmed = anyHighlight && !lit && !selected;
              const ri = rovingIndex.get(n.id);
              const label = alwaysLabeled(n, rootId) || showAllLabels || hoverId === n.id || focused ? n.name : null;
              const cls = [
                'graph-node',
                box ? 'shape-box' : 'shape-circle',
                isFolder(n) && !box && 'folder',
                n.changed && 'changed',
                n.status === 'D' && 'deleted',
                dimmed && 'dimmed',
                (lit || selected) && 'ringed',
                ri !== undefined && 'clickable',
                focused && 'focused',
              ].filter(Boolean).join(' ');
              const a11y = ri === undefined
                ? { 'aria-hidden': true as const }
                : {
                  role: 'button',
                  'aria-label': nodeLabel(n, lang),
                  tabIndex: roving.tabIndex(ri),
                  ref: roving.ref(ri),
                  onKeyDown: (e: KeyboardEvent) => roving.onKeyDown(e, ri),
                  onFocus: () => { setFocusId(n.id); roving.setFocused(ri); },
                  onBlur: () => setFocusId((f) => (f === n.id ? null : f)),
                };
              return (
                <g
                  key={n.id}
                  className={cls}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={() => activate(n)}
                  onPointerEnter={() => setHoverId(n.id)}
                  onPointerLeave={() => setHoverId((h) => (h === n.id ? null : h))}
                  {...a11y}
                >
                  {/* Shapes, rings and labels are drawn at a constant screen size: only the
                      positions follow the zoom. */}
                  <g transform={`scale(${1 / view.scale})`}>
                    {ri !== undefined && <circle className="graph-hit" r={HIT_R} />}
                    {box ? (
                      <>
                        <rect className="graph-shape" vectorEffect="non-scaling-stroke" x={-BOX_R} y={-BOX_R} width={BOX_R * 2} height={BOX_R * 2} rx={1} />
                        <text className="graph-count" x={BOX_R + 3} y={3.5}>{n.fileCount}</text>
                      </>
                    ) : (
                      <>
                        <circle className="graph-shape" vectorEffect="non-scaling-stroke" r={DOT_R} />
                        {isFolder(n) && <circle className="graph-ring" vectorEffect="non-scaling-stroke" r={DOT_R + 2.5} />}
                      </>
                    )}
                    {(lit || selected) && <circle className="graph-hilite-ring" vectorEffect="non-scaling-stroke" r={(box ? BOX_R : DOT_R) + 4} />}
                    {focused && <circle className="graph-focus-ring" vectorEffect="non-scaling-stroke" r={(box ? BOX_R : DOT_R) + 7} />}
                    {label && <text className="graph-label" y={DOT_R + 13} textAnchor="middle">{label}</text>}
                  </g>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <p className="chart-tip" aria-hidden="true">{tipNode ? tooltipText(tipNode, lang) : ' '}</p>
      {graph.truncated && <p className="muted graph-note">{T.folded}</p>}
    </div>
  );
}
