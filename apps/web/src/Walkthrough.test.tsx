// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AreaDetailDto } from '@digestit/core';
import { FOLD_PREVIEW, WalkthroughView, walkthroughOf } from './Walkthrough.js';
import { fixtureArea, fixtureDigest, fixtureWalkthrough } from './v2Fixtures.js';

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
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};
const item = { ...fixtureDigest.l2!.items[0]!, label: fixtureDigest.l2!.items[0]!.title };
const noop = () => undefined;
const view = (area: AreaDetailDto = fixtureArea, props: Partial<Parameters<typeof WalkthroughView>[0]> = {}) => (
  <WalkthroughView area={area} item={item} step={null} onStep={noop} onGenerate={noop} callsRemaining={23} {...props} />
);
const headersIn = (el: Element) => [...el.querySelectorAll('tr.hunk .code')].map((c) => c.textContent);

// A minimal area for the step ↔ code range tests (DIG-81, docs/ux/dig71-step-code-mapping.md §7):
// two files with small, hand-computable line numbers, one step covering two hunks.
const uploadPatch = [
  '@@ -10,4 +10,6 @@',
  ' ',
  ' function upload(file) {',
  '+  for (let i = 0; i <= retries; i++) {',
  '   const res = put(file);',
  '+    if (res.ok || i === retries) return res;',
  ' }',
].join('\n');
const cliPatch = [
  '@@ -40,1 +40,2 @@',
  " program.option('--folder <path>');",
  "+program.option('--retries <n>', 'retry count', 3);",
  '@@ -60,1 +61,1 @@',
  '-program.parse();',
  '+program.parseAsync();',
].join('\n');
const rangeArea: AreaDetailDto = {
  ...fixtureArea,
  files: [
    { path: 'upload.js', oldPath: null, status: 'M', additions: 2, deletions: 0, filteredReason: null, patch: uploadPatch },
    { path: 'cli.js', oldPath: null, status: 'M', additions: 2, deletions: 1, filteredReason: null, patch: cliPatch },
  ],
  l3: {
    overview: fixtureWalkthrough.overview,
    steps: [
      {
        title: 'Add retry to the upload loop',
        body: 'Retries a failed PUT.',
        hunks: [{ path: 'upload.js', hunk: 1 }, { path: 'cli.js', hunk: 1 }],
        mechanical: false,
      },
      {
        title: 'Use async parse',
        body: 'program.parseAsync replaces program.parse.',
        hunks: [{ path: 'cli.js', hunk: 2 }],
        mechanical: false,
      },
    ],
    check: [],
  } as unknown as AreaDetailDto['l3'],
};

describe('WalkthroughView', () => {
  it('renders the overview, then each step with exactly its own hunks right under the text', async () => {
    await render(view());
    expect(host.querySelector('.overview')?.textContent).toContain(fixtureWalkthrough.overview);
    const steps = [...host.querySelectorAll('section.step')];
    expect(steps).toHaveLength(4);
    expect(steps[0]!.querySelector('h3')?.textContent).toContain('Step 1');
    expect(steps[0]!.querySelector('h3')?.textContent).toContain(fixtureWalkthrough.steps[0]!.title);
    // Body comes before the hunks inside the step.
    const body = steps[0]!.querySelector('.step-body')!;
    const firstHunk = steps[0]!.querySelector('.hunk-block')!;
    expect(body.compareDocumentPosition(firstHunk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(headersIn(steps[0]!)).toEqual([expect.stringMatching(/^@@ -60,4 \+60,7 @@/)]);
    expect(headersIn(steps[1]!)).toEqual([expect.stringMatching(/^@@ -90,3 \+93,30 @@/)]);
    expect(headersIn(steps[2]!)).toEqual([expect.stringMatching(/^@@ -120,4 \+120,5 @@/)]);
    expect(headersIn(steps[3]!)).toEqual([expect.stringMatching(/^@@ -140,2 \+143,2 @@/)]);
  });

  it('marks the mechanical step so it can be drawn lighter', async () => {
    await render(view());
    const steps = [...host.querySelectorAll('section.step')];
    expect(steps.map((s) => s.classList.contains('mechanical'))).toEqual([false, false, false, true]);
    expect(steps[3]!.textContent).toContain('Mechanical');
  });

  it('puts "What to check" after the steps, then the hunks no step covers', async () => {
    await render(view());
    const order = [...host.querySelectorAll('.walkthrough-main > section')].map((s) => s.className.split(' ')[0]);
    expect(order).toEqual(['overview', 'step', 'step', 'step', 'step', 'check', 'uncovered']);
    const uncovered = host.querySelector('.uncovered')!;
    expect(uncovered.querySelector('h3')?.textContent).toBe('Not covered by the walkthrough');
    expect(headersIn(uncovered)).toEqual([expect.stringMatching(/^@@ -200,2 \+229,3 @@/)]);
    expect(host.querySelector('.check')?.textContent).toContain(fixtureWalkthrough.check[0]);
  });

  it('folds a hunk over 20 lines to its first lines, and "Show all" reveals the rest', async () => {
    await render(view());
    const long = host.querySelectorAll('section.step')[1]!;
    const rows = () => long.querySelectorAll('tr.dl:not(.hunk)').length;
    expect(rows()).toBe(FOLD_PREVIEW);
    const toggle = long.querySelector('.hunk-toggle') as HTMLButtonElement;
    expect(toggle.textContent).toBe('Show all 31 lines');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(rows()).toBe(31);
    expect(toggle.textContent).toBe('Show less');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Short hunks have no toggle.
    expect(host.querySelectorAll('section.step')[0]!.querySelector('.hunk-toggle')).toBeNull();
  });

  it('has a side step list for more than 3 steps, and next/previous buttons that call onStep', async () => {
    const onStep = vi.fn();
    await render(view(fixtureArea, { step: 2, onStep }));
    const toc = host.querySelector('nav.step-toc')!;
    expect(toc.getAttribute('aria-label')).toBe('Steps');
    expect(toc.querySelector('[aria-current="step"]')?.textContent).toContain(fixtureWalkthrough.steps[1]!.title);
    expect(host.querySelector('#step-2')?.classList.contains('current')).toBe(true);
    expect(host.querySelector('.step-bar-pos')?.textContent).toBe('Step 2 of 4');
    const [prev, next] = [...host.querySelectorAll('.step-bar button')] as HTMLButtonElement[];
    await click(next);
    expect(onStep).toHaveBeenLastCalledWith(3);
    await click(prev);
    expect(onStep).toHaveBeenLastCalledWith(1);
    await click(toc.querySelectorAll('button')[3]);
    expect(onStep).toHaveBeenLastCalledWith(4);
  });

  it('has no side list with 3 steps or fewer; Previous is disabled at the overview', async () => {
    const short = { ...fixtureArea, l3: { ...fixtureWalkthrough, steps: fixtureWalkthrough.steps.slice(0, 3) } as unknown as AreaDetailDto['l3'] };
    await render(view(short));
    expect(host.querySelector('nav.step-toc')).toBeNull();
    const [prev, next] = [...host.querySelectorAll('.step-bar button')] as HTMLButtonElement[];
    expect(prev!.disabled).toBe(true);
    expect(next!.disabled).toBe(false);
  });

  it('scrolls the current step into view', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    await render(view(fixtureArea, { step: 3 }));
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.contexts.at(-1)).toBe(host.querySelector('#step-3'));
  });

  it('says so when a step names a hunk that is not in the diff', async () => {
    const bad = {
      ...fixtureArea,
      l3: { ...fixtureWalkthrough, steps: [{ ...fixtureWalkthrough.steps[0]!, hunks: [{ path: 'apps/web/src/ProjectGraph.tsx', hunk: 9 }] }] } as unknown as AreaDetailDto['l3'],
    };
    await render(view(bad));
    expect(host.querySelector('.hunk-missing')?.textContent).toBe('Hunk 9 of apps/web/src/ProjectGraph.tsx is not in the stored diff.');
  });

  it('without a walkthrough: offers to generate one (with the cost) and still shows the full diff', async () => {
    const onGenerate = vi.fn();
    await render(view({ ...fixtureArea, status: 'none', l3: null }, { onGenerate }));
    const btn = host.querySelector('.notice.generate button') as HTMLButtonElement;
    expect(btn.textContent).toBe('Explain this code');
    expect(host.querySelector('.notice.generate')?.textContent).toContain('Uses 1 of 23 Explains left today');
    await click(btn);
    expect(onGenerate).toHaveBeenCalled();
    expect(host.querySelectorAll('.full-diff .hunk-block')).toHaveLength(5);
    expect(host.querySelector('.not-analysed')?.textContent).toContain('package-lock.bin');
  });

  it('disables Generate when no calls are left', async () => {
    await render(view({ ...fixtureArea, status: 'none', l3: null }, { callsRemaining: 0 }));
    expect((host.querySelector('.notice.generate button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a spinner while pending and Try again on error', async () => {
    await render(view({ ...fixtureArea, status: 'pending', l3: null }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Writing the walkthrough');
    const onGenerate = vi.fn();
    await render(view({ ...fixtureArea, status: 'error', l3: null }, { onGenerate }));
    await click(host.querySelector('[role="alert"] button'));
    expect(onGenerate).toHaveBeenCalled();
  });

  it('no reviewed toggle when the caller has nothing to mark yet', async () => {
    await render(view());
    expect(host.querySelector('.reviewed-toggle')).toBeNull();
  });

  it('reviewed toggle (DIG-61 P5-A): "Mark as reviewed" / "Reviewed", click again to undo', async () => {
    const onToggleReviewed = vi.fn();
    await render(view(fixtureArea, { reviewed: false, onToggleReviewed }));
    const toggle = host.querySelector('.reviewed-toggle') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Mark as reviewed');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await click(toggle);
    expect(onToggleReviewed).toHaveBeenCalledTimes(1);

    await render(view(fixtureArea, { reviewed: true, onToggleReviewed }));
    const toggled = host.querySelector('.reviewed-toggle') as HTMLButtonElement;
    expect(toggled.textContent).toContain('Reviewed');
    expect(toggled.textContent).not.toContain('Mark as reviewed');
    expect(toggled.getAttribute('aria-pressed')).toBe('true');
    await click(toggled);
    expect(onToggleReviewed).toHaveBeenCalledTimes(2);
  });

  it('P1 (DIG-81): shows a range label on every hunk block, and "k of M ranges" only for a multi-hunk step', async () => {
    await render(view(rangeArea, { step: 1 }));
    const steps = [...host.querySelectorAll('section.step')];
    const step1Blocks = [...steps[0]!.querySelectorAll('.hunk-block')];
    expect(step1Blocks).toHaveLength(2);
    expect(step1Blocks[0]!.querySelector('.hunk-range')?.textContent).toBe('· lines 12–14');
    expect(step1Blocks[0]!.querySelector('.hunk-pos')?.textContent).toBe('1 of 2 ranges');
    expect(step1Blocks[1]!.querySelector('.hunk-range')?.textContent).toBe('· line 41');
    expect(step1Blocks[1]!.querySelector('.hunk-pos')?.textContent).toBe('2 of 2 ranges');

    const step2Block = steps[1]!.querySelector('.hunk-block')!;
    expect(step2Block.querySelector('.hunk-range')?.textContent).toBe('· line 61');
    expect(step2Block.querySelector('.hunk-pos')).toBeNull();
  });

  it('P1/P2 (DIG-81): uncovered hunk blocks get the range label but no step badge', async () => {
    await render(view());
    const uncovered = host.querySelector('.uncovered .hunk-block')!;
    expect(uncovered.querySelector('.step-badge')).toBeNull();
    expect(uncovered.querySelector('.hunk-range')?.textContent).toBeTruthy();
  });

  it('P2 (DIG-81): the hunk-block badge is filled (shape, not just colour) for the current step, outlined otherwise', async () => {
    await render(view(rangeArea, { step: 1 }));
    const steps = [...host.querySelectorAll('section.step')];
    const step1Badges = [...steps[0]!.querySelectorAll('.hunk-block .step-badge')];
    expect(step1Badges.map((b) => b.textContent)).toEqual(['1', '1']);
    expect(step1Badges.every((b) => b.classList.contains('current'))).toBe(true);

    const step2Badge = steps[1]!.querySelector('.hunk-block .step-badge')!;
    expect(step2Badge.textContent).toBe('2');
    expect(step2Badge.classList.contains('current')).toBe(false);
  });

  it('P3 (DIG-81): announces the step and range, and moves focus to the step heading, only on an actual step change', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    await render(view(rangeArea, { step: 1 }));
    const live = () => host.querySelector('[aria-live="polite"]');
    expect(live()?.textContent).toBe('Step 1 of 2, upload.js lines 12–14 and 1 more');
    expect(document.activeElement?.id).toBe('step-1-title');
    expect(focusSpy).toHaveBeenCalledTimes(1);

    // Same step, a new walkthrough object (a poll or DIG-76 streamed-step refresh mid-read): no
    // re-announce, no refocus — it would otherwise yank focus away from what the reader is doing.
    const polled = { ...rangeArea, l3: { ...(rangeArea.l3 as object) } as unknown as AreaDetailDto['l3'] };
    await render(view(polled, { step: 1 }));
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(live()?.textContent).toBe('Step 1 of 2, upload.js lines 12–14 and 1 more');

    await render(view(rangeArea, { step: 2 }));
    expect(live()?.textContent).toBe('Step 2 of 2, cli.js line 61');
    expect(document.activeElement?.id).toBe('step-2-title');
    expect(focusSpy).toHaveBeenCalledTimes(2);

    // Leaving step mode and coming back to the same step (browser back to ?step=2) fires again.
    await render(view(rangeArea, { step: null }));
    (document.activeElement as HTMLElement | null)?.blur();
    await render(view(rangeArea, { step: 2 }));
    expect(document.activeElement?.id).toBe('step-2-title');
    expect(focusSpy).toHaveBeenCalledTimes(3);
    focusSpy.mockRestore();
  });
});

describe('walkthroughOf', () => {
  it('accepts the walkthrough shape and rejects the older why/design/risks shape', () => {
    expect(walkthroughOf(fixtureArea)).toBe(fixtureWalkthrough);
    const legacy = { ...fixtureArea, l3: { why: 'w', design: 'd', risks: [], notes: [] } as unknown as AreaDetailDto['l3'] };
    expect(walkthroughOf(legacy)).toBeNull();
    expect(walkthroughOf({ ...fixtureArea, l3: null })).toBeNull();
  });
});
