// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
        if (url === '/api/projects') return [];
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

describe('App: v2 nav (DIG-40)', () => {
  it('renders the v2 main screen at "/", with the old pages moved under a History menu', async () => {
    history.replaceState(null, '', '/');
    await render(<App />);
    await waitFor(() => host.querySelector('.setup-form') !== null);
    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe('Home');

    const menu = host.querySelector('.history-menu') as HTMLDetailsElement;
    expect(menu).toBeTruthy();
    const links = [...menu.querySelectorAll('a')].map((a) => a.textContent);
    expect(links).toEqual(['Units', 'Timeline', 'Briefing', 'Insights']);

    await click(menu.querySelector('a'));
    await waitFor(() => host.querySelector('.setup-form') === null);
    expect(location.pathname).toBe('/units');
  });

  it('resets scroll when switching pages, so a list on the new page never opens scrolled past its own top', async () => {
    // Regression for DIG-46: pushState-based page switches don't reset scroll on their own, so
    // switching tabs while scrolled down (e.g. a tall main-screen digest) could land the new
    // page's viewport scrolled straight past its own header and list.
    history.replaceState(null, '', '/');
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    await render(<App />);
    await waitFor(() => host.querySelector('.setup-form') !== null);

    const menu = host.querySelector('.history-menu') as HTMLDetailsElement;
    await click(menu.querySelector('a[href="/timeline"]'));
    await waitFor(() => location.pathname === '/timeline');

    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    await click(host.querySelector('a[href="/"]'));
    await waitFor(() => location.pathname === '/');
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('closes the History menu after picking a page, on an outside click and on Escape', async () => {
    history.replaceState(null, '', '/');
    await render(<App />);
    await waitFor(() => host.querySelector('.setup-form') !== null);
    const menu = host.querySelector('.history-menu') as HTMLDetailsElement;

    menu.open = true;
    await click(menu.querySelector('a[href="/timeline"]'));
    await waitFor(() => location.pathname === '/timeline');
    expect(menu.open).toBe(false);

    menu.open = true;
    await click(host.querySelector('.top h1'));
    expect(menu.open).toBe(false);

    menu.open = true;
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(menu.open).toBe(false);
  });

  it('returns Home to the same project/digest query it left from', async () => {
    history.replaceState(null, '', '/?project=2&digest=7');
    await render(<App />);
    await flush();
    const menu = host.querySelector('.history-menu') as HTMLDetailsElement;
    await click(menu.querySelector('a[href="/units"]'));
    await waitFor(() => location.pathname === '/units');
    expect(location.search).toBe('');

    await click(host.querySelector('a[href="/"]'));
    await waitFor(() => location.pathname === '/');
    expect(location.search).toBe('?project=2&digest=7');
  });
});

describe('styles: History dropdown is not clipped (DIG-46)', () => {
  it('the header that contains the absolutely positioned History menu has no clip-path or overflow clipping', () => {
    // jsdom has no layout, so guard the rule itself: an earlier full-bleed trick
    // (clip-path: inset(0 -100vmax)) clipped the dropdown to the header's height, hiding it.
    // (Vitest stubs CSS imports, even ?raw, so read the file.)
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/(^|})\s*([^{}]*)\{([^}]*)\}/g)]
      .filter((m) => m[2]!.split(',').some((sel) => /^\s*\.(top|nav|history-menu)\s*$/.test(sel)))
      .map((m) => m[3]!);
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) expect(body).not.toMatch(/clip-path|overflow\s*:|contain\s*:/);
  });
});
