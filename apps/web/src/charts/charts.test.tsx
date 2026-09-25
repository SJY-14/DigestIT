// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BarSeries } from './BarSeries.js';
import { DotStrip } from './DotStrip.js';
import { GridHeatmap } from './GridHeatmap.js';
import { LineSeries } from './LineSeries.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (el: ReactElement) => { await act(async () => root.render(el)); };
// SVG elements (the marks) have no native .click(); dispatch a real event, as the app does for keydown.
const click = async (el: Element | null | undefined) => {
  await act(async () => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};
const key = async (el: Element | null | undefined, k: string) => {
  await act(async () => el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
};

describe('BarSeries', () => {
  const categories = ['Mon', 'Tue', 'Wed'];
  const series = [
    { key: 'landed', label: 'Landed', className: 'series-1', values: [3, 1, 2] },
    { key: 'decided', label: 'Decided', className: 'series-2', values: [1, 1, 2] },
  ];

  it('renders a mark per category per series with a title and a role=img svg', async () => {
    await render(<BarSeries categories={categories} series={series} ariaLabel="Units per day" />);
    expect(host.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('Units per day');
    expect(host.querySelectorAll('.bar.series-1')).toHaveLength(3);
    expect(host.querySelectorAll('.bar.series-2')).toHaveLength(3);
    expect(host.querySelectorAll('.bar title')).toHaveLength(6);
    expect(host.textContent).toContain('Landed');
    expect(host.textContent).toContain('Decided');
  });

  it('roves focus with the arrow keys and drills on Enter', async () => {
    const onDrill = vi.fn();
    await render(<BarSeries categories={categories} series={series} ariaLabel="a" onDrill={onDrill} />);
    const groups = () => [...host.querySelectorAll('.mark-group')];
    expect(groups()[0]?.getAttribute('tabindex')).toBe('0');
    expect(groups()[1]?.getAttribute('tabindex')).toBe('-1');
    await key(groups()[0], 'ArrowRight');
    expect(groups()[1]?.getAttribute('tabindex')).toBe('0');
    expect(groups()[0]?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(groups()[1]);
    await key(groups()[1], 'Enter');
    expect(onDrill).toHaveBeenCalledWith('Tue');
    await key(groups()[1], 'ArrowLeft');
    await key(groups()[0], 'Home');
    expect(groups()[0]?.getAttribute('tabindex')).toBe('0');
  });

  it('drills on click and toggles the table view', async () => {
    const onDrill = vi.fn();
    await render(<BarSeries categories={categories} series={series} ariaLabel="a" onDrill={onDrill} />);
    await click(host.querySelector('.mark-group'));
    expect(onDrill).toHaveBeenCalledWith('Mon');
    await click(host.querySelector('.view-toggle'));
    expect(host.querySelector('svg')).toBeNull();
    const table = host.querySelector('table.data');
    expect(table?.textContent).toContain('Mon');
    expect(table?.textContent).toContain('3');
  });

  it('stacks bar heights instead of grouping them side by side', async () => {
    await render(<BarSeries categories={categories} series={series} mode="stacked" ariaLabel="a" />);
    expect(host.querySelectorAll('.bar.series-1')).toHaveLength(3);
  });
});

describe('LineSeries', () => {
  const categories = ['Mon', 'Tue', 'Wed'];
  const series = [{ key: 'backlog', label: 'Backlog', className: 'series-1', values: [4, 2, 6] }];

  it('renders one polyline and one dot per point', async () => {
    await render(<LineSeries categories={categories} series={series} ariaLabel="Backlog trend" />);
    expect(host.querySelectorAll('polyline.line.series-1')).toHaveLength(1);
    expect(host.querySelectorAll('circle.dot')).toHaveLength(3);
  });

  it('drills the activated point on Enter', async () => {
    const onDrill = vi.fn();
    await render(<LineSeries categories={categories} series={series} ariaLabel="a" onDrill={onDrill} />);
    const groups = [...host.querySelectorAll('.mark-group')];
    await key(groups[0], 'ArrowRight');
    await key(groups[1], 'ArrowRight');
    await key(groups[2], 'Enter');
    expect(onDrill).toHaveBeenCalledWith('Wed');
  });
});

describe('GridHeatmap', () => {
  const rows = ['apps/web', 'apps/server'];
  const columns = ['2026-01-01', '2026-01-02', '2026-01-03'];
  const values = [
    [0, 4, 8],
    [2, 0, 1],
  ];

  it('renders one cell per row per column, bucketed into heat steps', async () => {
    await render(<GridHeatmap rows={rows} columns={columns} values={values} ariaLabel="Change map" />);
    const cells = host.querySelectorAll('.cell');
    expect(cells).toHaveLength(6);
    expect(host.querySelector('.cell.heat-0')).not.toBeNull();
    expect(host.querySelector('.cell.heat-4')).not.toBeNull();
  });

  it('moves the focused cell on all four arrows and drills on Enter', async () => {
    const onDrill = vi.fn();
    await render(<GridHeatmap rows={rows} columns={columns} values={values} ariaLabel="a" onDrill={onDrill} />);
    const cell = (i: number) => host.querySelectorAll('.cell')[i];
    expect(cell(0)?.getAttribute('tabindex')).toBe('0');
    await key(cell(0), 'ArrowRight');
    expect(cell(1)?.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(cell(1));
    await key(cell(1), 'ArrowDown');
    expect(cell(4)?.getAttribute('tabindex')).toBe('0');
    await key(cell(4), 'Enter');
    expect(onDrill).toHaveBeenCalledWith('apps/server', '2026-01-02');
  });

  it('shows the same values in the table view', async () => {
    await render(<GridHeatmap rows={rows} columns={columns} values={values} ariaLabel="a" />);
    await click(host.querySelector('.view-toggle'));
    expect(host.querySelector('table.data')?.textContent).toContain('apps/server');
  });
});

describe('DotStrip', () => {
  const groups = [
    { key: 'W1', values: [10, 20, 30] },
    { key: 'W2', values: [5] },
  ];

  it('renders a dot per value and a median tick per non-empty group', async () => {
    await render(<DotStrip groups={groups} ariaLabel="Time to open" />);
    expect(host.querySelectorAll('circle.dot')).toHaveLength(4);
    expect(host.querySelectorAll('line.median-tick')).toHaveLength(2);
  });

  it('drills the focused group on Enter', async () => {
    const onDrill = vi.fn();
    await render(<DotStrip groups={groups} ariaLabel="a" onDrill={onDrill} />);
    const first = host.querySelector('.mark-group');
    await key(first, 'Enter');
    expect(onDrill).toHaveBeenCalledWith('W1');
  });
});
