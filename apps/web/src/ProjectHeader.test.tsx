// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectIgnoreDto } from '@digestit/core';

class MockApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
const fetchProjectIgnore = vi.fn(async (_id: number): Promise<ProjectIgnoreDto> => ({ patterns: [], notTracked: [] }));
const addIgnorePatterns = vi.fn(async (_id: number, patterns: string[]): Promise<ProjectIgnoreDto> => ({ patterns, notTracked: [] }));
const removeIgnorePattern = vi.fn(async (_id: number, _pattern: string): Promise<ProjectIgnoreDto> => ({ patterns: [], notTracked: [] }));
const fetchMemory = vi.fn(async (_id: number) => ({
  projectId: _id, summariesEnabled: false, counts: { area: 0, term: 0, thread: 0, note: 0 }, lastBatch: null,
  usage: { jobsToday: 0, share: 4, reserve: 10 }, items: [],
}));
vi.mock('./v2Api.js', () => ({
  ApiError: MockApiError,
  fetchProjectIgnore: (id: number) => fetchProjectIgnore(id),
  addIgnorePatterns: (id: number, patterns: string[]) => addIgnorePatterns(id, patterns),
  removeIgnorePattern: (id: number, pattern: string) => removeIgnorePattern(id, pattern),
  fetchMemory: (id: number) => fetchMemory(id),
}));

const { ProjectHeader } = await import('./ProjectHeader.js');
type ProjectHeaderProps = import('./ProjectHeader.js').ProjectHeaderProps;
const { fixtureAbout, fixtureProject, fixtureStatus } = await import('./v2Fixtures.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  fetchProjectIgnore.mockResolvedValue({ patterns: [], notTracked: [] });
  addIgnorePatterns.mockImplementation(async (_id: number, patterns: string[]) => ({ patterns, notTracked: [] }));
  removeIgnorePattern.mockResolvedValue({ patterns: [], notTracked: [] });
  fetchMemory.mockResolvedValue({
    projectId: fixtureProject.id, summariesEnabled: false, counts: { area: 0, term: 0, thread: 0, note: 0 }, lastBatch: null,
    usage: { jobsToday: 2, share: 4, reserve: 10 }, items: [],
  });
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
const key = async (el: Element | Document, k: string) => {
  await act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
};
/** Flushes a macrotask, so a promise chain kicked off by a `toggle` event (jsdom queues it as a
 * task, not a microtask) has settled and its state update has landed. */
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function baseProps(overrides: Partial<ProjectHeaderProps> = {}): ProjectHeaderProps {
  return {
    projects: [fixtureProject],
    currentProject: fixtureProject,
    onSwitch: vi.fn(),
    onRemove: vi.fn(async () => undefined),
    about: fixtureAbout,
    status: fixtureStatus,
    statusError: null,
    explaining: false,
    onExplain: vi.fn(),
    onRefreshContext: vi.fn(),
    refreshingContext: false,
    onSetLanguage: vi.fn(),
    settingLanguage: false,
    languageError: null,
    ...overrides,
  };
}

describe('ProjectHeader: Explain button states', () => {
  it('shows the pending count as a primary action', async () => {
    await render(<ProjectHeader {...baseProps()} />);
    const btn = host.querySelector('.explain-btn')!;
    expect(btn.textContent).toContain('Explain 12 changes');
    expect(btn.className).toContain('primary');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('reads "No new changes" and drops the primary look when nothing is pending', async () => {
    const status = { ...fixtureStatus, pending: { files: 0, additions: 0, deletions: 0 } };
    await render(<ProjectHeader {...baseProps({ status })} />);
    const btn = host.querySelector('.explain-btn') as HTMLButtonElement;
    expect(btn.textContent).toContain('No new changes');
    expect(btn.className).not.toContain('primary');
    expect(btn.disabled).toBe(true);
  });

  it('shows elapsed time while running, from explainStartedAt', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date(Date.now() - 5000).toISOString();
      const status = { ...fixtureStatus, explaining: true, explainStartedAt: startedAt };
      await render(<ProjectHeader {...baseProps({ status, explaining: true })} />);
      const btn = host.querySelector('.explain-btn') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toContain('Explaining…');
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(btn.textContent).toMatch(/Explaining… (7|8)s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps counting from the click until the server reports explainStartedAt', async () => {
    vi.useFakeTimers();
    try {
      // Right after the click: explaining locally, but the last status poll has no start time yet.
      await render(<ProjectHeader {...baseProps({ explaining: true })} />);
      const btn = host.querySelector('.explain-btn') as HTMLButtonElement;
      expect(btn.textContent).toContain('Explaining… 0s');
      expect(btn.className).toContain('primary');
      await act(async () => { vi.advanceTimersByTime(4000); });
      expect(btn.textContent).toContain('Explaining… 4s');
      // The next poll brings the server's start time, which wins.
      const status = { ...fixtureStatus, explaining: true, explainStartedAt: new Date(Date.now() - 6000).toISOString() };
      await render(<ProjectHeader {...baseProps({ status, explaining: true })} />);
      expect(btn.textContent).toContain('Explaining… 6s');
      // Finished: back to the idle label, and a later run starts from 0 again.
      await render(<ProjectHeader {...baseProps()} />);
      expect(btn.textContent).toContain('Explain 12 changes');
      await render(<ProjectHeader {...baseProps({ explaining: true })} />);
      expect(btn.textContent).toContain('Explaining… 0s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says visibly when the daily budget is spent, and when it comes back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 28, 17, 5));
    try {
      const resetsAt = new Date(2026, 8, 29, 0, 0).toISOString();
      const status = { ...fixtureStatus, budget: { ...fixtureStatus.budget, remaining: 0, resetsAt } };
      await render(<ProjectHeader {...baseProps({ status })} />);
      const btn = host.querySelector('.explain-btn') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.className).not.toContain('primary');
      const badge = host.querySelector('.calls-left')!;
      expect(badge.textContent).toBe('No Explains left today · resets 00:00');
      expect(badge.className).toContain('spent');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a status error in words, with no Explain button to press', async () => {
    await render(<ProjectHeader {...baseProps({ status: null, statusError: 'Internal Server Error' })} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not load the project status: Internal Server Error');
    expect(host.querySelector('.explain-btn')).toBeNull();
  });

  it('puts the digest picker in the same row', async () => {
    await render(<ProjectHeader {...baseProps({ picker: <span className="fake-picker">picker</span> })} />);
    expect(host.querySelector('.project-header .header-picker .fake-picker')).toBeTruthy();
  });

  it('shows the calls-left badge', async () => {
    await render(<ProjectHeader {...baseProps()} />);
    expect(host.querySelector('.calls-left')?.textContent).toBe('23 Explains left today');
  });
});

describe('ProjectHeader: info popover', () => {
  it('opens on click, shows context status and the language select, closes on Escape and returns focus to the trigger', async () => {
    await render(<ProjectHeader {...baseProps()} />);
    const summary = host.querySelector('.info-popover > summary') as HTMLElement;
    expect(summary.textContent).toBe('Settings');
    await click(summary);
    expect((host.querySelector('.info-popover') as HTMLDetailsElement).open).toBe(true);
    expect(host.querySelector('.info-popover-panel')?.textContent).toContain('Built');
    expect(host.querySelector('.language-field select')).toBeTruthy();

    await key(document, 'Escape');
    expect((host.querySelector('.info-popover') as HTMLDetailsElement).open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it('shows budget, provider/model and the read-only line (UX cycle 2 P5, decision-2.md)', async () => {
    await render(<ProjectHeader {...baseProps()} />);
    await click(host.querySelector('.info-popover > summary'));
    const rows = [...host.querySelectorAll('.settings-row')].map((r) => r.textContent);
    expect(rows.some((r) => r?.includes('Daily budget') && r.includes('23 Explains left today'))).toBe(true);
    expect(rows.some((r) => r?.includes('Provider') && r.includes('claude-code'))).toBe(true);
    expect(rows.some((r) => r?.includes('Model') && r.includes('claude-sonnet-5-5'))).toBe(true);
    expect(host.querySelector('.settings-readonly')?.textContent).toContain('never writes to your project folder');
  });

  it('omits the Model row when the provider has none (e.g. stub)', async () => {
    await render(<ProjectHeader {...baseProps({ about: { ...fixtureAbout, provider: 'stub', model: null } })} />);
    await click(host.querySelector('.info-popover > summary'));
    const rows = [...host.querySelectorAll('.settings-row')].map((r) => r.textContent);
    expect(rows.some((r) => r?.includes('Provider') && r.includes('stub'))).toBe(true);
    expect(rows.some((r) => r?.includes('Model'))).toBe(false);
  });

  it('shows the Legacy insights link only when hasLegacyData is true', async () => {
    await render(<ProjectHeader {...baseProps()} />);
    await click(host.querySelector('.info-popover > summary'));
    expect(host.querySelector('.legacy-insights-link')).toBeNull();

    act(() => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await render(<ProjectHeader {...baseProps({ about: { ...fixtureAbout, hasLegacyData: true } })} />);
    await click(host.querySelector('.info-popover > summary'));
    const link = host.querySelector('.legacy-insights-link') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/insights');
    expect(link.textContent).toContain('Legacy insights (pre-v2 data)');
  });

  it('calls onSetLanguage when the language select changes', async () => {
    const onSetLanguage = vi.fn();
    await render(<ProjectHeader {...baseProps({ onSetLanguage })} />);
    await click(host.querySelector('.info-popover > summary'));
    const select = host.querySelector('.language-field select') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'ko');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSetLanguage).toHaveBeenCalledWith('ko');
  });
});

describe('ProjectHeader: ignore patterns (DIG-56)', () => {
  it('loads and lists this project\'s ignore patterns when the popover opens', async () => {
    fetchProjectIgnore.mockResolvedValue({ patterns: ['out/', '*.log'], notTracked: [] });
    await render(<ProjectHeader {...baseProps()} />);
    await click(host.querySelector('.info-popover > summary'));
    await flush(); // flush the fetch
    expect(fetchProjectIgnore).toHaveBeenCalledWith(fixtureProject.id);
    const items = [...host.querySelectorAll('.ignore-pattern-list code')].map((n) => n.textContent);
    expect(items).toEqual(['out/', '*.log']);
  });

  it('shows an empty-state message with no patterns', async () => {
    await render(<ProjectHeader {...baseProps()} />);
    await click(host.querySelector('.info-popover > summary'));
    await flush();
    expect(host.querySelector('.ignore-pattern-list')?.textContent).toContain('No ignore patterns yet');
  });

  it('adds a pattern from the input and shows it in the list', async () => {
    await render(<ProjectHeader {...baseProps()} />);
    await click(host.querySelector('.info-popover > summary'));
    await flush();
    const input = host.querySelector('.ignore-add-form input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'build/');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('.ignore-add-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(addIgnorePatterns).toHaveBeenCalledWith(fixtureProject.id, ['build/']);
    expect([...host.querySelectorAll('.ignore-pattern-list code')].map((n) => n.textContent)).toEqual(['build/']);
  });

  it('removes a pattern when its × button is clicked', async () => {
    fetchProjectIgnore.mockResolvedValue({ patterns: ['out/'], notTracked: [] });
    await render(<ProjectHeader {...baseProps()} />);
    await click(host.querySelector('.info-popover > summary'));
    await flush();
    await click(host.querySelector('.ignore-pattern-list .btn-icon'));
    expect(removeIgnorePattern).toHaveBeenCalledWith(fixtureProject.id, 'out/');
  });

  it('shows not-tracked groups with their pattern source and example paths', async () => {
    fetchProjectIgnore.mockResolvedValue({
      patterns: ['*.log'],
      notTracked: [{ reason: 'project-ignore', count: 3, examples: ['a.log', 'b.log'] }],
    });
    await render(<ProjectHeader {...baseProps()} />);
    await click(host.querySelector('.info-popover > summary'));
    await flush();
    const text = host.querySelector('.not-tracked-list')?.textContent ?? '';
    expect(text).toContain('3');
    expect(text).toContain('your project ignore pattern');
    expect(text).toContain('a.log, b.log');
  });

  it('shows an error message when adding a pattern fails', async () => {
    addIgnorePatterns.mockRejectedValueOnce(new MockApiError('bad_patterns', 400));
    await render(<ProjectHeader {...baseProps()} />);
    await click(host.querySelector('.info-popover > summary'));
    await flush();
    const input = host.querySelector('.ignore-add-form input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'x');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('.ignore-add-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('.ignore-section .error')?.textContent).toContain('Enter at least one pattern');
  });
});
