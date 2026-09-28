// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFilter, defaultProject, MainV2, nodeTarget } from './MainV2.js';
import { humanDateTime, plural } from './copy.js';
import {
  fixtureArea, fixtureDigest, fixtureDigestPage, fixtureGraph, fixtureProject, fixtureProject2, fixtureStatus, fixtureStatus2,
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
      // A second, just-registered project with no digests (DIG-57: project switching).
      if (url === `/api/projects/${fixtureProject2.id}/status`) return fixtureStatus2;
      if (url.startsWith(`/api/projects/${fixtureProject2.id}/digests`)) return { items: [], nextCursor: null };
      if (url.startsWith(`/api/digests/${fixtureDigest.id}/areas/`) && (method === 'GET' || method === 'POST')) return fixtureArea;
      if (/^\/api\/digests\/\d+\/graph/.test(url) && method === 'GET') return fixtureGraph;
      const explainMatch = /^\/api\/digests\/(\d+)\/explain$/.exec(url);
      if (explainMatch && method === 'POST') {
        const id = Number(explainMatch[1]);
        const summary = fixtureDigestPage.items.find((d) => d.id === id);
        return { ...fixtureDigest, ...summary, id, status: 'ok' };
      }
      const digestMatch = /^\/api\/digests\/(\d+)$/.exec(url);
      if (digestMatch && method === 'GET') {
        const id = Number(digestMatch[1]);
        const summary = fixtureDigestPage.items.find((d) => d.id === id);
        return { ...fixtureDigest, ...summary, id };
      }
      throw new Error(`unhandled fetch in test: ${method} ${url}`);
    })();
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

beforeEach(() => {
  localStorage.clear();
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
    expect(host.textContent).toContain('23 calls left today');
    expect(host.querySelector('.explain-btn')?.textContent).toContain('Explain 12 changes');
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
    expect(btn.textContent).toBe('No new changes');
    expect(btn.title).toBe('Nothing has changed since the last check.');
  });
});

const params = () => new URLSearchParams(location.search);
const pressKey = async (key: string, target: EventTarget = document.body) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
};
const selectedTab = () => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const ready = () => waitFor(() => host.querySelector('.l0-headline') !== null || host.querySelector('.level-view') !== null);

const select = async (el: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('MainV2: switching projects (DIG-57)', () => {
  beforeEach(() => { projectsResponse = [fixtureProject, fixtureProject2]; });

  it('resets the digest, level, area and graph, and clears the URL, when the project switches', async () => {
    await render(<MainV2 />);
    await ready();
    // Drill into project 1: L2, a graph node loaded.
    await pressKey('2');
    expect(selectedTab()).toBe('L2 Structure');
    expect(params().get('level')).toBe('2');
    await waitFor(() => host.querySelector('.graph-canvas') !== null);
    expect(host.textContent).toContain(fixtureDigest.l0!.text);

    await select(host.querySelector('.project-switcher') as HTMLSelectElement, String(fixtureProject2.id));
    await waitFor(() => params().get('project') === String(fixtureProject2.id));

    // URL: only `project` survives; digest/level/area/step/node are all gone.
    expect(params().get('digest')).toBeNull();
    expect(params().get('level')).toBeNull();
    expect(params().get('area')).toBeNull();
    expect(params().get('step')).toBeNull();
    expect(params().get('node')).toBeNull();

    // Nothing from project 1 stays on screen: no old digest content, no stale graph.
    expect(host.textContent).not.toContain(fixtureDigest.l0!.text);
    await waitFor(() => host.querySelector('.explain-btn')?.textContent === `Explain ${plural(fixtureStatus2.pending.files, 'change')}`);
    expect(host.querySelector('.graph-canvas')).toBeNull();
    expect(host.querySelector('.l0-headline')).toBeNull();
  });

  it('shows a project-specific first-run state for a project with no digests yet', async () => {
    await render(<MainV2 />);
    await ready();
    await select(host.querySelector('.project-switcher') as HTMLSelectElement, String(fixtureProject2.id));
    await waitFor(() => host.querySelector('.empty-state') !== null);
    expect(host.querySelector('.empty-state .box-head')?.textContent).toBe(`No explanations yet for ${fixtureProject2.name}`);
    expect(host.querySelector('.empty-state p')?.textContent).toBe(
      `${plural(fixtureStatus2.pending.files, 'file')} changed since you registered it. Press Explain above to see what happened.`,
    );
  });
});

describe('MainV2: reading flow', () => {
  it('opens a digest at L0: the headline, a stats line, the breadcrumb, the switcher and the graph', async () => {
    await render(<MainV2 />);
    await ready();
    expect(host.querySelector('.l0-headline')?.textContent).toBe(fixtureDigest.l0!.text);
    expect(host.querySelector('.l0-stats')?.textContent).toContain('12 files · +340 −25');
    expect(selectedTab()).toBe('L0 Summary');
    const pane = host.querySelector('#reading-pane')!;
    expect(pane.getAttribute('role')).toBe('tabpanel');
    expect(pane.getAttribute('aria-labelledby')).toBe('level-tab-0');
    expect([...host.querySelectorAll('.breadcrumb button')].map((b) => b.textContent)).toEqual([expect.stringMatching(/^Digest · /), 'L0 Summary']);
    await waitFor(() => host.querySelector('.graph-canvas') !== null);
  });

  it('keys 0–3 switch level and write it to the URL; they are ignored while typing', async () => {
    await render(<MainV2 />);
    await ready();
    await pressKey('1');
    expect(selectedTab()).toBe('L1 Impact');
    expect(host.querySelector('.l1-bullets')?.textContent).toContain(fixtureDigest.l1!.bullets[0]);
    expect(params().get('level')).toBe('1');
    await pressKey('2');
    expect(host.querySelectorAll('.area-card')).toHaveLength(2);
    await pressKey('3');
    expect(host.querySelector('.area-picker')).toBeTruthy();
    expect(params().get('level')).toBe('3');
    await pressKey('0');
    expect(host.querySelector('.l0-headline')).toBeTruthy();
    expect(params().get('level')).toBeNull();

    const input = document.createElement('input');
    host.append(input);
    await pressKey('2', input);
    expect(selectedTab()).toBe('L0 Summary');
  });

  it('clicking a tab switches level', async () => {
    await render(<MainV2 />);
    await ready();
    await click(host.querySelector('#level-tab-2'));
    expect(selectedTab()).toBe('L2 Structure');
    expect(host.querySelector('#reading-pane')?.getAttribute('aria-labelledby')).toBe('level-tab-2');
  });

  it('an L2 card opens that area at L3; the breadcrumb then reads digest › area › L3', async () => {
    await render(<MainV2 />);
    await ready();
    await pressKey('2');
    await click(host.querySelector('.area-card-title button'));
    await waitFor(() => host.querySelector('.walkthrough') !== null);
    expect(params().get('level')).toBe('3');
    expect(params().get('area')).toBe('graph-pane');
    expect([...host.querySelectorAll('.breadcrumb button')].map((b) => b.textContent)).toEqual([
      expect.stringMatching(/^Digest · /), fixtureDigest.l2!.items[0]!.title, 'L3 Code',
    ]);
    // The digest crumb goes back to L0 and drops the area.
    await click(host.querySelector('.breadcrumb button'));
    expect(host.querySelector('.l0-headline')).toBeTruthy();
    expect(params().get('area')).toBeNull();
  });

  it('n / p step through the walkthrough, and the step is in the URL', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    history.replaceState(null, '', `/?project=1&digest=${fixtureDigest.id}&level=3&area=graph-pane`);
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('section.step') !== null);
    // At the overview, p has nowhere earlier to go.
    await pressKey('p');
    expect(params().get('step')).toBeNull();
    await pressKey('n');
    expect(params().get('step')).toBe('1');
    await pressKey('n');
    await pressKey('n');
    expect(params().get('step')).toBe('3');
    expect(host.querySelector('#step-3')?.classList.contains('current')).toBe(true);
    await pressKey('p');
    expect(params().get('step')).toBe('2');
    // Clamped at both ends.
    for (let i = 0; i < 6; i++) await pressKey('n');
    expect(params().get('step')).toBe('4');
    await click(host.querySelector('.step-toc button'));
    expect(params().get('step')).toBe('1');
    await pressKey('p');
    expect(params().get('step')).toBe('1');
  });

  it('restores digest, level, area and step from the URL on load, and follows back/forward', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    history.replaceState(null, '', `/?project=1&digest=${fixtureDigest.id}&level=3&area=graph-pane&step=2`);
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('#step-2.current') !== null);
    expect(selectedTab()).toBe('L3 Code');
    expect(host.querySelector('.step-toc [aria-current="step"]')?.textContent).toContain('Fit to changes on every new digest');

    await pressKey('1');
    expect(selectedTab()).toBe('L1 Impact');
    await act(async () => {
      history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => selectedTab() === 'L3 Code');
    await waitFor(() => host.querySelector('#step-2.current') !== null);
  });

  it('L3 with no area shows the area picker; picking one opens its walkthrough', async () => {
    history.replaceState(null, '', `/?project=1&digest=${fixtureDigest.id}&level=3`);
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.area-picker') !== null);
    await click(host.querySelector('.area-pick'));
    await waitFor(() => host.querySelector('.walkthrough') !== null);
    expect(params().get('area')).toBe('graph-pane');
  });

  it('a graph node in one area opens it at L3; a node touching several opens L2 filtered to it', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.graph-node.changed') !== null);
    const single = fixtureGraph.nodes.find((n) => n.changed && !n.collapsed && n.areaIds.length === 1)!;
    const multi = fixtureGraph.nodes.find((n) => n.changed && !n.collapsed && n.areaIds.length > 1)!;
    const nodeEl = (id: string) => [...host.querySelectorAll('.graph-node')].find((g) => g.getAttribute('aria-label')?.startsWith(fixtureGraph.nodes.find((n) => n.id === id)!.path));
    await click(nodeEl(single.id));
    await waitFor(() => host.querySelector('.walkthrough') !== null || host.querySelector('.level-view') !== null);
    expect(params().get('level')).toBe('3');
    expect(params().get('area')).toBe(single.areaIds[0]);

    await click(nodeEl(multi.id));
    expect(params().get('level')).toBe('2');
    expect(params().get('node')).toBe(multi.id);
    await waitFor(() => host.querySelector('.filter-header') !== null);
    expect(host.querySelectorAll('.area-card')).toHaveLength(multi.areaIds.length);
  });

  it('outlines the selected area\'s nodes in the graph at L2/L3', async () => {
    history.replaceState(null, '', `/?project=1&digest=${fixtureDigest.id}&level=3&area=area-view`);
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.graph-node.ringed') !== null);
    const ringed = [...host.querySelectorAll('.graph-node.ringed')];
    const expected = fixtureGraph.nodes.filter((n) => n.areaIds.includes('area-view'));
    expect(ringed).toHaveLength(expected.length);
  });

  it('never announces "Showing all areas" on first load, only when a filter is cleared', async () => {
    const multi = fixtureGraph.nodes.find((n) => n.changed && n.areaIds.length > 1)!;
    history.replaceState(null, '', `/?project=1&digest=${fixtureDigest.id}&level=2`);
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.area-card') !== null);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).not.toBe('Showing all areas');
    await act(async () => {
      history.pushState(null, '', `/?project=1&digest=${fixtureDigest.id}&level=2&node=${encodeURIComponent(multi.id)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => host.querySelector('.filter-header') !== null);
    await click(host.querySelector('.clear-filter'));
    await waitFor(() => host.querySelector('[aria-live="polite"]')?.textContent === 'Showing all areas');
  });

  it('picking another digest keeps the level but drops the area and step', async () => {
    history.replaceState(null, '', `/?project=1&digest=${fixtureDigest.id}&level=3&area=graph-pane&step=2`);
    Element.prototype.scrollIntoView = vi.fn();
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.walkthrough') !== null);
    const other = fixtureDigestPage.items.find((d) => d.id !== fixtureDigest.id)!;
    await click(host.querySelector('.digest-picker-trigger'));
    await click([...host.querySelectorAll('.digest-row-main')].find((b) => b.textContent?.includes(other.l0?.text ?? `#${other.seq}`)));
    await waitFor(() => params().get('digest') === String(other.id));
    expect(params().get('level')).toBe('3');
    expect(params().get('area')).toBeNull();
    expect(params().get('step')).toBeNull();
    await waitFor(() => host.querySelector('.area-picker') !== null);
  });

  it('shows a Try again notice on an errored digest', async () => {
    const errored = fixtureDigestPage.items.find((d) => d.status === 'error')!;
    history.replaceState(null, '', `/?project=1&digest=${errored.id}`);
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('#reading-pane .notice.error') !== null);
    await click(host.querySelector('#reading-pane .notice.error button'));
    await waitFor(() => calls.some((c) => c.url === `/api/digests/${errored.id}/explain` && c.method === 'POST'));
  });
});

describe('nodeTarget', () => {
  it('follows docs/ux-v3.md §1', () => {
    expect(nodeTarget({ id: 'f:a.ts', areaIds: ['x'] })).toEqual({ level: 3, area: 'x', step: null, node: null });
    expect(nodeTarget({ id: 'd:src', areaIds: ['x', 'y'] })).toEqual({ level: 2, node: 'd:src', step: null });
    expect(nodeTarget({ id: 'f:b.ts', areaIds: [] })).toEqual({ level: 2, node: 'f:b.ts', step: null });
  });
});

describe('MainV2: resizable divider', () => {
  it('moves the reading pane\'s width with the arrow keys, and Home/End jump to the ends', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.split-divider') !== null);
    const divider = host.querySelector('.split-divider') as HTMLElement;
    const pane = host.querySelector('#reading-pane') as HTMLElement;
    expect(pane.style.flexBasis).toBe('60%');
    await act(async () => divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(pane.style.flexBasis).toBe('62%');
    await act(async () => divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(pane.style.flexBasis).toBe('60%');
    await act(async () => divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(pane.style.flexBasis).toBe('75%');
    await act(async () => divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(pane.style.flexBasis).toBe('35%');
  });
});

describe('MainV2: empty and error states', () => {
  it('shows an empty state pointing at Explain when a project has no digests yet, instead of loading forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/projects') return { ok: true, status: 200, json: async () => [fixtureProject] } as Response;
      if (url === `/api/projects/${fixtureProject.id}/status`) return { ok: true, status: 200, json: async () => fixtureStatus } as Response;
      if (url.startsWith(`/api/projects/${fixtureProject.id}/digests`)) {
        return { ok: true, status: 200, json: async () => ({ items: [], nextCursor: null }) } as Response;
      }
      throw new Error(`unhandled: ${method} ${url}`);
    }));
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.empty-state') !== null);
    expect(host.querySelector('.empty-state')?.textContent).toContain('Press Explain');
    expect(host.querySelector('.digest-picker')).toBeNull();
    expect(host.textContent).not.toContain('Loading digest…');
  });

  it('shows the status error instead of "Loading context…" forever when /status fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/projects') return { ok: true, status: 200, json: async () => [fixtureProject] } as Response;
      if (url === `/api/projects/${fixtureProject.id}/status`) {
        return { ok: false, status: 500, json: async () => ({ error: 'db is down' }) } as Response;
      }
      throw new Error(`unhandled: ${method} ${url}`);
    }));
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.error')?.textContent?.includes('db is down') ?? false);
    expect(host.textContent).not.toContain('Loading context…');
  });

  it('shows a short notice pointing to History when /api/projects 404s (DIG-39 not landed yet)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response)));
    await render(<MainV2 />);
    await waitFor(() => host.textContent?.includes('History') ?? false);
    expect(host.textContent).toContain("doesn't have the v2 project API yet");
  });
});

describe('MainV2: digest retry', () => {
  it('POSTs /api/digests/:id/explain and disables Retry once the budget is 0', async () => {
    const zeroBudgetStatus = { ...fixtureStatus, budget: { ...fixtureStatus.budget, remaining: 0 } };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/projects') return { ok: true, status: 200, json: async () => [fixtureProject] } as Response;
      if (url === `/api/projects/${fixtureProject.id}/status`) return { ok: true, status: 200, json: async () => zeroBudgetStatus } as Response;
      if (url.startsWith(`/api/projects/${fixtureProject.id}/digests`)) return { ok: true, status: 200, json: async () => fixtureDigestPage } as Response;
      if (/^\/api\/digests\/\d+$/.test(url)) return { ok: true, status: 200, json: async () => fixtureDigest } as Response;
      if (/^\/api\/digests\/\d+\/graph/.test(url)) return { ok: true, status: 200, json: async () => fixtureGraph } as Response;
      throw new Error(`unhandled: ${method} ${url}`);
    }));
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.digest-picker-trigger') !== null);
    await click(host.querySelector('.digest-picker-trigger'));
    const retryBtn = [...host.querySelectorAll('.retry')][0] as HTMLButtonElement;
    expect(retryBtn.disabled).toBe(true);
    expect(retryBtn.textContent).toBe('No calls left today');
  });

  it('retries an errored digest via a real POST, not just a re-select', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.digest-picker-trigger') !== null);
    await click(host.querySelector('.digest-picker-trigger'));
    const errored = fixtureDigestPage.items.find((d) => d.status === 'error')!;
    const row = [...host.querySelectorAll('.digest-row')].find((r) => r.textContent?.includes(`#${errored.seq}`) || r.querySelector('.retry'));
    const retryBtn = row?.querySelector('.retry') as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();
    await click(retryBtn);
    await waitFor(() => calls.some((c) => c.url === `/api/digests/${errored.id}/explain` && c.method === 'POST'));
  });
});

describe('MainV2: digest picker (DIG-49)', () => {
  it('opens as an overlay with one readable row per digest; Escape closes it and focus returns to the trigger', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.digest-picker-trigger') !== null);
    const trigger = host.querySelector('.digest-picker-trigger') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.digest-picker-panel')).toBeNull();
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const labels = [...host.querySelectorAll('.digest-row-label')].map((e) => e.textContent);
    expect(labels).toHaveLength(fixtureDigestPage.items.length);
    for (const [i, d] of fixtureDigestPage.items.entries()) {
      expect(labels[i]).toBe(`${humanDateTime(d.toAt)} · ${plural(d.stats.files, 'file')} · ${d.l0?.text ?? 'Not explained yet'}`);
    }
    expect(host.querySelector('.digest-status.error')?.textContent).toBe('Explain failed');
    // Focus starts on the current digest's row.
    expect(document.activeElement?.getAttribute('aria-current')).toBe('true');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(host.querySelector('.digest-picker-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click', async () => {
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.digest-picker-trigger') !== null);
    await click(host.querySelector('.digest-picker-trigger'));
    expect(host.querySelector('.digest-picker-panel')).toBeTruthy();
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(host.querySelector('.digest-picker-panel')).toBeNull();
  });
});

describe('MainV2: Explain (DIG-49)', () => {
  /** The default mock, with the project Explain POST answered by `reply`. */
  function explainReplies(reply: { status: number; body: unknown }) {
    const base = fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/api/projects/${fixtureProject.id}/explain` && init?.method === 'POST') {
        calls.push({ url, method: 'POST' });
        return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as Response;
      }
      return base(url, init);
    }));
  }
  const pressExplain = async () => {
    await waitFor(() => host.querySelector('.explain-btn.primary') !== null);
    await click(host.querySelector('.explain-btn'));
  };

  it('lands on the new digest at L0', async () => {
    const other = fixtureDigestPage.items.find((d) => d.id !== fixtureDigest.id)!;
    explainReplies({ status: 200, body: { noChanges: false, digestId: other.id, status: 'ok', budget: fixtureStatus.budget } });
    history.replaceState(null, '', `/?project=1&digest=${fixtureDigest.id}&level=2`);
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.area-card') !== null);
    await pressExplain();
    await waitFor(() => params().get('digest') === String(other.id));
    expect(params().get('level')).toBeNull();
    await waitFor(() => host.querySelector('.l0-headline') !== null);
    expect(selectedTab()).toBe('L0 Summary');
  });

  it('says what failed and what to do', async () => {
    explainReplies({ status: 500, body: { error: 'no_provider' } });
    await render(<MainV2 />);
    await pressExplain();
    await waitFor(() => host.querySelector('.notice.error') !== null);
    expect(host.querySelector('.notice.error')?.textContent)
      .toBe('Explain failed. No explanation provider is configured on this server. Try again, or check the server log if it keeps failing.');
  });

  it('says so when there was nothing to explain', async () => {
    explainReplies({ status: 200, body: { noChanges: true, digestId: null, status: null, budget: fixtureStatus.budget } });
    await render(<MainV2 />);
    await pressExplain();
    await waitFor(() => host.querySelector('.notice[role="status"]') !== null);
    expect(host.querySelector('.notice[role="status"]')?.textContent).toContain('Nothing changed since the last check.');
  });

  it('lands on the digest and says the budget ran out when it could not be explained', async () => {
    const other = fixtureDigestPage.items.find((d) => d.id !== fixtureDigest.id)!;
    explainReplies({ status: 200, body: { noChanges: false, digestId: other.id, status: 'pending', budget: { ...fixtureStatus.budget, remaining: 0 } } });
    await render(<MainV2 />);
    await pressExplain();
    await waitFor(() => params().get('digest') === String(other.id));
    expect(host.querySelector('.reader-top .notice[role="status"]')?.textContent).toContain('The daily budget ran out');
  });
});

describe('MainV2: default project (DIG-46)', () => {
  const older = { ...fixtureProject, id: 5, name: 'old-empty', lastCheckpointAt: '2026-09-01T00:00:00Z', digestCount: 0 };

  it('opens the project that has digests, not the oldest registered one, when the URL names none', async () => {
    projectsResponse = [older, fixtureProject];
    await render(<MainV2 />);
    await waitFor(() => host.querySelector('.l0-headline') !== null);
    expect(new URLSearchParams(location.search).get('project')).toBe(String(fixtureProject.id));
    expect(calls.some((c) => c.url.startsWith(`/api/projects/${older.id}/`))).toBe(false);
    expect(localStorage.getItem('digestit.lastProject')).toBe(String(fixtureProject.id));
  });

  it('defaultProject prefers the last used project, then the most recently checked one with digests', () => {
    const a = { ...fixtureProject, id: 1, lastCheckpointAt: '2026-09-20T00:00:00Z', digestCount: 2 };
    const b = { ...fixtureProject, id: 2, lastCheckpointAt: '2026-09-25T00:00:00Z', digestCount: 1 };
    const c = { ...fixtureProject, id: 3, lastCheckpointAt: '2026-09-26T00:00:00Z', digestCount: 0 };
    expect(defaultProject([a, b, c], 1)?.id).toBe(1);
    expect(defaultProject([a, b, c], null)?.id).toBe(2);
    expect(defaultProject([a, b, c], 99)?.id).toBe(2);
    expect(defaultProject([c], null)?.id).toBe(3);
    expect(defaultProject([], null)).toBeNull();
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
