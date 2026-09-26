// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AreaDetailDto } from '@digestit/core';
import { AreaView } from './AreaView.js';
import { fixtureArea } from './v2Fixtures.js';

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
const click = async (el: Element | null | undefined) => {
  await act(async () => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};
const noop = () => undefined;

function longHunkArea(): AreaDetailDto {
  const lines = ['@@ -1,40 +1,40 @@'];
  for (let i = 1; i <= 40; i++) lines.push(i === 20 ? ' key line' : ' filler');
  return {
    ...fixtureArea,
    l3: { ...fixtureArea.l3!, notes: [{ path: 'apps/web/src/ProjectGraph.tsx', side: 'new', startLine: 20, endLine: 20, note: 'the important bit' }] },
    files: [{ ...fixtureArea.files[0]!, patch: lines.join('\n') }],
  };
}

describe('AreaView', () => {
  it('renders why/design/risks and calls onBack', async () => {
    const onBack = vi.fn();
    await render(<AreaView area={fixtureArea} title="Project graph pane" onBack={onBack} />);
    expect(host.textContent).toContain(fixtureArea.l3!.why);
    expect(host.textContent).toContain(fixtureArea.l3!.design);
    expect(host.textContent).toContain(fixtureArea.l3!.risks[0]);
    await click(host.querySelector('.back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows an error note when the area failed to generate', async () => {
    await render(<AreaView area={{ ...fixtureArea, status: 'error', l3: null }} title="x" onBack={noop} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not generate');
  });

  it('folds a long hunk to +/- 3 lines around the annotated line, with an Expand control on each side', async () => {
    await render(<AreaView area={longHunkArea()} title="x" onBack={noop} />);
    // Visible: header + lines 17..23 (key line 20 +/- 3) = 7 content rows, folded before and after.
    expect(host.querySelectorAll('.dl').length).toBe(1 + 7);
    expect(host.querySelectorAll('.fold-expand')).toHaveLength(2);
    expect(host.textContent).toContain('the important bit');

    await click(host.querySelector('.fold-expand'));
    await click(host.querySelector('.fold-expand'));
    expect(host.querySelectorAll('.dl').length).toBe(1 + 40);
    expect(host.querySelector('.fold-expand')).toBeFalsy();
  });

  it('"Show all" reveals every line without needing per-fold Expand clicks', async () => {
    await render(<AreaView area={longHunkArea()} title="x" onBack={noop} />);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Show all'));
    expect(host.querySelectorAll('.dl').length).toBe(1 + 40);
  });

  it('opens and scrolls to the focused file first', async () => {
    const scrollSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollSpy;
    const twoFiles: AreaDetailDto = { ...fixtureArea, files: [fixtureArea.files[0]!, { ...fixtureArea.files[0]!, path: 'apps/web/src/AreaView.tsx' }] };
    await render(<AreaView area={twoFiles} title="x" onBack={noop} focusPath="apps/web/src/AreaView.tsx" />);
    expect(scrollSpy).toHaveBeenCalled();
    const details = [...host.querySelectorAll('details.file')];
    expect(details.every((d) => (d as HTMLDetailsElement).open)).toBe(true);
  });

  it('lists filtered files separately under "Not analysed"', async () => {
    const withFiltered: AreaDetailDto = { ...fixtureArea, files: [...fixtureArea.files, { path: 'big.bin', oldPath: null, status: 'M', additions: 0, deletions: 0, filteredReason: 'too_large', patch: null }] };
    await render(<AreaView area={withFiltered} title="x" onBack={noop} />);
    expect(host.querySelector('[aria-label="Not analysed"]')?.textContent).toContain('big.bin');
  });
});
