// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFilter, MainV2 } from './MainV2.js';
import {
  fixtureArea, fixtureDigest, fixtureDigestPage, fixtureGraph, fixtureProject, fixtureStatus,
} from './v2Fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeIntersectionObserver {
  observe() { /* no-op: tests drive loading via direct calls, not real scroll */ }
  disconnect() { /* no-op */ }
  unobserve() { /* no-op */ }
}

let root: Root;
let host: HTMLElement;
let projectsResponse: unknown[];
let calls: { url: string; method: string }[];

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const body = ((): unknown => {
      if (url === '/api/projects' && method === 'GET') return projectsResponse;
      if (url === '/api/projects' && method === 'POST') return fixtureProject;
      if (url === `/api/projects/${fixtureProject.id}/status`) return fixtureStatus;
      if (url === `/api/projects/${fixtureProject.id}/context/refresh`) return fixtureProject.context;
      if (url === `/api/projects/${fixtureProject.id}/explain`) return { noChanges: false, digestId: fixtureDigest.id, status: 'ok', budget: fixtureStatus.budget };
      if (url.startsWith(`/api/projects/${fixtureProject.id}/digests`)) return fixtureDigestPage;
      if (url === `/api/digests/${fixtureDigest.id}`) return fixtureDigest;
      if (url.startsWith(`/api/digests/${fixtureDigest.id}/graph`)) return fixtureGraph;
      if (url.startsWith(`/api/digests/${fixtureDigest.id}/areas/`) && method === 'POST') return fixtureArea;
      throw new Error(`unhandled fetch in test: ${method} ${url}`);
    })();
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

beforeEach(() => {
  calls = [];
  projectsResponse = [fixtureProject];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  mockFetch();
  history.replaceState(null, '', '/');
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
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};
const waitFor = async (check: () => boolean, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await flush();
  }
  throw new Error('waitFor: condition never became true');
};
// React tracks the input's value through the native setter to detect real changes; assigning
// `.value` directly leaves onChange from firing, so tests must go through that setter.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('MainV2: setup', () => {
  it('shows the setup form when no project is registered, and surfaces the server 403 message', async () => {
    projectsResponse = [];
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.setup-form') !== null);

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/projects' && (init?.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => [] } as Response;
      return { ok: false, status: 403, json: async () => ({ error: 'that path is outside the allowed roots' }) } as Response;
    }));
    await type(host.querySelector('input') as HTMLInputElement, '/etc');
    await click(host.querySelector('button[type="submit"]'));
    await waitFor(() => host.querySelector('[role="alert"]') !== null);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('outside the allowed roots');
  });
});

describe('MainV2: project bar', () => {
  it('shows the budget meter and the Explain button with the pending count', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.explain-btn') !== null);
    expect(host.textContent).toContain('23 of 40 LLM calls left today');
    expect(host.querySelector('.explain-btn')?.textContent).toContain('12 files, +340 −25 since last check');
  });

  it('disables Explain with a reason when nothing is pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/projects') return { ok: true, status: 200, json: async () => [fixtureProject] } as Response;
      if (url === `/api/projects/${fixtureProject.id}/status`) {
        return { ok: true, status: 200, json: async () => ({ ...fixtureStatus, pending: { files: 0, additions: 0, deletions: 0 } }) } as Response;
      }
      if (url.startsWith(`/api/projects/${fixtureProject.id}/digests`)) return { ok: true, status: 200, json: async () => fixtureDigestPage } as Response;
      if (url === `/api/digests/${fixtureDigest.id}`) return { ok: true, status: 200, json: async () => fixtureDigest } as Response;
      if (url.startsWith(`/api/digests/${fixtureDigest.id}/graph`)) return { ok: true, status: 200, json: async () => fixtureGraph } as Response;
      throw new Error(`unhandled: ${method} ${url}`);
    }));
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.explain-btn') !== null);
    const btn = host.querySelector('.explain-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Nothing pending since last check');
  });
});

describe('MainV2: two-pane digest view', () => {
  it('renders the L0/L1 overview, one row per L2 area, and the project graph', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.area-row') !== null);
    expect(host.textContent).toContain(fixtureDigest.l0!.text);
    expect(host.textContent).toContain(fixtureDigest.l1!.bullets[0]);
    expect(host.querySelectorAll('.area-row')).toHaveLength(fixtureDigest.l2!.items.length);
    await waitFor(() => host.querySelector('.graph-canvas') !== null);
  });

  it('expands a row in place to how/why with a Code (L3) button', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.area-row-main') !== null);
    await click(host.querySelector('.area-row-main'));
    expect(host.textContent).toContain(fixtureDigest.l2!.items[0]!.how);
    expect(host.textContent).toContain(fixtureDigest.l2!.items[0]!.why);
    expect(host.querySelector('.area-detail button')?.textContent).toBe('Code (L3)');
  });

  it('clicking Code (L3) swaps the right pane to the area view; Back to graph restores it', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.area-row-main') !== null);
    await click(host.querySelector('.area-row-main'));
    await click([...host.querySelectorAll('.area-detail button')].find((b) => b.textContent === 'Code (L3)'));
    await waitFor(() => host.querySelector('.area-view') !== null);
    expect(host.querySelector('.graph-canvas')).toBeFalsy();
    expect(location.search).toContain(`area=${fixtureDigest.l2!.items[0]!.id}`);

    await click(host.querySelector('.area-view .back'));
    await waitFor(() => host.querySelector('.graph-canvas') !== null);
    expect(host.querySelector('.area-view')).toBeFalsy();
  });

  it('clicking a path chip filters the list the same way a node click would, with a clearable header', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.chip') !== null);
    const chip = host.querySelector('.chip') as HTMLButtonElement;
    const path = chip.textContent!;
    await click(chip);
    await waitFor(() => host.querySelector('.filter-header') !== null);
    expect(host.querySelector('.filter-header')?.textContent).toContain(path);
    expect(new URLSearchParams(location.search).get('node')).toBe(`f:${path}`);

    await click(host.querySelector('.clear-filter'));
    await waitFor(() => host.querySelector('.filter-header') === null);
  });

  it('clicking a changed graph node filters the change list to that node\'s areas', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.graph-node.changed') !== null);
    await click(host.querySelector('.graph-node.changed'));
    await waitFor(() => host.querySelector('.filter-header') !== null);
    expect(host.querySelectorAll('.area-row').length).toBeLessThanOrEqual(fixtureDigest.l2!.items.length);
  });
});

describe('computeFilter', () => {
  it('prefers the loaded graph node when present', () => {
    const node = fixtureGraph.nodes.find((n) => n.changed)!;
    const f = computeFilter(node.id, fixtureGraph, fixtureDigest);
    expect(f.path).toBe(node.path);
    expect([...f.areaIds]).toEqual(node.areaIds);
  });

  it('falls back to a path-prefix match over the digest when the graph has not loaded', () => {
    const item = fixtureDigest.l2!.items[0]!;
    const f = computeFilter(`f:${item.paths[0]}`, null, fixtureDigest);
    expect(f.areaIds.has(item.id)).toBe(true);
  });
});
