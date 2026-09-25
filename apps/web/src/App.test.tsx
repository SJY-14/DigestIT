// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metrics, WorkUnitDetail, WorkUnitSummary } from './api.js';
import { App } from './App.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unit = (over: Partial<WorkUnitSummary> = {}): WorkUnitSummary => ({
  id: 1, repoId: 1, key: 'DIG-1', kind: 'issue', title: 'DIG-1 in the live list', state: 'active', tipSha: 'a'.repeat(40),
  firstCommitAt: '2026-01-01T00:00:00Z', lastCommitAt: '2026-01-01T01:00:00Z', mergedAt: null,
  latestRangeUnitId: null, commitCount: 1, l0: { status: 'ok', content: { text: 'On the live list' } },
  pendingBudget: false, dirty: [], ...over,
});

// A unit the digest drill returns that is NOT on the live units/digest lists (e.g. it landed and
// was decided outside the first page or the last-hour window).
const drilledUnit = unit({ id: 99, key: 'DIG-99', title: 'DIG-99 only reachable via drill', l0: { status: 'ok', content: { text: 'Only via drill' } } });

const metrics: Metrics = {
  generatedAt: 'x',
  global: {
    unreadBacklog: 0, undecidedBacklog: 0, medianTimeToOpenSec: null, medianTimeToDecideSec: null,
    digestVsProduction: {
      windowDays: 1, landed: 1, decided: 0, ratio: null,
      perDay: [{ day: '2026-01-01', landed: 1, decided: 0 }],
    },
  },
  units: [],
};

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/insights');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = ((): unknown => {
        if (url.startsWith('/api/repos/') && url.includes('/timeline')) return { commits: [], nextCursor: null };
        if (url === '/api/repos' || url.startsWith('/api/repos?')) return { repos: [{ id: 1, name: 'digestit', headSha: 'a'.repeat(40), ingestedAt: '2026-01-01T00:00:00Z' }] };
        if (url.startsWith('/api/work-units/DIG-99')) return { ...drilledUnit, members: [], ranges: [], explanation: null } satisfies WorkUnitDetail;
        if (url.startsWith('/api/work-units')) return { workUnits: [unit()], nextCursor: null };
        if (url.startsWith('/api/window')) return { since: 'x', until: 'y', workUnits: [], rollup: null };
        if (url.startsWith('/api/metrics')) return metrics;
        if (url.startsWith('/api/insights/drill')) return { workUnits: [drilledUnit] };
        if (url.startsWith('/api/ui-events')) return {};
        throw new Error(`unhandled fetch in test: ${url}`);
      })();
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

const render = async (el: ReactElement) => { await act(async () => root.render(el)); };
const flush = () => act(async () => undefined);
const click = async (el: Element | null | undefined) => {
  await act(async () => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};
const waitFor = async (check: () => boolean, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await flush();
  }
  throw new Error('waitFor: condition never became true');
};

describe('App: drilling into a unit outside the live list', () => {
  it('opens the unit panel for a unit that is not in live.units or live.digestUnits', async () => {
    await render(<App />);
    await waitFor(() => host.querySelector('.mark-group') !== null);

    await click(host.querySelector('.mark-group'));
    expect(host.textContent).toContain('Landed on 2026-01-01');
    await waitFor(() => host.querySelector('.unit-main') !== null);

    await click(host.querySelector('.unit-main'));
    await waitFor(() => host.querySelector('.unit-info .key') !== null);

    // The panel opened with the drilled-in unit's data, even though it never appeared in
    // useLive's `units`/`digestUnits` lists.
    expect(host.querySelector('.unit-info .key')?.textContent).toBe('DIG-99');
    expect(host.textContent).toContain('Only via drill');
  });
});
