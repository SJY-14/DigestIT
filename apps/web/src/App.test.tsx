// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metrics, WorkUnitDetail, WorkUnitSummary } from './api.js';
import { App } from './App.js';
import { fixtureProject } from './v2Fixtures.js';

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

/** Every test shares the same legacy timeline/work-unit/metrics fixtures; only what `/api/projects`
 * returns (the v2 projects list DIG-60's language lookup reads) varies per test. `projects` may be
 * an `Error` to simulate the cold-load language fetch failing. */
function makeFetchMock(projects: unknown[] | Error = []) {
  return vi.fn(async (url: string) => {
    const body = ((): unknown => {
      if (url.startsWith('/api/repos/') && url.includes('/timeline')) return { commits: [], nextCursor: null };
      if (url === '/api/repos' || url.startsWith('/api/repos?')) return { repos: [{ id: 1, name: 'digestit', headSha: 'a'.repeat(40), ingestedAt: '2026-01-01T00:00:00Z' }] };
      if (url.startsWith('/api/work-units/DIG-99')) return { ...drilledUnit, members: [], ranges: [], explanation: null } satisfies WorkUnitDetail;
      if (url.startsWith('/api/work-units')) return { workUnits: [unit()], nextCursor: null };
      if (url.startsWith('/api/window')) return { since: 'x', until: 'y', workUnits: [], rollup: null };
      if (url.startsWith('/api/metrics')) return metrics;
      if (url.startsWith('/api/insights/drill')) return { workUnits: [drilledUnit] };
      if (url.startsWith('/api/ui-events')) return {};
      if (url === '/api/projects') {
        if (projects instanceof Error) throw projects;
        return projects;
      }
      throw new Error(`unhandled fetch in test: ${url}`);
    })();
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

class FakeIntersectionObserver {
  observe() { /* no-op: tests drive loading via direct calls, not real scroll */ }
  disconnect() { /* no-op */ }
  unobserve() { /* no-op */ }
}

beforeEach(() => {
  history.replaceState(null, '', '/insights');
  vi.stubGlobal('fetch', makeFetchMock());
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
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
    const links = [...menu.querySelectorAll('a .menu-item-label')].map((el) => el.textContent);
    expect(links).toEqual(['Units', 'Timeline', 'Briefing', 'Insights']);

    // P3: a non-interactive "Other views" label, and a visible one-line description per item
    // (a <span>, not a hover-only `title`).
    expect(menu.querySelector('.history-menu-label')?.textContent).toBe('Other views');
    const descs = [...menu.querySelectorAll('a .menu-item-desc')].map((el) => el.textContent);
    expect(descs).toEqual([
      'Group changes by ticket/issue',
      'Changes in chronological order',
      'Narrative summary over a date range',
      'Charts and trends across digests',
    ]);
    expect(menu.querySelectorAll('a[title]')).toHaveLength(0);

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

describe('DIG-60: localized nav chrome follows the project language', () => {
  const koProject = { ...fixtureProject, id: 1, language: 'ko' as const };

  it('learns the language from MainV2 on Home, and keeps it after switching to a History page (ref path)', async () => {
    history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', makeFetchMock([koProject]));
    await render(<App />);
    await waitFor(() => host.querySelector('a[href="/"]')?.textContent === '홈');

    const menu = host.querySelector('.history-menu') as HTMLDetailsElement;
    await click(menu.querySelector('a[href="/units"]'));
    await waitFor(() => location.pathname === '/units');

    // Still Korean: the value MainV2 reported survives even though MainV2 has now unmounted.
    expect(host.querySelector('.history-menu > summary')?.textContent).toBe('기록');
    expect(host.querySelector('.history-menu-label')?.textContent).toBe('다른 보기');
  });

  it('on a History page, follows the language of the repo that page shows, not the last Home project', async () => {
    const koElsewhere = { ...fixtureProject, id: 2, language: 'ko' as const };
    history.replaceState(null, '', '/?project=2');
    vi.stubGlobal('fetch', makeFetchMock([{ ...fixtureProject, id: 1 }, koElsewhere]));
    await render(<App />);
    await waitFor(() => host.querySelector('a[href="/"]')?.textContent === '홈');

    const menu = host.querySelector('.history-menu') as HTMLDetailsElement;
    await click(menu.querySelector('a[href="/units"]'));
    // The Units page shows repo 1, an English project.
    await waitFor(() => host.querySelector('.history-menu > summary')?.textContent === 'History');
    expect(host.querySelector('.history-menu-list')?.getAttribute('aria-label')).toBe('Other views');
  });

  it('fetches the project language directly on a cold load of a History page (no Home visit this session)', async () => {
    history.replaceState(null, '', '/timeline');
    vi.stubGlobal('fetch', makeFetchMock([koProject]));
    await render(<App />);

    await waitFor(() => host.querySelector('.history-menu > summary')?.textContent === '기록');
    expect(host.querySelector('a[href="/"]')?.textContent).toBe('홈');
    expect(host.querySelector('.history-menu-label')?.textContent).toBe('다른 보기');
  });

  it('falls back to English if the cold-load language fetch fails', async () => {
    history.replaceState(null, '', '/timeline');
    vi.stubGlobal('fetch', makeFetchMock(new Error('network error')));
    await render(<App />);

    await waitFor(() => host.querySelector('.history-menu') !== null);
    await flush();
    expect(host.querySelector('.history-menu > summary')?.textContent).toBe('History');
    expect(host.querySelector('a[href="/"]')?.textContent).toBe('Home');
  });

  it('leaves an English project unchanged', async () => {
    history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', makeFetchMock([fixtureProject]));
    await render(<App />);
    await waitFor(() => host.querySelector('.setup-form') !== null || host.querySelector('.project-header') !== null);

    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe('Home');
    expect(host.querySelector('.history-menu > summary')?.textContent).toBe('History');
  });
});

describe('styles: History dropdown is not clipped (DIG-46)', () => {
  it('the header that contains the absolutely positioned History menu has no clip-path or overflow clipping', () => {
    // jsdom has no layout, so guard the rule itself: an earlier full-bleed trick
    // (clip-path: inset(0 -100vmax)) clipped the dropdown to the header's height, hiding it.
    // (Vitest stubs CSS imports, even ?raw, so read the file.)
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/(?<=^|})\s*([^{}]*)\{([^}]*)\}/g)]
      .filter((m) => m[1]!.split(',').some((sel) => /^\s*\.(top|nav|history-menu)\s*$/.test(sel)))
      .map((m) => m[2]!);
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) expect(body).not.toMatch(/clip-path|overflow\s*:|contain\s*:/);
  });
});

describe('styles: P4 focus visibility (DIG-60)', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rulesFor = (selector: string) =>
    [...css.matchAll(/(?<=^|})\s*([^{}]*)\{([^}]*)\}/g)]
      .filter((m) => m[1]!.split(',').some((sel) => sel.trim() === selector))
      .map((m) => m[2]!);

  it('.digest-row-main:focus-visible no longer drops the outline, so the global focus ring shows', () => {
    const rules = rulesFor('.digest-row-main:focus-visible');
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) {
      expect(body).not.toMatch(/outline\s*:\s*none/);
      // Hover keeps its background highlight.
      expect(body).toMatch(/background\s*:\s*var\(--hover\)/);
    }
  });

  it('the icon-only triggers (zoom, digest picker, info popover) do not remove their focus-visible outline', () => {
    for (const selector of ['.graph-zoom', '.digest-picker-trigger', '.info-popover > summary']) {
      const own = rulesFor(`${selector}:focus-visible`);
      const global = rulesFor(':focus-visible');
      // Either the selector has no focus-visible override at all (so the global 2px ring
      // applies), or its own override does not cancel the outline.
      expect(global.some((b) => /outline\s*:\s*2px/.test(b))).toBe(true);
      for (const body of own) expect(body).not.toMatch(/outline\s*:\s*none/);
    }
  });
});
