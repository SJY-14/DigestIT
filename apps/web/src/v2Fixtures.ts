// Fixture v2 DTOs for component tests, built until DIG-39 (API v2) lands. Only ever imported
// from *.test.ts(x): buildProjectGraph pulls in @digestit/core's Node-only db module, which is
// fine under vitest (Node) but must never end up in the browser bundle.
import { buildProjectGraph } from '@digestit/core';
import type {
  AreaDetailDto, ContextStatusDto, DigestDetailDto, DigestFileDto, DigestPageDto, DigestSummaryDto,
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

export const fixtureArea: AreaDetailDto = {
  digestId: fixtureDigest.id,
  areaId: 'graph-pane',
  status: 'ok',
  l3: {
    why: 'The Board asked for a two-pane digest view so the project graph and the change list stay in sync.',
    design: 'A deterministic tree layout (radial seed + a fixed d3-force tick count) replaces an animated force layout to keep renders reproducible.',
    risks: ['Very large trees may still need the 400-node fold to stay readable.'],
    notes: [{ path: 'apps/web/src/ProjectGraph.tsx', side: 'new', startLine: 60, endLine: 76, note: 'Radial seed keeps siblings within their parent\'s angular sector before relaxing.' }],
  },
  files: [
    {
      ...files[0]!,
      patch: [
        '@@ -0,0 +1,4 @@',
        '+export function nodeRadius(n) {',
        '+  if (!n.changed) return 5;',
        '+  return Math.min(22, 5 + Math.sqrt(n.additions + n.deletions));',
        '+}',
      ].join('\n'),
    },
  ],
};
