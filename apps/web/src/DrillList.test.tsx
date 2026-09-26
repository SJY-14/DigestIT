// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkUnitSummary } from './api.js';
import { DrillList } from './DrillList.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unit = (over: Partial<WorkUnitSummary> = {}): WorkUnitSummary => ({
  id: 7, repoId: 1, key: 'DIG-7', kind: 'issue', title: 'DIG-7 api server', state: 'active', tipSha: 'a'.repeat(40),
  firstCommitAt: '2026-01-01T00:00:00Z', lastCommitAt: '2026-01-01T01:00:00Z', mergedAt: null,
  latestRangeUnitId: null, commitCount: 2, l0: { status: 'ok', content: { text: 'Serve the read API' } },
  pendingBudget: false, dirty: [], ...over,
});

let calls: string[];
let root: Root;
let host: HTMLElement;
let respond: (url: string) => Promise<unknown>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const body = await respond(url);
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
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
const flush = () => act(async () => undefined);
const noop = () => undefined;

describe('DrillList', () => {
  it('requests the drill endpoint with the query and renders the returned units', async () => {
    respond = async () => ({ workUnits: [unit()] });
    await render(
      <DrillList query={{ area: 'apps/web', day: '2026-01-01' }} via="map" reviews={new Map()} label="l" onSelect={noop} onOpenCommit={noop} />,
    );
    await flush();
    expect(calls[0]).toContain('/api/insights/drill?');
    expect(calls[0]).toContain('area=apps%2Fweb');
    expect(calls[0]).toContain('day=2026-01-01');
    expect(host.textContent).toContain('Serve the read API');
  });

  it('shows an empty state when nothing matches', async () => {
    respond = async () => ({ workUnits: [] });
    await render(<DrillList query={{ day: 'x' }} via="map" reviews={new Map()} label="l" onSelect={noop} onOpenCommit={noop} />);
    await flush();
    expect(host.textContent).toContain('No work units match');
  });

  it('shows an error state when the fetch fails', async () => {
    respond = () => Promise.reject(new Error('boom'));
    await render(<DrillList query={{ day: 'x' }} via="map" reviews={new Map()} label="l" onSelect={noop} onOpenCommit={noop} />);
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('boom');
  });

  it('tags onSelect with the via it was given', async () => {
    respond = async () => ({ workUnits: [unit()] });
    const onSelect = vi.fn();
    await render(<DrillList query={{ day: 'x' }} via="blindspots" reviews={new Map()} label="l" onSelect={onSelect} onOpenCommit={noop} />);
    await flush();
    await act(async () => host.querySelector('.unit-main')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), 'blindspots');
  });
});
