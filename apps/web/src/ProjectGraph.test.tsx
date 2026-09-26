// @vitest-environment jsdom
import { buildProjectGraph } from '@digestit/core';
import type { ProjectGraphDto } from '@digestit/core';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectGraph, summarize } from './ProjectGraph.js';

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

const render = async (el: ReactElement) => {
  await act(async () => root.render(el));
};
const noop = () => undefined;

const fixture: ProjectGraphDto = {
  digestId: 1,
  ...buildProjectGraph({
    paths: ['src/a.ts', 'src/b.ts', 'src/sub/c.ts', 'docs/readme.md', 'vendor/x.ts', 'vendor/y.ts', 'vendor/z.ts'],
    files: [
      { path: 'src/a.ts', status: 'M', additions: 10, deletions: 2 },
      { path: 'src/sub/c.ts', status: 'A', additions: 40, deletions: 0 },
      { path: 'src/b.ts', status: 'D', additions: 0, deletions: 12 },
    ],
    areas: [{ id: 'area-1', paths: ['src/a.ts'] }],
  }),
};

describe('summarize', () => {
  it('reads "N files changed in M folders" when folders and files both changed', () => {
    expect(summarize(fixture)).toMatch(/^\d+ files? changed in \d+ folders?\. Use the list/);
  });
  it('falls back to a plain files-changed line with no changed folders', () => {
    const flat = { digestId: 1, ...buildProjectGraph({ paths: ['a.ts'], files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0 }] }) };
    expect(summarize(flat)).toBe('1 file changed. Use the list to open each change.');
  });
  it('says nothing changed when there are no changed files', () => {
    const none = { digestId: 1, ...buildProjectGraph({ paths: ['a.ts'], files: [] }) };
    expect(summarize(none)).toBe('No files changed.');
  });
});

describe('ProjectGraph', () => {
  it('zooms on wheel and keeps the page from scrolling', async () => {
    await render(<ProjectGraph graph={fixture} onSelectNode={noop} onExpand={noop} />);
    const svg = host.querySelector('svg')!;
    const before = svg.querySelector('g')!.getAttribute('transform');
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    act(() => { svg.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(svg.querySelector('g')!.getAttribute('transform')).not.toBe(before);
  });

  it('only captures the pointer once a press moves far enough to be a pan, so node clicks still land', async () => {
    const onSelectNode = vi.fn();
    const capture = vi.fn();
    await render(<ProjectGraph graph={fixture} onSelectNode={onSelectNode} onExpand={noop} />);
    const svg = host.querySelector('svg')!;
    (svg as unknown as { setPointerCapture: typeof capture }).setPointerCapture = capture;
    const node = host.querySelector('.graph-node.changed')!;
    const fire = (el: Element, type: string, x: number) =>
      act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 0 })); });
    // A press with a tiny jitter is a click on the node: no capture, the node handler runs.
    fire(node, 'pointerdown', 100);
    fire(node, 'pointermove', 102);
    fire(node, 'pointerup', 102);
    fire(node, 'click', 102);
    expect(capture).not.toHaveBeenCalled();
    expect(onSelectNode).toHaveBeenCalledTimes(1);
    // A real drag starts a pan and captures the pointer.
    fire(svg, 'pointerdown', 100);
    fire(svg, 'pointermove', 140);
    expect(capture).toHaveBeenCalledTimes(1);
    fire(svg, 'pointerup', 140);
  });

  it('is aria-hidden and exposes real button controls, plus a visually hidden summary', async () => {
    await render(<ProjectGraph graph={fixture} onSelectNode={noop} onExpand={noop} />);
    expect(host.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Fit to changes', 'Fit all', 'Zoom out', 'Zoom in']);
    expect(host.querySelector('.visually-hidden')?.textContent).toBe(summarize(fixture));
  });

  it('draws one node per graph node and one edge per graph edge (contains is styled)', async () => {
    await render(<ProjectGraph graph={fixture} onSelectNode={noop} onExpand={noop} />);
    expect(host.querySelectorAll('.graph-node')).toHaveLength(fixture.nodes.length);
    expect(host.querySelectorAll('.graph-edge')).toHaveLength(fixture.edges.length);
  });

  it('ignores edges of an unknown kind instead of drawing them with a default style', async () => {
    const withUnknownEdge: ProjectGraphDto = {
      ...fixture,
      edges: [...fixture.edges, { source: fixture.nodes[0]!.id, target: fixture.nodes[1]!.id, kind: 'imports' as never }],
    };
    await render(<ProjectGraph graph={withUnknownEdge} onSelectNode={noop} onExpand={noop} />);
    expect(host.querySelectorAll('.graph-edge')).toHaveLength(fixture.edges.length);
  });

  it('renders folded folders and groups as box-shaped nodes with a file count', async () => {
    const folded = {
      ...fixture,
      nodes: [...fixture.nodes, {
        id: 'g:vendor', kind: 'group' as const, path: 'vendor', name: '3 files', parentId: fixture.nodes[0]!.id,
        depth: 1, collapsed: true, fileCount: 3, changed: false, changedFiles: 0, additions: 0, deletions: 0, status: null, areaIds: [],
      }],
    };
    await render(<ProjectGraph graph={folded} onSelectNode={noop} onExpand={noop} />);
    const boxes = host.querySelectorAll('.graph-node.shape-box');
    const groupNode = boxes[boxes.length - 1];
    expect(groupNode).toBeTruthy();
    expect(groupNode?.querySelector('.graph-count')?.textContent).toBe('3');
  });

  it('marks deleted files so they get a dashed outline', async () => {
    expect(fixture.nodes.some((n) => n.status === 'D')).toBe(true);
    await render(<ProjectGraph graph={fixture} onSelectNode={noop} onExpand={noop} />);
    expect(host.querySelectorAll('.graph-node.deleted')).toHaveLength(1);
  });

  it('calls onSelectNode when a changed, non-collapsed node is clicked', async () => {
    const onSelectNode = vi.fn();
    await render(<ProjectGraph graph={fixture} onSelectNode={onSelectNode} onExpand={noop} />);
    const changed = fixture.nodes.find((n) => n.changed && !n.collapsed);
    expect(changed).toBeTruthy();
    await act(async () => host.querySelector('.graph-node.changed')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSelectNode).toHaveBeenCalledWith(expect.objectContaining({ id: changed!.id }));
  });

  it('calls onExpand (not onSelectNode) when a folded/group node is clicked', async () => {
    const onSelectNode = vi.fn();
    const onExpand = vi.fn();
    const folded = {
      ...fixture,
      nodes: [...fixture.nodes, {
        id: 'g:vendor', kind: 'group' as const, path: 'vendor', name: '3 files', parentId: fixture.nodes[0]!.id,
        depth: 1, collapsed: true, fileCount: 3, changed: false, changedFiles: 0, additions: 0, deletions: 0, status: null, areaIds: [],
      }],
    };
    await render(<ProjectGraph graph={folded} onSelectNode={onSelectNode} onExpand={onExpand} />);
    const nodes = host.querySelectorAll('.graph-node.shape-box');
    const groupNode = nodes[nodes.length - 1];
    await act(async () => groupNode?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onExpand).toHaveBeenCalledWith('vendor');
    expect(onSelectNode).not.toHaveBeenCalled();
  });

  it('rings highlighted/selected nodes and dims the rest when a highlight set is given', async () => {
    const changed = fixture.nodes.find((n) => n.changed)!;
    await render(<ProjectGraph graph={fixture} highlightNodeIds={new Set([changed.id])} onSelectNode={noop} onExpand={noop} />);
    expect(host.querySelectorAll('.graph-node.dimmed').length).toBe(fixture.nodes.length - 1);
    expect(host.querySelector('.graph-node.ringed')).toBeTruthy();
    expect(host.querySelector('.graph-node.ringed .graph-hilite-ring')).toBeTruthy();
  });

  it('does not dim anything when no highlight set is given', async () => {
    await render(<ProjectGraph graph={fixture} onSelectNode={noop} onExpand={noop} />);
    expect(host.querySelectorAll('.graph-node.dimmed')).toHaveLength(0);
  });
});
