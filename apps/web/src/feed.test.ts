import { describe, expect, it } from 'vitest';
import type { Metrics, WorkUnitSummary } from './api.js';
import { formatDuration, mergePages, pendingChanges, reviewStates, snapshot, unitText, visibleUnits } from './feed.js';

const u = (id: number, last = '2026-01-01T00:00:00Z', extra: Partial<WorkUnitSummary> = {}): WorkUnitSummary => ({
  id, repoId: 1, key: `DIG-${id}`, kind: 'issue', title: `T${id}`, state: 'active', tipSha: null,
  firstCommitAt: last, lastCommitAt: last, mergedAt: null, latestRangeUnitId: null, commitCount: 1,
  l0: { status: 'pending', content: null }, pendingBudget: false, dirty: [], ...extra,
});

describe('frozen feed', () => {
  it('counts new and moved units but keeps the shown order', () => {
    const shown = snapshot([u(2), u(1)]);
    const fresh = [u(3), u(1, '2026-01-02T00:00:00Z'), u(2)];
    expect(pendingChanges(shown, fresh)).toBe(2);
    expect(visibleUnits(shown, fresh).map((x) => x.id)).toEqual([2, 1]);
  });
  it('refreshes content of shown units in place without counting it', () => {
    const shown = snapshot([u(1)]);
    const fresh = [u(1, undefined, { pendingBudget: true })];
    expect(pendingChanges(shown, fresh)).toBe(0);
    expect(visibleUnits(shown, fresh)[0]?.pendingBudget).toBe(true);
  });
  it('a state change counts as movement', () => {
    expect(pendingChanges(snapshot([u(1)]), [u(1, undefined, { state: 'merged' })])).toBe(1);
  });
  it('drops vanished units and dedupes pages', () => {
    expect(visibleUnits(snapshot([u(1), u(2)]), [u(2)]).map((x) => x.id)).toEqual([2]);
    expect(mergePages([u(3), u(2)], [u(2), u(1)]).map((x) => x.id)).toEqual([3, 2, 1]);
  });
});

describe('helpers', () => {
  it('derives unread from metrics', () => {
    const m = { units: [
      { id: 1, landedAt: 'x', timeToOpenSec: null, decidedBy: null },
      { id: 2, landedAt: 'x', timeToOpenSec: 5, decidedBy: 'reviewed' },
      { id: 3, landedAt: null, timeToOpenSec: null, decidedBy: null },
    ] } as unknown as Metrics;
    const s = reviewStates(m);
    expect(s.get(1)?.unread).toBe(true);
    expect(s.get(2)).toEqual({ unread: false, decidedBy: 'reviewed' });
    expect(s.get(3)?.unread).toBe(false);
    expect(reviewStates(null).size).toBe(0);
  });
  it('formats durations', () => {
    expect([null, 12, 300, 7200, 400000].map(formatDuration)).toEqual(['–', '12 s', '5 min', '2.0 h', '5 d']);
  });
  it('uses L0 text only when ok', () => {
    expect(unitText(u(1, undefined, { l0: { status: 'ok', content: { text: ' Why ' } } }))).toEqual({ text: 'Why', explained: true });
    expect(unitText(u(1))).toEqual({ text: 'T1', explained: false });
  });
});
