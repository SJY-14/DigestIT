// Sample data for the primitives gallery and for manual/visual review before the insights read
// API (M3-1) lands. Shapes mirror what `/api/insights/*` is expected to return.

export const galleryDays = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07'];

export const galleryBarSeries = [
  { key: 'landed', label: 'Landed', className: 'series-1', values: [3, 5, 2, 6, 4, 1, 3] },
  { key: 'decided', label: 'Decided', className: 'series-2', values: [1, 4, 3, 4, 5, 2, 2] },
];

export const galleryLineSeries = [
  { key: 'unread', label: 'Unread backlog', className: 'series-1', values: [8, 6, 7, 5, 4, 6, 3] },
];

export const galleryAreas = ['apps/web', 'apps/server', 'packages/core', 'packages/explain'];

export const galleryHeatmap = [
  [0, 2, 5, 8, 3, 0, 1],
  [4, 0, 0, 3, 6, 2, 0],
  [1, 1, 0, 0, 2, 0, 4],
  [0, 3, 2, 5, 0, 1, 0],
];

export const galleryDotGroups = [
  { key: 'W1', values: [120, 340, 60, 900, 210] },
  { key: 'W2', values: [80, 150, 400] },
  { key: 'W3', values: [60, 60, 75, 500, 620, 30] },
  { key: 'W4', values: [200] },
];
