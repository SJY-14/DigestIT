// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metrics, WorkUnitDetail, WorkUnitSummary } from './api.js';
import { App } from './App.js';
import { fixtureAbout, fixtureProject, fixtureProject2 } from './v2Fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unit = (over: Partial<WorkUnitSummary> = {}): WorkUnitSummary => ({
  id: 1, repoId: 1, key: 'DIG-1', kind: 'issue', title: 'DIG-1 in the live list', state: 'active', tipSha: 'a'.repeat(40),
  firstCommitAt: '2026-01-01T00:00:00Z', lastCommitAt: '2026-01-01T01:00:00Z', mergedAt: null,
  latestRangeUnitId: null, commitCount: 1, l0: { status: 'ok', content: { text: 'On the live list' } },
  pendingBudget: false, dirty: [], ...over,
});

// A unit the digest drill returns that is NOT on the live units/digest lists (e.g. it landed and
// was decided outside the last-hour window the removed Units page used to show).
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

/** `/api/metrics`/`/api/insights/drill` back the legacy Insights view; `/api/about`/`/api/projects`
 * back Home. `projects` may be an array (what MainV2 sees) or an `Error` (a failed fetch). */
function makeFetchMock(projects: unknown[] | Error = []) {
  return vi.fn(async (url: string) => {
    const body = ((): unknown => {
      if (url.startsWith('/api/work-units/DIG-99')) return { ...drilledUnit, members: [], ranges: [], explanation: null } satisfies WorkUnitDetail;
      if (url.startsWith('/api/metrics')) return metrics;
      if (url.startsWith('/api/insights/drill')) return { workUnits: [drilledUnit] };
      if (url.startsWith('/api/ui-events')) return {};
      if (url === '/api/about') return fixtureAbout;
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
  it('opens the unit panel for a unit the legacy Insights drill returns', async () => {
    await render(<App />);
    await waitFor(() => host.querySelector('.mark-group') !== null);

    await click(host.querySelector('.mark-group'));
    expect(host.textContent).toContain('Landed on 2026-01-01');
    await waitFor(() => host.querySelector('.unit-main') !== null);

    await click(host.querySelector('.unit-main'));
    await waitFor(() => host.querySelector('.unit-info .key') !== null);

    expect(host.querySelector('.unit-info .key')?.textContent).toBe('DIG-99');
    expect(host.textContent).toContain('Only via drill');
  });
});

describe('App: IA cleanup (UX cycle 2 P1, decision-2.md)', () => {
  it('renders just "Home" in the nav, with no History menu, repo select or Live/Polling badge', async () => {
    history.replaceState(null, '', '/');
    await render(<App />);
    await waitFor(() => host.querySelector('.setup-form') !== null);
    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe('Home');
    expect(host.querySelector('.nav')?.querySelectorAll('a')).toHaveLength(1);
    expect(host.querySelector('.history-menu')).toBeNull();
    expect(host.querySelector('select[aria-label="Repository"]')).toBeNull();
    expect(host.querySelector('.conn')).toBeNull();
  });

  it('/insights stays a working route, reachable with no nav link to it', async () => {
    history.replaceState(null, '', '/insights');
    await render(<App />);
    await waitFor(() => host.querySelector('[role="tablist"]') !== null);
    expect(location.pathname).toBe('/insights');
    expect(host.querySelector('a[href="/insights"]')).toBeNull();
  });

  it.each(['/units', '/timeline', '/briefing'])('redirects %s to Home with history.replace, not a dead page', async (path) => {
    history.replaceState(null, '', path);
    await render(<App />);
    await waitFor(() => host.querySelector('a[aria-current="page"]')?.textContent === 'Home');
    expect(location.pathname).toBe('/');
  });

  it('does not push a new history entry for the redirect, so Back cannot land on the dead route', async () => {
    history.pushState(null, '', '/prior');
    history.pushState(null, '', '/units');
    const lengthBefore = history.length;
    await render(<App />);
    await waitFor(() => location.pathname === '/');
    // `history.replaceState` (used by the redirect) overwrites the current entry instead of
    // adding one — unlike `pushState`, which would leave `/units` one Back away.
    expect(history.length).toBe(lengthBefore);
  });

  it('/metrics still redirects to /insights (an older alias, unrelated to this cut)', async () => {
    history.replaceState(null, '', '/metrics');
    await render(<App />);
    await waitFor(() => location.pathname === '/insights');
  });

  it('resets scroll when navigating Home from a direct link to /insights', async () => {
    history.replaceState(null, '', '/insights');
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    await render(<App />);
    await waitFor(() => host.querySelector('a[href="/"]') !== null);
    await click(host.querySelector('a[href="/"]'));
    await waitFor(() => location.pathname === '/');
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

describe('DIG-60: the nav label follows the project language', () => {
  it('shows the Korean Home label once MainV2 reports a Korean project', async () => {
    history.replaceState(null, '', '/');
    const koProject = { ...fixtureProject, id: 1, language: 'ko' as const };
    vi.stubGlobal('fetch', makeFetchMock([koProject]));
    await render(<App />);
    await waitFor(() => host.querySelector('a[href="/"]')?.textContent === '홈');
  });

  it('leaves an English project unchanged', async () => {
    history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', makeFetchMock([fixtureProject]));
    await render(<App />);
    await waitFor(() => host.querySelector('.setup-form') !== null || host.querySelector('.project-header') !== null);
    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe('Home');
  });
});

describe('App: All-projects nav + route (UX cycle 2 P7, decision-2.md §2)', () => {
  it('hides the "All projects" link with fewer than 2 projects', async () => {
    history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', makeFetchMock([fixtureProject]));
    await render(<App />);
    await waitFor(() => host.querySelector('.project-header') !== null);
    expect([...host.querySelectorAll('.nav a')].map((a) => a.textContent)).toEqual(['Home']);
  });

  it('shows the link once 2+ projects are registered, and it opens /projects', async () => {
    history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', makeFetchMock([fixtureProject, fixtureProject2]));
    await render(<App />);
    await waitFor(() => [...host.querySelectorAll('.nav a')].some((a) => a.textContent === 'All projects'));

    await click(host.querySelector('a[href="/projects"]'));
    await waitFor(() => location.pathname === '/projects');
    await waitFor(() => host.querySelectorAll('.proj-row').length === 2);
    const names = [...host.querySelectorAll('.proj-name')].map((n) => n.textContent).sort();
    expect(names).toEqual([fixtureProject.name, fixtureProject2.name].sort());
    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe('All projects');
  });

  it('is reachable as a direct deep link', async () => {
    history.replaceState(null, '', '/projects');
    vi.stubGlobal('fetch', makeFetchMock([fixtureProject, fixtureProject2]));
    await render(<App />);
    await waitFor(() => host.querySelectorAll('.proj-row').length === 2);
    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe('All projects');
  });

  it('opens a project row back on Home, at that project\'s newest digest', async () => {
    history.replaceState(null, '', '/projects');
    vi.stubGlobal('fetch', makeFetchMock([fixtureProject, fixtureProject2]));
    await render(<App />);
    await waitFor(() => host.querySelectorAll('.proj-row').length === 2);

    await click(host.querySelector(`.proj-row-main[data-project-id="${fixtureProject.id}"]`));
    await waitFor(() => location.pathname === '/');
    const params = new URLSearchParams(location.search);
    expect(params.get('project')).toBe(String(fixtureProject.id));
    expect(params.get('digest')).toBe(String(fixtureProject.latestDigest!.id));
  });

  it('opens a never-explained project at first run (no digest param)', async () => {
    history.replaceState(null, '', '/projects');
    vi.stubGlobal('fetch', makeFetchMock([fixtureProject, fixtureProject2]));
    await render(<App />);
    await waitFor(() => host.querySelectorAll('.proj-row').length === 2);

    await click(host.querySelector(`.proj-row-main[data-project-id="${fixtureProject2.id}"]`));
    await waitFor(() => location.pathname === '/');
    const params = new URLSearchParams(location.search);
    expect(params.get('project')).toBe(String(fixtureProject2.id));
    expect(params.has('digest')).toBe(false);
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
