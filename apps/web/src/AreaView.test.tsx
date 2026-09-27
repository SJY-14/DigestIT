// @vitest-environment jsdom
import { act, StrictMode, type ReactElement } from 'react';
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
const key = async (k: string, target: EventTarget = document) => {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
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
  it('renders why/design/risks under their own headings and calls onBack', async () => {
    const onBack = vi.fn();
    await render(<AreaView area={fixtureArea} title="Project graph pane" onBack={onBack} onGenerate={noop} />);
    const headings = [...host.querySelectorAll('.area-l3 h3')].map((h) => h.textContent);
    expect(headings).toEqual(['Why', 'Design', 'Risks']);
    expect(host.textContent).toContain(fixtureArea.l3!.why);
    expect(host.textContent).toContain(fixtureArea.l3!.design);
    expect(host.textContent).toContain(fixtureArea.l3!.risks[0]);
    await click(host.querySelector('.back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('status "none": shows a Generate button with the remaining-calls count, and calls onGenerate', async () => {
    const onGenerate = vi.fn();
    await render(
      <AreaView area={{ ...fixtureArea, status: 'none', l3: null }} title="x" onBack={noop} onGenerate={onGenerate} callsRemaining={7} />,
    );
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Generate code-level explanation'));
    expect(btn?.textContent).toContain('uses 1 of 7 calls left');
    await click(btn);
    expect(onGenerate).toHaveBeenCalled();
    // No why/design/risks yet (no l3), but the diff is already in the GET payload and free to
    // show, with Generate above it.
    expect(host.querySelector('.area-l3')).toBeFalsy();
    const children = [...host.querySelector('.area-view')!.children];
    expect(children.indexOf(btn!)).toBeLessThan(children.findIndex((c) => c.matches('details.file')));
  });

  it('status "none": omits the call count when unknown', async () => {
    await render(<AreaView area={{ ...fixtureArea, status: 'none', l3: null }} title="x" onBack={noop} onGenerate={noop} />);
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Generate code-level explanation'));
    expect(btn?.textContent).toBe('Generate code-level explanation');
  });

  it('status "pending": shows a spinner', async () => {
    await render(<AreaView area={{ ...fixtureArea, status: 'pending', l3: null }} title="x" onBack={noop} onGenerate={noop} />);
    expect(host.querySelector('.spinner')).toBeTruthy();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Generating');
  });

  it('status "error": shows a notice and a Retry that calls onGenerate', async () => {
    const onGenerate = vi.fn();
    await render(<AreaView area={{ ...fixtureArea, status: 'error', l3: null }} title="x" onBack={noop} onGenerate={onGenerate} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not generate');
    await click(host.querySelector('.retry'));
    expect(onGenerate).toHaveBeenCalled();
  });

  it('status "truncated": shows a distinct notice (a partial result, not a budget message) and a Retry', async () => {
    await render(<AreaView area={{ ...fixtureArea, status: 'truncated', l3: null }} title="x" onBack={noop} onGenerate={noop} />);
    const text = host.querySelector('[role="alert"]')?.textContent;
    expect(text).toContain('truncated');
    expect(text).toContain('partial');
    expect(text).not.toContain('budget');
    expect(host.querySelector('.retry')).toBeTruthy();
  });

  it('folds a long hunk to +/- 3 lines around the annotated line, with an Expand control on each side', async () => {
    await render(<AreaView area={longHunkArea()} title="x" onBack={noop} onGenerate={noop} />);
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
    await render(<AreaView area={longHunkArea()} title="x" onBack={noop} onGenerate={noop} />);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Show all'));
    expect(host.querySelectorAll('.dl').length).toBe(1 + 40);
  });

  it("'e' expands every fold across every file", async () => {
    await render(<AreaView area={longHunkArea()} title="x" onBack={noop} onGenerate={noop} />);
    expect(host.querySelector('.fold-expand')).toBeTruthy();
    await key('e');
    expect(host.querySelectorAll('.dl').length).toBe(1 + 40);
    expect(host.querySelector('.fold-expand')).toBeFalsy();
  });

  it("ignores 'e' while composing (IME input in progress)", async () => {
    await render(<AreaView area={longHunkArea()} title="x" onBack={noop} onGenerate={noop} />);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true, isComposing: true }));
    });
    expect(host.querySelector('.fold-expand')).toBeTruthy();
  });

  it("ignores 'e' typed into a contenteditable region", async () => {
    await render(<AreaView area={longHunkArea()} title="x" onBack={noop} onGenerate={noop} />);
    const editable = document.createElement('div');
    // jsdom doesn't implement contentEditable reflection, so stub the property the guard reads.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    host.append(editable);
    await key('e', editable);
    expect(host.querySelector('.fold-expand')).toBeTruthy();
  });

  it("a tick from 'e' pressed before a file mounts doesn't skip its notes-gated collapse", async () => {
    const noNotesFile = { ...fixtureArea.files[0]!, path: 'apps/web/src/MainV2.tsx' };
    const empty: AreaDetailDto = { ...fixtureArea, status: 'none', l3: null, files: [] };
    const withFile: AreaDetailDto = { ...fixtureArea, status: 'none', l3: null, files: [noNotesFile] };
    await render(<AreaView area={empty} title="x" onBack={noop} onGenerate={noop} />);
    await key('e');
    // The file mounts later (e.g. once Generate resolves); expandAllTick is already > 0.
    await render(<AreaView area={withFile} title="x" onBack={noop} onGenerate={noop} />);
    const details = host.querySelector('details.file') as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it('opens and scrolls to the focused file first; other files stay collapsed unless they have notes', async () => {
    const scrollSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollSpy;
    const noNotesFile = { ...fixtureArea.files[0]!, path: 'apps/web/src/MainV2.tsx' };
    const twoFiles: AreaDetailDto = { ...fixtureArea, files: [noNotesFile, { ...fixtureArea.files[0]!, path: 'apps/web/src/AreaView.tsx' }] };
    await render(<AreaView area={twoFiles} title="x" onBack={noop} onGenerate={noop} focusPath="apps/web/src/AreaView.tsx" />);
    expect(scrollSpy).toHaveBeenCalled();
    const details = [...host.querySelectorAll('details.file')] as HTMLDetailsElement[];
    // First file has no notes and isn't focused: collapsed. Second is focused: open.
    expect(details[0]!.open).toBe(false);
    expect(details[1]!.open).toBe(true);
  });

  it('opens the newly focused file when focusPath changes while the area stays open', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const fileA = { ...fixtureArea.files[0]!, path: 'apps/web/src/MainV2.tsx' };
    const fileB = { ...fixtureArea.files[0]!, path: 'apps/web/src/AreaView.tsx' };
    const twoFiles: AreaDetailDto = { ...fixtureArea, files: [fileA, fileB] };
    await render(<AreaView area={twoFiles} title="x" onBack={noop} onGenerate={noop} focusPath={fileA.path} />);
    await render(<AreaView area={twoFiles} title="x" onBack={noop} onGenerate={noop} focusPath={fileB.path} />);
    const details = [...host.querySelectorAll('details.file')] as HTMLDetailsElement[];
    expect(details[0]!.open).toBe(true);
    expect(details[1]!.open).toBe(true);
  });

  it('a file with notes starts open even when not focused', async () => {
    // fixtureArea's one file (ProjectGraph.tsx) carries the l3 note.
    await render(<AreaView area={fixtureArea} title="x" onBack={noop} onGenerate={noop} />);
    const details = host.querySelector('details.file') as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it('a file with no notes starts collapsed to its header + stats', async () => {
    const noNotes: AreaDetailDto = { ...fixtureArea, files: [{ ...fixtureArea.files[0]!, path: 'apps/web/src/MainV2.tsx' }] };
    await render(<AreaView area={noNotes} title="x" onBack={noop} onGenerate={noop} />);
    const details = host.querySelector('details.file') as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it('a file with no notes starts collapsed under StrictMode (double-invoked mount effects)', async () => {
    const noNotes: AreaDetailDto = { ...fixtureArea, files: [{ ...fixtureArea.files[0]!, path: 'apps/web/src/MainV2.tsx' }] };
    await render(<StrictMode><AreaView area={noNotes} title="x" onBack={noop} onGenerate={noop} /></StrictMode>);
    const details = host.querySelector('details.file') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await key('e');
    expect(details.open).toBe(true);
  });

  it('lists filtered files separately under "Not analysed"', async () => {
    const withFiltered: AreaDetailDto = { ...fixtureArea, files: [...fixtureArea.files, { path: 'big.bin', oldPath: null, status: 'M', additions: 0, deletions: 0, filteredReason: 'too_large', patch: null }] };
    await render(<AreaView area={withFiltered} title="x" onBack={noop} onGenerate={noop} />);
    expect(host.querySelector('[aria-label="Not analysed"]')?.textContent).toContain('big.bin');
  });
});
