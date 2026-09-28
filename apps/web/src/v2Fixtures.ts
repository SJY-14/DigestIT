// Fixture v2 DTOs for component tests, built until DIG-39 (API v2) lands. Only ever imported
// from *.test.ts(x): buildProjectGraph pulls in @digestit/core's Node-only db module, which is
// fine under vitest (Node) but must never end up in the browser bundle.
import { buildProjectGraph } from '@digestit/core';
import type {
  AreaDetailDto, AreaWalkthrough, ContextStatusDto, DigestDetailDto, DigestFileDto, DigestPageDto, DigestSummaryDto,
  ProjectDto, ProjectGraphDto, ProjectStatusDto,
} from '@digestit/core';

export const fixtureContext: ContextStatusDto = {
  status: 'ok',
  builtAt: '2026-09-25T09:00:00Z',
  fromFiles: 42,
  hasUserContext: true,
};

export const fixtureProject: ProjectDto = {
  id: 1,
  name: 'digestit',
  rootPath: '/home/user/code/digestit',
  context: fixtureContext,
  lastCheckpointAt: '2026-09-26T16:40:00Z',
  digestCount: 3,
};

export const fixtureStatus: ProjectStatusDto = {
  project: fixtureProject,
  pending: { files: 12, additions: 340, deletions: 25 },
  budget: { limit: 40, used: 17, remaining: 23, resetsAt: '2026-09-27T00:00:00Z' },
  explaining: false,
};

const files: DigestFileDto[] = [
  { path: 'apps/web/src/ProjectGraph.tsx', oldPath: null, status: 'A', additions: 180, deletions: 0, filteredReason: null },
  { path: 'apps/web/src/AreaView.tsx', oldPath: null, status: 'A', additions: 120, deletions: 0, filteredReason: null },
  { path: 'apps/web/src/MainV2.tsx', oldPath: null, status: 'M', additions: 40, deletions: 25, filteredReason: null },
  { path: 'package-lock.bin', oldPath: null, status: 'M', additions: 0, deletions: 0, filteredReason: 'too_large' },
];

export const fixtureDigest: DigestDetailDto = {
  id: 41,
  projectId: 1,
  seq: 3,
  fromAt: '2026-09-26T14:05:00Z',
  toAt: '2026-09-26T16:40:00Z',
  stats: { files: 12, additions: 340, deletions: 25 },
  status: 'ok',
  l0: { text: 'Two-pane main screen: change list plus project graph' },
  l1: { userVisible: true, bullets: ['The home screen now shows a project graph next to the change list.'] },
  l2: {
    notAnalysed: ['package-lock.bin'],
    items: [
      {
        id: 'graph-pane',
        paths: ['apps/web/src/ProjectGraph.tsx', 'packages/core/src/graph.ts'],
        title: 'Project graph pane',
        effect: 'A force-directed folder/file graph appears next to the change list.',
        how: 'Added a deterministic tree layout (buildProjectGraph) and an SVG renderer with pan/zoom.',
        why: 'The Board asked for a two-pane digest view so structure and changes are visible together.',
      },
      {
        id: 'area-view',
        paths: ['apps/web/src/AreaView.tsx'],
        title: 'L3 area code view',
        effect: 'Clicking Code on a row now shows the annotated diff in place of the graph.',
        how: 'Reused the existing diff parser/annotator with GitHub-style hunk folding.',
        why: 'Long diffs need folding so the why/design/risks stay the focus.',
      },
    ],
  },
  files,
  skipped: [],
};

export const fixtureDigestSummary: DigestSummaryDto = {
  id: fixtureDigest.id,
  seq: fixtureDigest.seq,
  fromAt: fixtureDigest.fromAt,
  toAt: fixtureDigest.toAt,
  stats: fixtureDigest.stats,
  status: fixtureDigest.status,
  l0: fixtureDigest.l0,
};

export const fixtureDigestPage: DigestPageDto = {
  items: [
    fixtureDigestSummary,
    { id: 40, seq: 2, fromAt: '2026-09-26T09:00:00Z', toAt: '2026-09-26T14:05:00Z', stats: { files: 4, additions: 60, deletions: 10 }, status: 'ok', l0: { text: 'Digest explanation endpoint' } },
    { id: 39, seq: 1, fromAt: '2026-09-25T09:00:00Z', toAt: '2026-09-26T09:00:00Z', stats: { files: 6, additions: 90, deletions: 4 }, status: 'error', l0: null },
  ],
  nextCursor: null,
};

export const fixtureGraph: ProjectGraphDto = (() => {
  const paths = [
    'apps/web/src/ProjectGraph.tsx', 'apps/web/src/AreaView.tsx', 'apps/web/src/MainV2.tsx', 'apps/web/src/App.tsx',
    'packages/core/src/graph.ts', 'packages/core/src/v2.ts', 'docs/direction-v2.md', 'package-lock.bin',
  ];
  const result = buildProjectGraph({
    paths,
    files: files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    areas: fixtureDigest.l2!.items.map((it) => ({ id: it.id, paths: it.paths })),
  });
  return { digestId: fixtureDigest.id, ...result };
})();

const graphPatch = [
  'diff --git a/apps/web/src/ProjectGraph.tsx b/apps/web/src/ProjectGraph.tsx',
  '--- a/apps/web/src/ProjectGraph.tsx',
  '+++ b/apps/web/src/ProjectGraph.tsx',
  '@@ -60,4 +60,7 @@ export function ProjectGraph({ graph }: ProjectGraphProps) {',
  '   const rootId = useMemo(() => rootIdOf(graph), [graph]);',
  '-  const VIEWPORT = 640;',
  '+  const wrapRef = useRef<HTMLDivElement>(null);',
  '+  const [size, setSize] = useState({ w: 640, h: 640 });',
  '+  useLayoutEffect(() => observeSize(wrapRef.current, setSize), []);',
  '+',
  '   const drag = useRef<DragState | null>(null);',
  '   const svgRef = useRef<SVGSVGElement>(null);',
  '@@ -90,3 +93,30 @@ export function ProjectGraph({ graph }: ProjectGraphProps) {',
  '   const [view, setView] = useState<View>(initial);',
  '-  if (priorGraph.current !== graph) setView(fitted);',
  ...Array.from({ length: 28 }, (_, i) => `+  // refit step ${i + 1}: keep the view when only a folder was unfolded`),
  '   return null;',
  '@@ -200,2 +229,3 @@ export function ProjectGraph({ graph }: ProjectGraphProps) {',
  '   <p className="chart-tip">{tip}</p>',
  '+  <p className="muted graph-note">{T.folded}</p>',
  '   </div>',
].join('\n');

const layoutPatch = [
  '@@ -120,4 +120,5 @@ export function bounds(nodes, positions, ids) {',
  '-export function fitView(b: Bounds | null, viewport = 640): View {',
  '-  const scale = (viewport * 0.85) / Math.max(w, h);',
  '+export function fitView(b: Bounds | null, width = 640, height = width): View {',
  '+  const pad = fitPadding(width, height);',
  '+  const scale = Math.min((width - 2 * pad.x) / w, (height - 2 * pad.y) / h);',
  '   const cx = (b.minX + b.maxX) / 2;',
  '   const cy = (b.minY + b.maxY) / 2;',
  '@@ -140,2 +143,2 @@ export const MAX_FIT_SCALE = 1.5;',
  '-const fitPad = (w: number) => w * 0.1;',
  '+const fitPadding = (w: number) => w * 0.1;',
  '   export { fitPadding };',
].join('\n');

/** An area L3 in the walkthrough shape (docs/ux-v3.md §2): 4 steps (one mechanical), a long hunk
 * that folds, and one hunk no step covers. */
export const fixtureWalkthrough: AreaWalkthrough = {
  overview:
    'The graph pane now measures itself and fits the changed files into the space it really has, instead of drawing into a fixed 640-pixel square. The fit runs again when you open another digest, but not when you unfold a folder.',
  steps: [
    {
      title: 'Measure the pane before drawing',
      body: 'ProjectGraph now keeps the canvas size in state and updates it from a ResizeObserver. Before, the SVG used a fixed 640×640 viewBox, so a wide pane had large empty margins on both sides.',
      hunks: [{ path: 'apps/web/src/ProjectGraph.tsx', hunk: 1 }],
      mechanical: false,
    },
    {
      title: 'Fit to changes on every new digest',
      body: 'The view is refitted when graph.digestId changes or when the pane is resized and the user has not panned. Unfolding a folder returns a new graph for the same digest, so it keeps the current view and the user does not lose their place.',
      hunks: [{ path: 'apps/web/src/ProjectGraph.tsx', hunk: 2 }],
      mechanical: false,
    },
    {
      title: 'Fit into a rectangle, not a square',
      body: 'fitView takes a width and a height and keeps a fixed screen margin (fitPadding) so labels at the edge are not clipped. It used to scale by 85% of the square side.',
      hunks: [{ path: 'packages/core/src/graphLayout.ts', hunk: 1 }],
      mechanical: false,
    },
    {
      title: 'Rename the padding helper',
      body: 'fitPad becomes fitPadding. No behaviour change.',
      hunks: [{ path: 'packages/core/src/graphLayout.ts', hunk: 2 }],
      mechanical: true,
    },
  ],
  check: [
    'Resize the window with the graph panned: the view should stay where you left it.',
    'A digest whose only change is a deleted file still fits (the node is drawn dashed).',
  ],
};

export const fixtureArea: AreaDetailDto = {
  digestId: fixtureDigest.id,
  areaId: 'graph-pane',
  status: 'ok',
  // Cast: AreaDetailDto.l3 switches to AreaWalkthrough with DIG-48.
  l3: fixtureWalkthrough as unknown as AreaDetailDto['l3'],
  files: [
    { ...files[0]!, additions: 32, deletions: 2, patch: graphPatch },
    { path: 'packages/core/src/graphLayout.ts', oldPath: null, status: 'M', additions: 4, deletions: 3, filteredReason: null, patch: layoutPatch },
    { ...files[3]!, patch: null },
  ],
};
