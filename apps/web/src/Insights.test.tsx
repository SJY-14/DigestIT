// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metrics } from './api.js';
import { Insights, insightsUrlSearch, readInsightsUrlState } from './Insights.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const metrics: Metrics = {
  generatedAt: 'x',
  global: {
    unreadBacklog: 2, undecidedBacklog: 3, medianTimeToOpenSec: 120, medianTimeToDecideSec: null,
    digestVsProduction: {
      windowDays: 2, landed: 4, decided: 2, ratio: 0.5,
      perDay: [{ day: '2026-01-01', landed: 3, decided: 1 }, { day: '2026-01-02', landed: 1, decided: 1 }],
    },
  },
  units: [{ id: 7, key: 'DIG-7', state: 'active', landedAt: 'x', timeToLandSec: 1, timeToExplainSec: 60, timeToOpenSec: 120, timeToDecideSec: null, decidedBy: null, levelsViewedBeforeDeciding: [0, 3], reopens: 1 }],
};

let root: Root;
let host: HTMLElement;
const noop = () => undefined;

beforeEach(() => {
  history.replaceState(null, '', '/insights');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ workUnits: [] }) } as Response)));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = async (el: ReactElement) => { await act(async () => root.render(el)); };
const click = async (el: Element | null | undefined) => {
  await act(async () => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};

describe('readInsightsUrlState / insightsUrlSearch', () => {
  it('round-trips tab, window, area, day and metric', () => {
    const state = readInsightsUrlState('?tab=map&window=30d&area=apps%2Fweb&day=2026-01-01&metric=landed');
    expect(state).toEqual({ tab: 'map', window: '30d', area: 'apps/web', day: '2026-01-01', metric: 'landed' });
    expect(readInsightsUrlState(insightsUrlSearch(state))).toEqual(state);
  });

  it('defaults to the digest tab and omits it from the URL', () => {
    expect(readInsightsUrlState('')).toEqual({ tab: 'digest', window: null, area: null, day: null, metric: null });
    expect(insightsUrlSearch({ tab: 'digest', window: null, area: null, day: null, metric: null })).toBe('');
  });
});

describe('Insights', () => {
  it('shows the digest tiles and the migrated per-day chart', async () => {
    await render(<Insights metrics={metrics} error={null} reviews={new Map()} onSelectUnit={noop} onOpenCommit={noop} />);
    expect(host.textContent).toContain('Unread backlog');
    expect(host.textContent).toContain('falling behind');
    expect(host.querySelectorAll('.bar.series-1')).toHaveLength(2);
    expect(host.querySelector('svg[role="group"]')?.getAttribute('aria-label')).toContain('per day');
  });

  it('switches tabs and shows a not-available placeholder for map and blind spots', async () => {
    await render(<Insights metrics={metrics} error={null} reviews={new Map()} onSelectUnit={noop} onOpenCommit={noop} />);
    const tab = (label: string) => [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent === label);
    await click(tab('Map'));
    expect(host.textContent).toContain("change map isn't available yet");
    expect(tab('Map')?.getAttribute('aria-selected')).toBe('true');
    expect(tab('Map')?.getAttribute('aria-controls')).toBe(host.querySelector('[role="tabpanel"]')?.id);
    await click(tab('Blind spots'));
    expect(host.textContent).toContain("Blind spots isn't available yet");
  });

  it('moves tab selection with the arrow keys', async () => {
    await render(<Insights metrics={metrics} error={null} reviews={new Map()} onSelectUnit={noop} onOpenCommit={noop} />);
    const tab = (label: string) => [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent === label);
    await act(async () => tab('Digest')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(tab('Map')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Map'));
  });

  it('opens a drill-down list when a bar is activated, scoped to that day and metric, and puts it in the URL', async () => {
    await render(<Insights metrics={metrics} error={null} reviews={new Map()} onSelectUnit={noop} onOpenCommit={noop} />);
    await click(host.querySelector('.mark-group'));
    expect(host.textContent).toContain('Landed on 2026-01-01');
    await act(async () => undefined);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/insights/drill?day=2026-01-01&metric=landed');
    expect(location.search).toContain('day=2026-01-01');
    expect(location.search).toContain('metric=landed');
  });

  it('restores an open drill from the URL on mount (deep link / reload)', async () => {
    history.replaceState(null, '', '/insights?day=2026-01-01&metric=landed');
    await render(<Insights metrics={metrics} error={null} reviews={new Map()} onSelectUnit={noop} onOpenCommit={noop} />);
    expect(host.textContent).toContain('Landed on 2026-01-01');
  });

  it('closing the drill clears it from the URL', async () => {
    await render(<Insights metrics={metrics} error={null} reviews={new Map()} onSelectUnit={noop} onOpenCommit={noop} />);
    await click(host.querySelector('.mark-group'));
    const closeBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Close');
    await click(closeBtn);
    expect(host.textContent).not.toContain('Landed on 2026-01-01');
    expect(location.search).not.toContain('day=');
  });
});
