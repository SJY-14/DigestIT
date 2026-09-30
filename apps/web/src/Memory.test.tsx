// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryItemDto } from '@digestit/core';

class MockApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const fetchProjects = vi.fn();
const fetchAbout = vi.fn();
const fetchMemory = vi.fn();
const fetchMemoryUsed = vi.fn();
const patchMemoryItem = vi.fn();
const correctMemoryItem = vi.fn();
const rollbackMemory = vi.fn();
const clearProjectMemory = vi.fn();
const setMemorySummariesEnabled = vi.fn();

vi.mock('./v2Api.js', () => ({
  ApiError: MockApiError,
  fetchProjects: (...a: unknown[]) => fetchProjects(...a),
  fetchAbout: (...a: unknown[]) => fetchAbout(...a),
  fetchMemory: (...a: unknown[]) => fetchMemory(...a),
  fetchMemoryUsed: (...a: unknown[]) => fetchMemoryUsed(...a),
  patchMemoryItem: (...a: unknown[]) => patchMemoryItem(...a),
  correctMemoryItem: (...a: unknown[]) => correctMemoryItem(...a),
  rollbackMemory: (...a: unknown[]) => rollbackMemory(...a),
  clearProjectMemory: (...a: unknown[]) => clearProjectMemory(...a),
  setMemorySummariesEnabled: (...a: unknown[]) => setMemorySummariesEnabled(...a),
  memoryExportUrl: (id: number) => `/api/projects/${id}/memory/export`,
}));

const { MemoryPage, sortMemoryItems, filterMemoryItems, memoryItemSearchText } = await import('./Memory.js');
const { fixtureAbout, fixtureProject2 } = await import('./v2Fixtures.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = { ...fixtureProject2, id: 2, name: 'my-project', language: 'en' as const };

function item(overrides: Partial<MemoryItemDto> & { content: MemoryItemDto['content'] }): MemoryItemDto {
  return {
    id: 1, kind: 'area', key: 'k', language: 'en', source: 'code', status: 'active', pinned: false,
    provenance: { files: [], checkpointId: null, digestIds: [], jobId: null },
    confirmedAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z', version: 1,
    usedInDigests: 0, overriddenBy: null,
    ...overrides,
  } as MemoryItemDto;
}

const areaContent = (path: string, summary: string | null = null) => ({
  kind: 'area' as const, path, fileCount: 1, exports: [{ name: 'withRetry', kind: 'function' as const, file: path, line: 1 }],
  uses: [], usedBy: [], doc: null, summary, fingerprint: 'fp',
});
const noteContent = (text: string, target: { kind: 'area'; key: string } | null = null) => ({
  kind: 'note' as const, text, target, origin: (target ? 'correction' : 'context-md') as 'correction' | 'context-md',
});

describe('sortMemoryItems (decision-4-memory.md change 5: pinned, then stale, then usedInDigests desc, then key)', () => {
  it('orders by the documented tiers', () => {
    const a = item({ id: 1, key: 'b', content: areaContent('b'), pinned: false, status: 'active', usedInDigests: 5 });
    const b = item({ id: 2, key: 'a', content: areaContent('a'), pinned: false, status: 'stale', usedInDigests: 1 });
    const c = item({ id: 3, key: 'z', content: areaContent('z'), pinned: true, status: 'active', usedInDigests: 0 });
    const d = item({ id: 4, key: 'a', content: areaContent('a2'), pinned: false, status: 'active', usedInDigests: 5 });
    // c: pinned wins outright. b: stale beats a/d despite lower usedInDigests. a vs d: same
    // usedInDigests, tie-break by key ascending.
    expect(sortMemoryItems([a, b, c, d]).map((x) => x.id)).toEqual([3, 2, 4, 1]);
  });
});

describe('memoryItemSearchText / filterMemoryItems', () => {
  it('matches an area by path, doc/summary or an export name', () => {
    const a = item({ id: 1, content: areaContent('src/retry.ts', 'Retry with exponential backoff') });
    expect(memoryItemSearchText(a)).toContain('withRetry');
    expect(filterMemoryItems([a], 'backoff')).toEqual([a]);
    expect(filterMemoryItems([a], 'withRetry')).toEqual([a]);
    expect(filterMemoryItems([a], 'nope')).toEqual([]);
  });

  it('an empty query returns every row unfiltered', () => {
    const a = item({ id: 1, content: areaContent('a') });
    const b = item({ id: 2, content: areaContent('b') });
    expect(filterMemoryItems([a, b], '  ')).toEqual([a, b]);
  });
});

let root: Root;
let host: HTMLElement;

function defaultList(items: MemoryItemDto[] = []) {
  const counts = { area: 0, term: 0, thread: 0, note: 0 } as Record<string, number>;
  for (const it of items) if (it.status === 'active') counts[it.kind]!++;
  return {
    projectId: PROJECT.id, summariesEnabled: false, counts, lastBatch: null,
    usage: { jobsToday: 2, share: 4, reserve: 10 }, items,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  history.pushState(null, '', `/memory?project=${PROJECT.id}`);
  fetchProjects.mockResolvedValue([PROJECT]);
  fetchAbout.mockResolvedValue(fixtureAbout);
  fetchMemory.mockResolvedValue(defaultList());
  fetchMemoryUsed.mockResolvedValue({ digestId: 1, items: [], droppedForBudget: 0 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  history.pushState(null, '', '/');
});

const render = async (el: ReactElement) => { await act(async () => root.render(el)); };
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};
// React tracks each input's last-known value to dedupe change events; setting `.value` through the
// plain property setter updates that tracker too, so the later `input` event sees "no change" and
// React never calls `onChange`. Going through the native prototype setter bypasses the tracker.
const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
const typeInto = async (el: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    nativeTextareaValueSetter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const waitFor = async (check: () => boolean, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await act(async () => undefined);
  }
  throw new Error('waitFor: condition never became true');
};

describe('MemoryPage', () => {
  it('shows the empty-project state when there is no batch and no items', async () => {
    fetchMemory.mockResolvedValue(defaultList([]));
    await render(<MemoryPage onOpenDigest={vi.fn()} />);
    await waitFor(() => host.querySelector('.mem-empty-page') !== null);
    expect(host.querySelector('.mem-empty-page')?.textContent).toContain("hasn't looked at my-project yet");
    expect(host.querySelector('.mem-section')).toBeNull();
  });

  it('shows counts, kind sections and a row title once memory exists', async () => {
    const a = item({ id: 1, content: areaContent('src/retry.ts', 'Retry with exponential backoff'), usedInDigests: 6 });
    fetchMemory.mockResolvedValue(defaultList([a]));
    await render(<MemoryPage onOpenDigest={vi.fn()} />);
    await waitFor(() => host.querySelector('.mem-item') !== null);
    expect(host.querySelector('.mem-counts')?.textContent).toContain('Areas 1');
    expect(host.querySelector('.mem-item-title')?.textContent).toBe('src/retry.ts');
    expect(host.querySelector('.mem-item-foot')?.textContent).toContain('used in 6 digests');
  });

  it('deletes an item through the two-step confirm (Delete -> Confirm delete? -> hidden)', async () => {
    const a = item({ id: 1, content: areaContent('src/retry.ts') });
    fetchMemory.mockResolvedValue(defaultList([a]));
    patchMemoryItem.mockResolvedValue({ ...a, status: 'hidden' });
    await render(<MemoryPage onOpenDigest={vi.fn()} />);
    await waitFor(() => host.querySelector('.mem-item') !== null);

    const deleteBtn = [...host.querySelectorAll('.mem-item-actions button')].find((b) => b.textContent === 'Delete');
    expect(patchMemoryItem).not.toHaveBeenCalled();
    await click(deleteBtn);
    expect(host.querySelector('.mem-item-actions button.danger')?.textContent).toBe('Confirm delete?');
    expect(patchMemoryItem).not.toHaveBeenCalled();

    fetchMemory.mockResolvedValue(defaultList([{ ...a, status: 'hidden' }]));
    await click(host.querySelector('.mem-item-actions button.danger'));
    expect(patchMemoryItem).toHaveBeenCalledWith(1, { status: 'hidden' });
    await waitFor(() => host.querySelector('.mem-empty-page') === null && host.querySelector('.mem-tab[aria-selected="true"]')?.textContent === 'Active');
  });

  it('clears all memory through the two-step confirm, showing the exact-count prompt first', async () => {
    const a = item({ id: 1, content: areaContent('src/retry.ts') });
    fetchMemory.mockResolvedValue(defaultList([a]));
    clearProjectMemory.mockResolvedValue({ itemsDeleted: 1, batchesDeleted: 1 });
    await render(<MemoryPage onOpenDigest={vi.fn()} />);
    await waitFor(() => host.querySelector('.mem-item') !== null);

    const clearBtn = [...host.querySelectorAll('.mem-actions button')].find((b) => b.textContent === 'Clear');
    await click(clearBtn);
    expect(host.querySelector('.mem-confirm')?.textContent).toContain("This deletes all 1 item for my-project and can't be undone.");
    expect(clearProjectMemory).not.toHaveBeenCalled();

    fetchMemory.mockResolvedValue(defaultList([]));
    await click([...host.querySelectorAll('.mem-actions button')].find((b) => b.textContent === 'Confirm clear all memory?'));
    expect(clearProjectMemory).toHaveBeenCalledWith(PROJECT.id);
  });

  it('opens the Correct form, saves it, and closes on Cancel/Escape returning focus to the trigger', async () => {
    const a = item({ id: 1, content: areaContent('src/retry.ts', 'Retry with exponential backoff') });
    fetchMemory.mockResolvedValue(defaultList([a]));
    correctMemoryItem.mockResolvedValue(item({ id: 99, content: noteContent('actually...', { kind: 'area', key: 'src/retry.ts' }) }));
    await render(<MemoryPage onOpenDigest={vi.fn()} />);
    await waitFor(() => host.querySelector('.mem-item') !== null);

    const correctBtn = [...host.querySelectorAll('.mem-item-actions button')].find((b) => b.textContent === 'Correct') as HTMLButtonElement;
    await click(correctBtn);
    expect(host.querySelector('.mem-correct-box')).not.toBeNull();

    // Escape closes and returns focus to the Correct button.
    const textarea = host.querySelector('.mem-correct-box textarea') as HTMLTextAreaElement;
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('.mem-correct-box')).toBeNull();
    expect(document.activeElement).toBe(correctBtn);

    // Reopen, type, cancel: also closes and returns focus.
    await click(correctBtn);
    const ta2 = host.querySelector('.mem-correct-box textarea') as HTMLTextAreaElement;
    await typeInto(ta2, 'a correction');
    const cancelBtn = [...host.querySelectorAll('.mem-correct-actions button')].find((b) => b.textContent === 'Cancel');
    await click(cancelBtn);
    expect(host.querySelector('.mem-correct-box')).toBeNull();
    expect(document.activeElement).toBe(correctBtn);

    // Reopen, type, Save: calls the API and closes the form.
    await click(correctBtn);
    const ta3 = host.querySelector('.mem-correct-box textarea') as HTMLTextAreaElement;
    await typeInto(ta3, 'actually this retries 429s too');
    const saveBtn = [...host.querySelectorAll('.mem-correct-actions button')].find((b) => b.textContent === 'Save');
    await click(saveBtn);
    expect(correctMemoryItem).toHaveBeenCalledWith(1, 'actually this retries 429s too');
    await waitFor(() => host.querySelector('.mem-correct-box') === null);
  });

  it('shows the existing unauthorized copy, not the generic pin error, on a 401', async () => {
    const a = item({ id: 1, content: areaContent('src/retry.ts') });
    fetchMemory.mockResolvedValue(defaultList([a]));
    patchMemoryItem.mockRejectedValue(new MockApiError('unauthorized', 401));
    await render(<MemoryPage onOpenDigest={vi.fn()} />);
    await waitFor(() => host.querySelector('.mem-item') !== null);

    const pinBtn = [...host.querySelectorAll('.mem-item-actions button')].find((b) => b.textContent === 'Pin');
    await click(pinBtn);
    await waitFor(() => host.querySelector('[role="alert"]') !== null);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Your session expired. Reload the page and sign in again.');
  });

  it('the per-digest view shows a flat "Used for this digest" list with usedFor tags, no Delete', async () => {
    history.pushState(null, '', `/memory?project=${PROJECT.id}&digest=42`);
    const used = { ...item({ id: 1, content: areaContent('src/retry.ts') }), usedVersion: 1, usedFor: [{ part: 'summary' as const, area: null }] };
    fetchMemoryUsed.mockResolvedValue({ digestId: 42, items: [used], droppedForBudget: 3 });
    await render(<MemoryPage onOpenDigest={vi.fn()} />);
    await waitFor(() => host.querySelector('.mem-item') !== null);
    expect(host.querySelector('.mem-head h1')?.textContent).toBe('Used for this digest (1 item)');
    expect(host.querySelector('.mem-usage')?.textContent).toContain('3 more items considered but left out for space.');
    expect(host.querySelector('.mem-used-tag')?.textContent).toBe('Used for: L0 summary');
    expect([...host.querySelectorAll('.mem-item-actions button')].some((b) => b.textContent === 'Delete')).toBe(false);
  });
});
