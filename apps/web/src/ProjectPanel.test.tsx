// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
vi.mock('./v2Api.js', () => ({ ApiError: MockApiError }));

const { ProjectPanel } = await import('./ProjectPanel.js');
const { fixtureProject, fixtureProject2 } = await import('./v2Fixtures.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
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
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const rowFor = (id: number) => host.querySelector(`.proj-row-main[data-project-id="${id}"]`);

describe('ProjectPanel: open/close (reuses DigestPicker\'s overlay pattern)', () => {
  it('opens on a trigger click, closes on Escape and returns focus to the trigger', async () => {
    await render(<ProjectPanel projects={[fixtureProject, fixtureProject2]} currentProject={fixtureProject} onSwitch={vi.fn()} onRemove={vi.fn()} />);
    const trigger = host.querySelector('.proj-trigger') as HTMLElement;
    expect(host.querySelector('.proj-panel')).toBeNull();
    await click(trigger);
    expect(host.querySelector('.proj-panel')).toBeTruthy();

    await key(document, 'Escape');
    expect(host.querySelector('.proj-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click without stealing focus', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    await render(<ProjectPanel projects={[fixtureProject, fixtureProject2]} currentProject={fixtureProject} onSwitch={vi.fn()} onRemove={vi.fn()} />);
    await click(host.querySelector('.proj-trigger'));
    expect(host.querySelector('.proj-panel')).toBeTruthy();
    // The close-on-outside-click listener is `mousedown` (same as DigestPicker's), not `click`.
    await act(async () => outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
    expect(host.querySelector('.proj-panel')).toBeNull();
    outside.remove();
  });

  it('opens a dialog holding a plain list (rows carry Remove buttons, so not a listbox), current project marked', async () => {
    await render(<ProjectPanel projects={[fixtureProject, fixtureProject2]} currentProject={fixtureProject} onSwitch={vi.fn()} onRemove={vi.fn()} />);
    const trigger = host.querySelector('.proj-trigger')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    await click(trigger);
    const panel = host.querySelector('.proj-panel')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(host.querySelector('.proj-list')?.getAttribute('role')).toBeNull();
    expect(host.querySelector('[role="listbox"], [role="option"]')).toBeNull();
    expect(rowFor(fixtureProject.id)?.getAttribute('aria-current')).toBe('true');
    expect(rowFor(fixtureProject2.id)?.getAttribute('aria-current')).toBeNull();
  });
});

describe('ProjectPanel: switching', () => {
  it('calls onSwitch with the picked project and closes the panel', async () => {
    const onSwitch = vi.fn();
    await render(<ProjectPanel projects={[fixtureProject, fixtureProject2]} currentProject={fixtureProject} onSwitch={onSwitch} onRemove={vi.fn()} />);
    await click(host.querySelector('.proj-trigger'));
    await click(rowFor(fixtureProject2.id));
    expect(onSwitch).toHaveBeenCalledWith(fixtureProject2.id);
    expect(host.querySelector('.proj-panel')).toBeNull();
  });
});

describe('ProjectPanel: remove (UX cycle 2 P4, inline two-step confirm)', () => {
  const removeButtonFor = (id: number) => host.querySelector(`.proj-row-main[data-project-id="${id}"]`)!.closest('.proj-row')!.querySelector('.proj-remove') as HTMLButtonElement;

  it('needs a second click to confirm, then calls onRemove', async () => {
    const onRemove = vi.fn(async () => undefined);
    await render(<ProjectPanel projects={[fixtureProject, fixtureProject2]} currentProject={fixtureProject} onSwitch={vi.fn()} onRemove={onRemove} />);
    await click(host.querySelector('.proj-trigger'));
    const btn = removeButtonFor(fixtureProject2.id);
    expect(btn.textContent).toBe('Remove');

    await click(btn);
    expect(onRemove).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('Confirm remove?');

    await click(btn);
    expect(onRemove).toHaveBeenCalledWith(fixtureProject2.id);
  });

  it('resets to idle, not confirm, once the removal lands', async () => {
    const onRemove = vi.fn(async () => undefined);
    await render(<ProjectPanel projects={[fixtureProject, fixtureProject2]} currentProject={fixtureProject} onSwitch={vi.fn()} onRemove={onRemove} />);
    await click(host.querySelector('.proj-trigger'));
    const btn = removeButtonFor(fixtureProject2.id);
    await click(btn);
    await click(btn);
    await flush();
    expect(removeButtonFor(fixtureProject2.id).textContent).toBe('Remove');
  });

  it('shows a short message inline on a 409 (Explain running), without closing the panel', async () => {
    const onRemove = vi.fn(async () => { throw new MockApiError('explain_running', 409); });
    await render(<ProjectPanel projects={[fixtureProject, fixtureProject2]} currentProject={fixtureProject} onSwitch={vi.fn()} onRemove={onRemove} />);
    await click(host.querySelector('.proj-trigger'));
    const btn = removeButtonFor(fixtureProject2.id);
    await click(btn);
    await click(btn);
    await flush();
    expect(host.querySelector('.proj-panel')).toBeTruthy();
    expect(host.querySelector('.proj-remove-error')?.textContent).toContain('An Explain is already running for this project.');
    expect(removeButtonFor(fixtureProject2.id).textContent).toBe('Remove');
  });

  it('reopening the panel clears a stale confirm/error state', async () => {
    const onRemove = vi.fn(async () => { throw new MockApiError('explain_running', 409); });
    await render(<ProjectPanel projects={[fixtureProject, fixtureProject2]} currentProject={fixtureProject} onSwitch={vi.fn()} onRemove={onRemove} />);
    await click(host.querySelector('.proj-trigger'));
    const btn = removeButtonFor(fixtureProject2.id);
    await click(btn);
    await click(btn);
    await flush();
    await key(document, 'Escape');
    await click(host.querySelector('.proj-trigger'));
    expect(removeButtonFor(fixtureProject2.id).textContent).toBe('Remove');
    expect(host.querySelector('.proj-remove-error')).toBeNull();
  });
});
