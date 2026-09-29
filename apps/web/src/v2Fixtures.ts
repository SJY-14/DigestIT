// Fixture v2 DTOs for component tests, built until DIG-39 (API v2) lands. Only ever imported
// from *.test.ts(x): buildProjectGraph pulls in @digestit/core's Node-only db module, which is
// fine under vitest (Node) but must never end up in the browser bundle.
import { buildProjectGraph } from '@digestit/core';
import type {
  AreaDetailDto, AreaProgressEvent, AreaWalkthrough, ContextStatusDto, DigestAreaSkeleton, DigestDetailDto, DigestFileDto,
  DigestPageDto, DigestPartsDto, DigestSummaryDto, ProjectDto, ProjectGraphDto, ProjectStatusDto,
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
  language: 'en',
  context: fixtureContext,
  lastCheckpointAt: '2026-09-26T16:40:00Z',
  digestCount: 3,
};

export const fixtureStatus: ProjectStatusDto = {
  project: fixtureProject,
  pending: { files: 12, additions: 340, deletions: 25 },
  budget: { limit: 40, used: 17, remaining: 23, resetsAt: '2026-09-27T00:00:00Z' },
  explaining: false,
  explainStartedAt: null,
};

/** A second, freshly registered project with no digests yet (DIG-57: project-switch tests). */
export const fixtureProject2: ProjectDto = {
  id: 2,
  name: 'my-project',
  rootPath: '/home/user/code/my-project',
  language: 'en',
  context: { status: 'none', builtAt: null, fromFiles: null, hasUserContext: false },
  lastCheckpointAt: '2026-09-27T10:00:00Z',
  digestCount: 0,
};

export const fixtureStatus2: ProjectStatusDto = {
  project: fixtureProject2,
  pending: { files: 5, additions: 0, deletions: 0 },
  budget: { limit: 40, used: 17, remaining: 23, resetsAt: '2026-09-27T00:00:00Z' },
  explaining: false,
  explainStartedAt: null,
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
  language: 'en',
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
  language: fixtureDigest.language,
};

export const fixtureDigestPage: DigestPageDto = {
  items: [
    fixtureDigestSummary,
    {
      id: 40, seq: 2, fromAt: '2026-09-26T09:00:00Z', toAt: '2026-09-26T14:05:00Z',
      stats: { files: 4, additions: 60, deletions: 10 }, status: 'ok', l0: { text: 'Digest explanation endpoint' }, language: 'en',
    },
    {
      id: 39, seq: 1, fromAt: '2026-09-25T09:00:00Z', toAt: '2026-09-26T09:00:00Z',
      stats: { files: 6, additions: 90, deletions: 4 }, status: 'error', l0: null, language: 'en',
    },
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

/** The gray structure graph `GET /api/projects/:id/graph` returns for a project with no digest
 * yet (DIG-58/59): every node `changed: false`, no areas. */
export const fixtureProjectGraph: ProjectGraphDto = (() => {
  const paths = ['src/index.ts', 'src/lib/join.ts', 'README.md'];
  const result = buildProjectGraph({ paths, files: [] });
  return { digestId: null, ...result };
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
  l3: fixtureWalkthrough,
  files: [
    { ...files[0]!, additions: 32, deletions: 2, patch: graphPatch },
    { path: 'packages/core/src/graphLayout.ts', oldPath: null, status: 'M', additions: 4, deletions: 3, filteredReason: null, patch: layoutPatch },
    { ...files[3]!, patch: null },
  ],
};

// ---- Fast Explain (DIG-73/76, docs/explain-speed.md): a digest that opens instantly (files,
// stats, deterministic areas) and fills in L0/L1/L2 text and the L3 walkthrough as parts land. A
// fresh set of files/areas, not the ones above, so a test can freely mix an old-contract digest
// (no `areas`/`parts`) with a Fast Explain one without the two colliding on ids. ----

const fastFiles: DigestFileDto[] = [
  { path: 'apps/web/src/SearchBox.tsx', oldPath: null, status: 'A', additions: 80, deletions: 0, filteredReason: null },
  { path: 'apps/web/src/SearchBox.test.tsx', oldPath: null, status: 'A', additions: 40, deletions: 0, filteredReason: null },
  { path: 'packages/core/src/search.ts', oldPath: null, status: 'M', additions: 20, deletions: 4, filteredReason: null },
];

export const fixtureAreaSkeletons: DigestAreaSkeleton[] = [
  { id: 'apps-web', label: 'apps/web', paths: ['apps/web/src/SearchBox.tsx', 'apps/web/src/SearchBox.test.tsx'], additions: 120, deletions: 0 },
  { id: 'packages-core', label: 'packages/core', paths: ['packages/core/src/search.ts'], additions: 20, deletions: 4 },
];

const fastPartsRunning: DigestPartsDto = {
  summary: 'running',
  areas: { 'apps-web': 'pending', 'packages-core': 'pending' },
  context: 'running', // a first Explain: the project context builds alongside (DIG-76 scope 6)
  startedAt: '2026-09-29T10:00:00Z',
  finishedAt: null,
};

/** Right after the POST resolves: files/stats/areas exist, nothing else has landed yet. */
export const fixtureDigestPending: DigestDetailDto = {
  id: 100,
  projectId: 1,
  seq: 4,
  fromAt: '2026-09-29T09:00:00Z',
  toAt: '2026-09-29T10:00:00Z',
  stats: { files: 3, additions: 140, deletions: 4 },
  status: 'pending',
  language: 'en',
  l0: null,
  l1: null,
  l2: { notAnalysed: [], items: [] },
  files: fastFiles,
  skipped: [],
  areas: fixtureAreaSkeletons,
  parts: fastPartsRunning,
};

/** The summary and one area have landed; the other area part failed. */
export const fixtureDigestPartial: DigestDetailDto = {
  ...fixtureDigestPending,
  l0: { text: 'Add a search box to the header' },
  l1: { userVisible: true, bullets: ['A search box now appears in the header and searches as you type.'] },
  l2: {
    notAnalysed: [],
    items: [
      {
        id: 'apps-web',
        paths: fixtureAreaSkeletons[0]!.paths,
        title: 'Header search box',
        effect: 'A search box appears in the header and filters results as you type.',
        how: 'Added SearchBox.tsx, wired into the header, calling the existing search index.',
        why: 'Users asked for a quick way to jump to a file without opening the graph.',
      },
    ],
  },
  parts: { summary: 'ok', areas: { 'apps-web': 'ok', 'packages-core': 'error' }, context: 'ok', startedAt: fastPartsRunning.startedAt, finishedAt: null },
};

/** Every part landed. */
export const fixtureDigestDone: DigestDetailDto = {
  ...fixtureDigestPartial,
  status: 'ok',
  l2: {
    notAnalysed: [],
    items: [
      ...fixtureDigestPartial.l2!.items,
      {
        id: 'packages-core',
        paths: fixtureAreaSkeletons[1]!.paths,
        title: 'Search index helper',
        effect: 'No visible change on its own.',
        how: 'search.ts gained a case-insensitive prefix match used by the new search box.',
        why: 'The header search box needs a fast, simple match against file paths.',
      },
    ],
  },
  parts: { summary: 'ok', areas: { 'apps-web': 'ok', 'packages-core': 'ok' }, context: 'ok', startedAt: fastPartsRunning.startedAt, finishedAt: '2026-09-29T10:00:20Z' },
};

const searchBoxPatch = [
  '@@ -0,0 +1,6 @@',
  '+export function SearchBox({ onSearch }: { onSearch: (q: string) => void }) {',
  '+  return (',
  '+    <input type="search" aria-label="Search" onChange={(e) => onSearch(e.target.value)} />',
  '+  );',
  '+}',
].join('\n');

/** The area L3 is still streaming: no `l3` yet, `status: 'pending'`. Paired with
 * `fixtureAreaProgressSteps` below for a test that renders steps arriving one by one. */
export const fixtureStreamingArea: AreaDetailDto = {
  digestId: fixtureDigestDone.id,
  areaId: 'apps-web',
  status: 'pending',
  l3: null,
  files: [{ ...fastFiles[0]!, patch: searchBoxPatch }],
};

const streamStep1 = {
  title: 'Add the search box component',
  body: 'SearchBox renders a labelled search input and calls onSearch on every change.',
  hunks: [{ path: 'apps/web/src/SearchBox.tsx', hunk: 1 }],
  mechanical: false,
};

/** `area-progress` events for `apps-web`, in arrival order: the overview lands, then the one step,
 * then `done`. A test drives these through a fake EventSource one at a time. */
export const fixtureAreaProgressSteps: AreaProgressEvent[] = [
  { areaId: 'apps-web', overview: null, steps: [], done: false },
  { areaId: 'apps-web', overview: 'A search box is added to the header, backed by the existing search index.', steps: [], done: false },
  { areaId: 'apps-web', overview: 'A search box is added to the header, backed by the existing search index.', steps: [streamStep1], done: false },
  { areaId: 'apps-web', overview: 'A search box is added to the header, backed by the existing search index.', steps: [streamStep1], done: true },
];

/** The authoritative result `fetchArea` returns once the stream's `done` event lands: same steps
 * here (a real style/coverage retry could change them), now with `check` and `status: 'ok'`. */
export const fixtureStreamingAreaFinal: AreaDetailDto = {
  ...fixtureStreamingArea,
  status: 'ok',
  l3: {
    overview: 'A search box is added to the header, backed by the existing search index.',
    steps: [streamStep1],
    check: ['Typing quickly should not spam the search index with every keystroke.'],
  },
};

/** `DigestSummaryDto` counterpart of `fixtureDigestPending`, for a digest-list page whose only
 * entry is the in-flight Fast Explain digest. */
export const fixtureFastDigestSummary: DigestSummaryDto = {
  id: fixtureDigestPending.id,
  seq: fixtureDigestPending.seq,
  fromAt: fixtureDigestPending.fromAt,
  toAt: fixtureDigestPending.toAt,
  stats: fixtureDigestPending.stats,
  status: fixtureDigestPending.status,
  l0: null,
  language: 'en',
};

export const fixtureFastGraph: ProjectGraphDto = (() => {
  const paths = fastFiles.map((f) => f.path);
  const result = buildProjectGraph({
    paths,
    files: fastFiles.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    areas: fixtureAreaSkeletons.map((a) => ({ id: a.id, paths: a.paths })),
  });
  return { digestId: fixtureDigestPending.id, ...result };
})();
