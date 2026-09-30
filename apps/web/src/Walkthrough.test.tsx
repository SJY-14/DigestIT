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
/** All "no" gutter numbers (old and new) rendered inside `el`, for the "no line rendered twice" check. */
const lineNos = (el: Element) => [...el.querySelectorAll('tr.dl .no')].map((td) => td.textContent).filter((t) => t !== '');

// A 60-line new file split over 3 steps, plus a small mechanical rename in a second file
// (DIG-96 acceptance: one new file, one 60-line hunk, split over 3 steps).
const bigPatch = ['@@ -0,0 +1,60 @@', ...Array.from({ length: 60 }, (_, i) => `+line ${i + 1}`)].join('\n');
const renamePatch = ['@@ -1,1 +1,1 @@', '-import { old } from "./x";', '+import { renamed } from "./x";'].join('\n');
const splitArea: AreaDetailDto = {
  ...fixtureArea,
  files: [
    { path: 'src/retry.ts', oldPath: null, status: 'A', additions: 60, deletions: 0, filteredReason: null, patch: bigPatch },
    { path: 'src/index.ts', oldPath: null, status: 'M', additions: 1, deletions: 1, filteredReason: null, patch: renamePatch },
  ],
  l3: {
    overview: 'A new retry helper is added in three parts, then a caller is renamed.',
    steps: [
      {
        title: 'Part one',
        body: 'The first part of the new file.',
        hunks: [{ path: 'src/retry.ts', hunk: 1 }],
        ranges: [{ path: 'src/retry.ts', side: 'new', start: 1, end: 20 }],
        callouts: [{ path: 'src/retry.ts', side: 'new', start: 10, end: 10, note: 'first part marker' }],
        mechanical: false,
      },
      {
        title: 'Part two',
        body: 'The second part of the new file.',
        hunks: [{ path: 'src/retry.ts', hunk: 1 }],
        ranges: [{ path: 'src/retry.ts', side: 'new', start: 21, end: 40 }],
        callouts: [{ path: 'src/retry.ts', side: 'new', start: 25, end: 25, note: 'second part marker' }],
        mechanical: false,
      },
      {
        title: 'Part three',
        body: 'The third part of the new file.',
        hunks: [{ path: 'src/retry.ts', hunk: 1 }],
        ranges: [{ path: 'src/retry.ts', side: 'new', start: 41, end: 60 }],
        callouts: [{ path: 'src/retry.ts', side: 'new', start: 55, end: 55, note: 'third part marker' }],
        mechanical: false,
      },
      {
        title: 'Rename the import',
        body: 'old becomes renamed.',
        hunks: [{ path: 'src/index.ts', hunk: 1 }],
        ranges: [{ path: 'src/index.ts', side: 'new', start: 1, end: 1 }],
        callouts: [],
        mechanical: true,
      },
    ],
    check: [],
  } as unknown as AreaDetailDto['l3'],
};

describe('WalkthroughView: step snippets (DIG-96)', () => {
  it('shows each step a different, non-overlapping snippet of its own range', async () => {
    await render(view(splitArea));
    const steps = [...host.querySelectorAll('section.step')];
    expect(steps).toHaveLength(4);
    const [s1, s2, s3] = steps.map((s) => [...s.querySelectorAll('.range-snippet')]);
    expect(s1).toHaveLength(1);
    expect(s2).toHaveLength(1);
    expect(s3).toHaveLength(1);
    expect(s1![0]!.textContent).toContain('line 10');
    expect(s2![0]!.textContent).toContain('line 25');
    expect(s3![0]!.textContent).toContain('line 55');
    // No line number appears under more than one step.
    const seen = new Set<string>();
    for (const s of [s1![0]!, s2![0]!, s3![0]!]) {
      for (const n of lineNos(s)) {
        expect(seen.has(n!)).toBe(false);
        seen.add(n!);
      }
    }
  });

  it('captions each snippet "path · lines a–b" with the step badge', async () => {
    await render(view(splitArea, { step: 2 }));
    const snippet = host.querySelectorAll('section.step')[1]!.querySelector('.range-snippet')!;
    expect(snippet.querySelector('.hunk-caption code')?.textContent).toBe('src/retry.ts');
    expect(snippet.querySelector('.hunk-range')?.textContent).toBe('· lines 21–40');
    const badge = snippet.querySelector('.step-badge')!;
    expect(badge.textContent).toBe('2');
    expect(badge.classList.contains('current')).toBe(true);
  });

  it('never shows the whole hunk under a step: no tr.hunk header inside a range snippet', async () => {
    await render(view(splitArea));
    expect(host.querySelectorAll('section.step tr.hunk')).toHaveLength(0);
  });

  it('marks callout lines with a gutter highlight, and puts the note under the last anchored line', async () => {
    await render(view(splitArea));
    const snippet = host.querySelectorAll('section.step')[0]!.querySelector('.range-snippet')!;
    const marked = snippet.querySelector('tr.dl.callout')!;
    expect(marked.textContent).toContain('line 10');
    const note = marked.nextElementSibling!;
    expect(note.className).toBe('callout-note-row');
    expect(note.textContent).toContain('first part marker');
    expect(note.querySelector('.visually-hidden')?.textContent).toBe('line 10: ');
  });

  it('renders a callout note through the inline-code prose renderer', async () => {
    const withCode: AreaDetailDto = {
      ...splitArea,
      l3: {
        ...(splitArea.l3 as { overview: string; steps: unknown[]; check: string[] }),
        steps: [
          { ...(splitArea.l3 as { steps: { callouts: unknown[] }[] }).steps[0]!, callouts: [{ path: 'src/retry.ts', side: 'new', start: 10, end: 10, note: 'reads `retries` from options' }] },
          ...(splitArea.l3 as { steps: unknown[] }).steps.slice(1),
        ],
      } as unknown as AreaDetailDto['l3'],
    };
    await render(view(withCode));
    const note = host.querySelector('.callout-note')!;
    expect(note.querySelector('code.inline-code')?.textContent).toBe('retries');
  });

  it('the mechanical step is collapsed by default; a disclosure reveals its snippet', async () => {
    await render(view(splitArea));
    const mech = host.querySelectorAll('section.step')[3]!;
    expect(mech.classList.contains('mechanical')).toBe(true);
    expect(mech.querySelector('h3')?.textContent).toContain('Mechanical');
    expect(mech.querySelector('.range-snippet')).toBeNull();
    const toggle = mech.querySelector('.mechanical-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(mech.querySelector('.range-snippet')).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('says so when a step names a range that is not in the diff', async () => {
    const bad: AreaDetailDto = {
      ...splitArea,
      l3: {
        ...(splitArea.l3 as { overview: string; steps: { ranges: unknown[] }[]; check: string[] }),
        steps: [{ ...(splitArea.l3 as { steps: { ranges: unknown[] }[] }).steps[0]!, ranges: [{ path: 'src/retry.ts', side: 'new', start: 900, end: 901 }] }],
      } as unknown as AreaDetailDto['l3'],
    };
    await render(view(bad));
    expect(host.querySelector('.range-missing')?.textContent).toBe('lines 900–901 of src/retry.ts are not in the stored diff.');
  });
});

describe('WalkthroughView: full diff (DIG-96)', () => {
  it('is collapsed by default, behind one "View full diff" toggle', async () => {
    await render(view(splitArea));
    expect(host.querySelectorAll('.full-diff')).toHaveLength(1);
    const toggle = host.querySelector('.full-diff-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.full-diff-body')).toBeNull();
    await click(toggle);
    expect(host.querySelector('.full-diff-body')).not.toBeNull();
  });

  it('shows every hunk exactly once, with step badges on the lines each step covers', async () => {
    await render(view(splitArea));
    await click(host.querySelector('.full-diff-toggle'));
    const figures = host.querySelectorAll('.full-diff-body .hunk-block');
    // One figure for the 60-line hunk, one for the rename.
    expect(figures).toHaveLength(2);
    const big = figures[0]!;
    expect(big.querySelectorAll('tr.hunk')).toHaveLength(1);
    await click(big.querySelector('.hunk-toggle')); // reveal the folded lines first
    const badges = [...big.querySelectorAll('.step-badge')];
    expect(badges.map((b) => b.textContent)).toEqual(expect.arrayContaining(['1', '2', '3']));
  });

  it('clicking a full-diff badge calls onStep with that step', async () => {
    const onStep = vi.fn();
    await render(view(splitArea, { onStep }));
    await click(host.querySelector('.full-diff-toggle'));
    await click(host.querySelector('.full-diff-body .hunk-toggle'));
    const badge = [...host.querySelectorAll('.full-diff-body .step-badge')].find((b) => b.textContent === '2')!;
    await click(badge);
    expect(onStep).toHaveBeenCalledWith(2);
  });

  it('folds the 60-line hunk in the full diff, and "Show all" reveals the rest', async () => {
    await render(view(splitArea));
    await click(host.querySelector('.full-diff-toggle'));
    const big = host.querySelectorAll('.full-diff-body .hunk-block')[0]!;
    expect(big.querySelectorAll('tr.dl:not(.hunk)')).toHaveLength(FOLD_PREVIEW);
    const toggle = big.querySelector('.hunk-toggle') as HTMLButtonElement;
    await click(toggle);
    expect(big.querySelectorAll('tr.dl:not(.hunk)')).toHaveLength(60);
  });

  it('without a walkthrough: the full diff shows directly, no toggle', async () => {
    await render(view({ ...splitArea, status: 'none', l3: null }));
    expect(host.querySelector('.full-diff-toggle')).toBeNull();
    expect(host.querySelectorAll('.full-diff .hunk-block')).toHaveLength(2);
  });
});

describe('WalkthroughView: shared behaviour', () => {
  it('renders the overview, then the steps, then "What to check", then the full diff toggle', async () => {
    await render(view());
    expect(host.querySelector('.overview')?.textContent).toContain(fixtureWalkthrough.overview);
    const order = [...host.querySelectorAll('.walkthrough-main > section')].map((s) => s.className.split(' ')[0]);
    expect(order).toEqual(['overview', 'step', 'step', 'step', 'step', 'check', 'full-diff']);
    expect(host.querySelector('.check')?.textContent).toContain(fixtureWalkthrough.check[0]);
  });

  it('marks the mechanical step so it can be drawn lighter', async () => {
    await render(view());
    const steps = [...host.querySelectorAll('section.step')];
    expect(steps.map((s) => s.classList.contains('mechanical'))).toEqual([false, false, false, true]);
    expect(steps[3]!.textContent).toContain('Mechanical');
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

  it('(DIG-96) announces the step and its first range, and moves focus to the step heading, only on an actual step change', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    await render(view(fixtureArea, { step: 1 }));
    const live = () => host.querySelector('[aria-live="polite"]');
    expect(live()?.textContent).toBe('Step 1 of 4, apps/web/src/ProjectGraph.tsx lines 61–64');
    expect(document.activeElement?.id).toBe('step-1-title');
    expect(focusSpy).toHaveBeenCalledTimes(1);

    // Same step, a new walkthrough object (a poll or DIG-76 streamed-step refresh mid-read): no
    // re-announce, no refocus — it would otherwise yank focus away from what the reader is doing.
    const polled = { ...fixtureArea, l3: { ...fixtureWalkthrough } as unknown as AreaDetailDto['l3'] };
    await render(view(polled, { step: 1 }));
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(live()?.textContent).toBe('Step 1 of 4, apps/web/src/ProjectGraph.tsx lines 61–64');

    await render(view(fixtureArea, { step: 4 }));
    expect(live()?.textContent).toBe('Step 4 of 4, packages/core/src/graphLayout.ts line 143');
    expect(document.activeElement?.id).toBe('step-4-title');
    expect(focusSpy).toHaveBeenCalledTimes(2);

    // Leaving step mode and coming back to the same step (browser back to ?step=4) fires again.
    await render(view(fixtureArea, { step: null }));
    (document.activeElement as HTMLElement | null)?.blur();
    await render(view(fixtureArea, { step: 4 }));
    expect(document.activeElement?.id).toBe('step-4-title');
    expect(focusSpy).toHaveBeenCalledTimes(3);
    focusSpy.mockRestore();
  });
});

describe('walkthroughOf', () => {
  it('accepts the ranges/callouts shape and rejects the older why/design/risks shape', () => {
    expect(walkthroughOf(fixtureArea)).toBe(fixtureWalkthrough);
    const legacy = { ...fixtureArea, l3: { why: 'w', design: 'd', risks: [], notes: [] } as unknown as AreaDetailDto['l3'] };
    expect(walkthroughOf(legacy)).toBeNull();
    expect(walkthroughOf({ ...fixtureArea, l3: null })).toBeNull();
  });

  it('rejects a pre-DIG-96 walkthrough whose steps only have `hunks`, no `ranges`', () => {
    const old = {
      ...fixtureArea,
      l3: { ...fixtureWalkthrough, steps: fixtureWalkthrough.steps.map(({ ranges: _ranges, callouts: _callouts, ...s }) => s) } as unknown as AreaDetailDto['l3'],
    };
    expect(walkthroughOf(old)).toBeNull();
  });
});
