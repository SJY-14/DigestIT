// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectHeader, type ProjectHeaderProps } from './ProjectHeader.js';
import { fixtureProject, fixtureStatus } from './v2Fixtures.js';

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
const key = async (el: Element | Document, k: string) => {
  await act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
};

function baseProps(overrides: Partial<ProjectHeaderProps> = {}): ProjectHeaderProps {
  return {
    projects: [fixtureProject],
    currentProject: fixtureProject,
    onSwitch: vi.fn(),
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

  it('disables with a reason once the daily budget is spent', async () => {
    const status = { ...fixtureStatus, budget: { ...fixtureStatus.budget, remaining: 0 } };
    await render(<ProjectHeader {...baseProps({ status })} />);
    const btn = host.querySelector('.explain-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Daily budget used up');
  });

  it('shows the calls-left badge', async () => {
    await render(<ProjectHeader {...baseProps()} />);
    expect(host.querySelector('.calls-left')?.textContent).toBe('23 calls left today');
  });
});

describe('ProjectHeader: info popover', () => {
  it('opens on click, shows context status and the language select, closes on Escape and returns focus to the trigger', async () => {
    await render(<ProjectHeader {...baseProps()} />);
    const summary = host.querySelector('.info-popover > summary') as HTMLElement;
    await click(summary);
    expect((host.querySelector('.info-popover') as HTMLDetailsElement).open).toBe(true);
    expect(host.querySelector('.info-popover-panel')?.textContent).toContain('Built');
    expect(host.querySelector('select[aria-label="Explanation language"]')).toBeTruthy();

    await key(document, 'Escape');
    expect((host.querySelector('.info-popover') as HTMLDetailsElement).open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it('calls onSetLanguage when the language select changes', async () => {
    const onSetLanguage = vi.fn();
    await render(<ProjectHeader {...baseProps({ onSetLanguage })} />);
    await click(host.querySelector('.info-popover > summary'));
    const select = host.querySelector('select[aria-label="Explanation language"]') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'ko');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSetLanguage).toHaveBeenCalledWith('ko');
  });
});
