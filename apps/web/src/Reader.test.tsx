// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AreaPicker, Breadcrumb, digestAreaRows, LevelSwitcher, partsSettled, readerKey, StructureView, SummaryView } from './Reader.js';
import { fixtureDigest, fixtureDigestDone, fixtureDigestPartial, fixtureDigestPending } from './v2Fixtures.js';

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
const key = (k: string, target: Element | null = document.body, mods: Partial<KeyboardEvent> = {}) =>
  readerKey({ key: k, target, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods } as KeyboardEvent);

describe('readerKey', () => {
  it('maps 0–3 to levels and n/p to steps', () => {
    expect(key('0')).toEqual({ kind: 'level', level: 0 });
    expect(key('3')).toEqual({ kind: 'level', level: 3 });
    expect(key('n')).toEqual({ kind: 'step', delta: 1 });
    expect(key('p')).toEqual({ kind: 'step', delta: -1 });
    expect(key('4')).toBeNull();
    expect(key('N')).toBeNull();
  });
  it('is ignored while typing in a field or a contenteditable, with modifiers, or while composing', () => {
    for (const tag of ['input', 'textarea', 'select']) expect(key('2', document.createElement(tag))).toBeNull();
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not compute isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(key('2', editable)).toBeNull();
    expect(key('2', document.body, { ctrlKey: true })).toBeNull();
    expect(key('2', document.body, { metaKey: true })).toBeNull();
    expect(key('n', document.body, { isComposing: true })).toBeNull();
  });
});

describe('LevelSwitcher', () => {
  it('is a tablist with the current level selected and in the tab order', async () => {
    await render(<LevelSwitcher level={2} onLevel={() => undefined} />);
    const tabs = [...host.querySelectorAll('[role="tab"]')];
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Explanation level');
    expect(tabs.map((t) => t.textContent)).toEqual(['L0 Summary', 'L1 Impact', 'L2 Structure', 'L3 Code']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false']);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1']);
    expect(tabs[0]!.getAttribute('aria-controls')).toBe('reading-pane');
  });
  it('arrow keys, Home and End move between tabs', async () => {
    const onLevel = vi.fn();
    await render(<LevelSwitcher level={1} onLevel={onLevel} />);
    const list = host.querySelector('[role="tablist"]')!;
    const press = (k: string) => act(() => { list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
    press('ArrowRight');
    expect(onLevel).toHaveBeenLastCalledWith(2);
    press('ArrowLeft');
    expect(onLevel).toHaveBeenLastCalledWith(0);
    press('End');
    expect(onLevel).toHaveBeenLastCalledWith(3);
    press('Home');
    expect(onLevel).toHaveBeenLastCalledWith(0);
  });
});

describe('Breadcrumb', () => {
  it('shows digest › area › level at L3, every segment a button', async () => {
    const onDigest = vi.fn();
    const onArea = vi.fn();
    const onLevel = vi.fn();
    const item = { ...fixtureDigest.l2!.items[0]!, label: fixtureDigest.l2!.items[0]!.title };
    await render(<Breadcrumb digest={{ toAt: new Date().toISOString() }} level={3} area={item} onDigest={onDigest} onArea={onArea} onLevel={onLevel} />);
    const crumbs = [...host.querySelectorAll('.breadcrumb button')];
    expect(crumbs.map((c) => c.textContent)).toEqual([expect.stringMatching(/^Digest · Today, \d\d:\d\d$/), item.title, 'L3 Code']);
    await click(crumbs[0]);
    await click(crumbs[1]);
    await click(crumbs[2]);
    expect([onDigest, onArea, onLevel].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
  it('leaves the area out below L3', async () => {
    const item = { ...fixtureDigest.l2!.items[0]!, label: fixtureDigest.l2!.items[0]!.title };
    await render(<Breadcrumb digest={fixtureDigest} level={1} area={item} onDigest={vi.fn()} onArea={vi.fn()} onLevel={vi.fn()} />);
    expect(host.querySelectorAll('.breadcrumb button')).toHaveLength(2);
  });
});

describe('level views', () => {
  it('L0: the headline and a stats line', async () => {
    await render(<SummaryView digest={fixtureDigest} onLevel={vi.fn()} onOpenArea={vi.fn()} onHoverArea={vi.fn()} />);
    expect(host.querySelector('h2.l0-headline')?.textContent).toBe(fixtureDigest.l0!.text);
    expect(host.querySelector('.l0-stats')?.textContent).toMatch(/^12 files · \+340 −25/);
  });
  it('L0: a compact "Areas in this digest" card per area, landing on L2 (not L3) with that area', async () => {
    const onOpenArea = vi.fn();
    const onHoverArea = vi.fn();
    await render(<SummaryView digest={fixtureDigest} onLevel={vi.fn()} onOpenArea={onOpenArea} onHoverArea={onHoverArea} />);
    expect(host.querySelector('.areas-glance-label')?.textContent).toBe('Areas in this digest');
    const cards = [...host.querySelectorAll('.area-glance-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain(fixtureDigest.l2!.items[0]!.title);
    expect(cards[0]!.textContent).toContain('Open area');
    await click(cards[1]!);
    expect(onOpenArea).toHaveBeenCalledWith('area-view');
    await act(async () => (cards[0] as HTMLElement).focus());
    expect(onHoverArea).toHaveBeenCalledWith('graph-pane');
  });
  it('L0: no areas module when the digest has no areas', async () => {
    await render(<SummaryView digest={{ ...fixtureDigest, l2: null }} onLevel={vi.fn()} onOpenArea={vi.fn()} onHoverArea={vi.fn()} />);
    expect(host.querySelector('.areas-glance')).toBeNull();
  });
  it('L2: one card per area; clicking the card or its title opens the area', async () => {
    const onOpenArea = vi.fn();
    await render(<StructureView digest={fixtureDigest} filter={null} selectedAreaId="area-view" onOpenArea={onOpenArea} onClearFilter={vi.fn()} onHoverArea={vi.fn()} onLevel={vi.fn()} />);
    const cards = [...host.querySelectorAll('.area-card')];
    expect(cards).toHaveLength(2);
    expect(cards[1]!.classList.contains('selected')).toBe(true);
    expect(cards[0]!.textContent).toContain(fixtureDigest.l2!.items[0]!.how);
    expect(cards[0]!.textContent).toContain(fixtureDigest.l2!.items[0]!.why);
    expect(cards[0]!.getAttribute('data-area-id')).toBe('graph-pane');
    await click(cards[0]!.querySelector('.area-card-effect'));
    expect(onOpenArea).toHaveBeenLastCalledWith('graph-pane');
    await click(cards[1]!.querySelector('.area-card-title button'));
    expect(onOpenArea).toHaveBeenLastCalledWith('area-view');
    expect(onOpenArea).toHaveBeenCalledTimes(2);
  });
  it('L2 filtered: only the areas touching the node, with a way back to all', async () => {
    const onClear = vi.fn();
    await render(<StructureView digest={fixtureDigest} filter={{ path: 'apps/web/src/AreaView.tsx', areaIds: new Set(['area-view']) }} selectedAreaId={null} onOpenArea={vi.fn()} onClearFilter={onClear} onHoverArea={vi.fn()} onLevel={vi.fn()} />);
    expect(host.querySelectorAll('.area-card')).toHaveLength(1);
    expect(host.querySelector('.filter-header')?.textContent).toContain('1 of 2 areas touch apps/web/src/AreaView.tsx');
    await click(host.querySelector('.clear-filter'));
    expect(onClear).toHaveBeenCalled();
  });
  it('L2: a reviewed area shows a small, not color-only indicator', async () => {
    await render(
      <StructureView
        digest={fixtureDigest} filter={null} selectedAreaId={null} onOpenArea={vi.fn()} onClearFilter={vi.fn()} onHoverArea={vi.fn()}
        onLevel={vi.fn()} reviewedAreaIds={new Set(['area-view'])}
      />,
    );
    const cards = [...host.querySelectorAll('.area-card')];
    expect(cards[0]!.querySelector('.reviewed-indicator')).toBeNull();
    expect(cards[1]!.querySelector('.reviewed-indicator')?.textContent).toContain('Reviewed');
  });
  it('L3 without an area: a compact picker, not an empty state', async () => {
    const onOpenArea = vi.fn();
    await render(<AreaPicker digest={fixtureDigest} onOpenArea={onOpenArea} onHoverArea={vi.fn()} />);
    expect(host.querySelector('.picker-head')?.textContent).toBe('Pick an area to walk through its code.');
    const picks = host.querySelectorAll('.area-pick');
    expect(picks).toHaveLength(2);
    await click(picks[1]);
    expect(onOpenArea).toHaveBeenCalledWith('area-view');
  });
  it('L3 picker: a reviewed area shows the same indicator', async () => {
    await render(<AreaPicker digest={fixtureDigest} onOpenArea={vi.fn()} onHoverArea={vi.fn()} reviewedAreaIds={new Set(['graph-pane'])} />);
    const picks = [...host.querySelectorAll('.area-pick')];
    expect(picks[0]!.querySelector('.reviewed-indicator')?.textContent).toContain('Reviewed');
    expect(picks[1]!.querySelector('.reviewed-indicator')).toBeNull();
  });
});

describe('digestAreaRows (DIG-76 Fast Explain)', () => {
  it('an old-contract digest (no `areas`) reads every area as settled, from `l2.items` alone', () => {
    const rows = digestAreaRows(fixtureDigest);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
    expect(rows[0]!.title).toBe(fixtureDigest.l2!.items[0]!.title);
    expect(rows[0]!.label).toBe(fixtureDigest.l2!.items[0]!.title);
  });

  it('a pending Fast Explain digest shows the skeleton with no text yet, status from `parts`', () => {
    const rows = digestAreaRows(fixtureDigestPending);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.title === null)).toBe(true);
    expect(rows.map((r) => r.label)).toEqual(['apps/web', 'packages/core']);
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('a partially landed digest mixes settled and pending/failed rows', () => {
    const rows = digestAreaRows(fixtureDigestPartial);
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.title).toBe(fixtureDigestPartial.l2!.items[0]!.title);
    expect(rows[1]!.status).toBe('error');
    expect(rows[1]!.title).toBeNull();
  });
});

describe('partsSettled', () => {
  it('is false while any part is pending or running, true once every part has settled', () => {
    expect(partsSettled(fixtureDigestPending.parts!)).toBe(false);
    // A failed part (`packages-core`: 'error') has settled, just unsuccessfully — it does not
    // keep the digest "still in flight".
    expect(partsSettled(fixtureDigestPartial.parts!)).toBe(true);
    expect(partsSettled(fixtureDigestDone.parts!)).toBe(true);
  });
});

describe('SummaryView / ImpactView / StructureView placeholders (DIG-76 Fast Explain)', () => {
  it('L0: a placeholder headline while the summary part is still running, not the "no summary" message', async () => {
    await render(<SummaryView digest={fixtureDigestPending} onLevel={vi.fn()} onOpenArea={vi.fn()} onHoverArea={vi.fn()} />);
    expect(host.querySelector('.l0-headline')?.textContent).toBe('Writing the summary…');
    expect(host.querySelector('.area-glance-card')).toBeTruthy(); // the area map still shows from the skeleton
  });

  it('L0: a failed summary part shows its own retry, calling the passed-in handler', async () => {
    const failed = { ...fixtureDigestPending, parts: { ...fixtureDigestPending.parts!, summary: 'error' as const } };
    const onRetryPart = vi.fn();
    await render(<SummaryView digest={failed} onLevel={vi.fn()} onOpenArea={vi.fn()} onHoverArea={vi.fn()} onRetryPart={onRetryPart} />);
    expect(host.querySelector('.l0-headline .part-failed')?.textContent).toContain("Couldn't write this part.");
    await click(host.querySelector('.l0-headline .retry'));
    expect(onRetryPart).toHaveBeenCalled();
  });

  it('L2: each area card shows its own placeholder or failure independent of the others', async () => {
    await render(
      <StructureView
        digest={fixtureDigestPartial} filter={null} selectedAreaId={null} onOpenArea={vi.fn()} onClearFilter={vi.fn()}
        onHoverArea={vi.fn()} onLevel={vi.fn()} onRetryPart={vi.fn()}
      />,
    );
    const cards = [...host.querySelectorAll('.area-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector('.area-card-effect')?.textContent).toBe(fixtureDigestPartial.l2!.items[0]!.effect);
    expect(cards[0]!.querySelector('.part-failed')).toBeNull();
    expect(cards[1]!.querySelector('.part-failed')?.textContent).toContain("Couldn't write this part.");
    expect(cards[1]!.querySelector('h3')?.textContent).toContain('packages/core'); // the skeleton label, no title yet
  });
});
