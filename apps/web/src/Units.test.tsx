// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metrics, WorkUnitSummary } from './api.js';
import { MetricsPage } from './MetricsPage.js';
import { NewPill, UnitList, UnitPanel } from './Units.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unit = (over: Partial<WorkUnitSummary> = {}): WorkUnitSummary => ({
  id: 7, repoId: 1, key: 'DIG-7', kind: 'issue', title: 'DIG-7 api server', state: 'active', tipSha: 'a'.repeat(40),
  firstCommitAt: '2026-01-01T00:00:00Z', lastCommitAt: '2026-01-01T01:00:00Z', mergedAt: null,
  latestRangeUnitId: null, commitCount: 2, l0: { status: 'ok', content: { text: 'Serve the read API' } },
  pendingBudget: false, dirty: [], ...over,
});

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let root: Root;
let host: HTMLElement;

function respond(url: string): unknown {
  if (url.startsWith('/api/work-units/DIG-7')) {
    return { ...unit(), members: [{ sha: 'b'.repeat(40), changeId: 3, authorName: 'Ada', committedAt: '2026-01-01T00:30:00Z', title: 'Add route', isMerge: false }], ranges: [], explanation: null };
  }
  if (url === '/api/metrics') {
    return {
      generatedAt: 'x',
      global: { unreadBacklog: 2, undecidedBacklog: 3, medianTimeToOpenSec: 120, medianTimeToDecideSec: null,
        digestVsProduction: { windowDays: 2, landed: 4, decided: 2, ratio: 0.5, perDay: [{ day: '2026-01-01', landed: 3, decided: 1 }, { day: '2026-01-02', landed: 1, decided: 1 }] } },
      units: [{ id: 7, key: 'DIG-7', state: 'active', landedAt: 'x', timeToLandSec: 1, timeToExplainSec: 60, timeToOpenSec: 120, timeToDecideSec: null, decidedBy: null, levelsViewedBeforeDeciding: [0, 3], reopens: 1 }],
    };
  }
  return {};
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => respond(url) } as Response;
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
const click = async (el: Element | null | undefined) => { await act(async () => (el as HTMLElement).click()); };
const noop = () => undefined;

describe('UnitList', () => {
  it('shows state badge, unread badge, budget chip and dirty diffstat', async () => {
    const u = unit({ state: 'handoff', pendingBudget: true, dirty: [{ branch: 'DIG-7-x', files: 4, additions: 120, deletions: 30, untracked: 0, updatedAt: '' }] });
    await render(<UnitList label="l" units={[u]} reviews={new Map([[7, { unread: true, decidedBy: null }]])} selectedId={null} onSelect={noop} onOpenCommit={noop} />);
    const t = host.textContent ?? '';
    expect(t).toContain('Handoff');
    expect(t).toContain('New');
    expect(t).toContain('Serve the read API');
    expect(t).toContain('pending (budget)');
    expect(t).toContain('in progress: 4 files +120 −30');
  });

  it('expands member commits lazily and opens one', async () => {
    const onOpenCommit = vi.fn();
    await render(<UnitList label="l" units={[unit()]} reviews={new Map()} selectedId={null} onSelect={noop} onOpenCommit={onOpenCommit} />);
    expect(calls).toHaveLength(0);
    await click(host.querySelector('.expander'));
    expect(host.querySelector('.expander')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Add route');
    await click(host.querySelector('.member'));
    expect(onOpenCommit).toHaveBeenCalledWith(expect.objectContaining({ changeId: 3 }));
  });

  it('marks the selected unit', async () => {
    await render(<UnitList label="l" units={[unit()]} reviews={new Map()} selectedId={7} onSelect={noop} onOpenCommit={noop} />);
    expect(host.querySelector('.unit-main')?.getAttribute('aria-current')).toBe('true');
  });
});

describe('NewPill', () => {
  it('renders only when there is something new, and reports clicks', async () => {
    const onClick = vi.fn();
    await render(<NewPill count={0} onClick={onClick} />);
    expect(host.querySelector('button')).toBeNull();
    await render(<NewPill count={3} onClick={onClick} />);
    expect(host.querySelector('button')?.textContent).toBe('3 new');
    await click(host.querySelector('button'));
    expect(onClick).toHaveBeenCalled();
  });
});

const posts = () => calls.filter((c) => c.init?.method === 'POST').map((c) => ({ headers: c.init?.headers as Record<string, string>, body: JSON.parse(String(c.init?.body)) as Record<string, unknown> }));

describe('UnitPanel', () => {
  it('sends `opened` and Mark reviewed with the X-DigestIT header', async () => {
    const onEvent = vi.fn();
    await render(<UnitPanel unit={unit({ latestRangeUnitId: 9, pendingBudget: true })} review={{ unread: true, decidedBy: null }} level={0} onLevel={noop} onClose={noop} onEvent={onEvent} />);
    expect(posts()[0]?.body).toEqual({ kind: 'opened', workUnitId: 7 });
    expect(posts()[0]?.headers['x-digestit']).toBe('1');
    expect(host.textContent).toContain('pending (budget)');
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Mark reviewed'));
    const reviewed = posts().find((p) => p.body.kind === 'reviewed');
    expect(reviewed?.body).toEqual({ kind: 'reviewed', workUnitId: 7, changeId: 9 });
    expect(reviewed?.headers).toMatchObject({ 'x-digestit': '1', 'content-type': 'application/json' });
    expect(onEvent).toHaveBeenCalled();
  });

  it('shows a reviewed unit as done and a merged one as decided', async () => {
    await render(<UnitPanel unit={unit()} review={{ unread: false, decidedBy: 'reviewed' }} level={0} onLevel={noop} onClose={noop} onEvent={noop} />);
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Reviewed ✓') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await render(<UnitPanel unit={unit({ id: 8 })} review={{ unread: false, decidedBy: 'merged' }} level={0} onLevel={noop} onClose={noop} onEvent={noop} />);
    expect(host.textContent).toContain('counts as decided');
  });

  it('explains an unexplained unit that is waiting on the budget', async () => {
    await render(<UnitPanel unit={unit({ pendingBudget: true })} level={0} onLevel={noop} onClose={noop} onEvent={noop} />);
    expect(host.textContent).toContain('pending (budget): the daily explanation budget');
  });
});

describe('MetricsPage', () => {
  it('shows backlog tiles, the chart and a table view', async () => {
    await render(<MetricsPage metrics={respond('/api/metrics') as Metrics} error={null} />);
    const t = host.textContent ?? '';
    expect(t).toContain('Unread backlog');
    expect(t).toContain('falling behind');
    expect(t).toContain('2 min');
    expect(host.querySelectorAll('.bar.landed')).toHaveLength(2);
    expect(host.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toContain('per day');
    await click(host.querySelector('.view-toggle'));
    expect(host.querySelector('svg[role="img"]')).toBeNull();
    expect(host.textContent).toContain('2026-01-02');
    expect(host.textContent).toContain('L0 L3');
  });
});
