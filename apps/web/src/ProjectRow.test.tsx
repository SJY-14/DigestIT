// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRow, type ProjectRowProps } from './ProjectRow.js';

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

function baseProps(overrides: Partial<ProjectRowProps> = {}): ProjectRowProps {
  return {
    project: { id: 1, name: 'snapback', lastCheckpointAt: '2026-09-26T16:40:00Z' },
    current: false,
    unread: { kind: 'none' },
    onSelect: vi.fn(),
    ...overrides,
  };
}

describe('ProjectRow', () => {
  it('shows the project name and relative last-activity time', async () => {
    await render(<ProjectRow {...baseProps()} />);
    expect(host.querySelector('.proj-name')?.textContent).toBe('snapback');
    expect(host.querySelector('.proj-meta')?.textContent).toMatch(/Last activity/);
  });

  it('shows a placeholder when the project has no checkpoint yet', async () => {
    await render(<ProjectRow {...baseProps({ project: { id: 1, name: 'x', lastCheckpointAt: null } })} />);
    expect(host.querySelector('.proj-meta')?.textContent).toBe('No activity yet');
  });

  it('calls onSelect when the row is clicked', async () => {
    const onSelect = vi.fn();
    await render(<ProjectRow {...baseProps({ onSelect })} />);
    await click(host.querySelector('.proj-row-main'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('marks the current project with aria-current, not the others', async () => {
    await render(<ProjectRow {...baseProps({ current: true })} />);
    expect(host.querySelector('.proj-row-main')?.getAttribute('aria-current')).toBe('true');
  });

  it('shows no unread badge when caught up', async () => {
    await render(<ProjectRow {...baseProps({ unread: { kind: 'none' } })} />);
    expect(host.querySelector('.proj-unread')).toBeNull();
  });

  it('shows "New" for an unseen-with-no-seq entry', async () => {
    await render(<ProjectRow {...baseProps({ unread: { kind: 'new' } })} />);
    expect(host.querySelector('.proj-unread')?.textContent).toBe('New');
  });

  it('shows the unread count', async () => {
    await render(<ProjectRow {...baseProps({ unread: { kind: 'count', n: 3 } })} />);
    expect(host.querySelector('.proj-unread')?.textContent).toBe('3 new');
  });

  it('renders no Remove button when `remove` is omitted (All-projects view)', async () => {
    await render(<ProjectRow {...baseProps()} />);
    expect(host.querySelector('.proj-remove')).toBeNull();
  });

  it('two-step confirm: a first click shows "Confirm remove?" without calling onClick again until confirmed', async () => {
    const onClick = vi.fn();
    await render(<ProjectRow {...baseProps({ remove: { state: 'idle', error: null, onClick } })} />);
    expect(host.querySelector('.proj-remove')?.textContent).toBe('Remove');
    await click(host.querySelector('.proj-remove'));
    expect(onClick).toHaveBeenCalledTimes(1);

    await render(<ProjectRow {...baseProps({ remove: { state: 'confirm', error: null, onClick } })} />);
    expect(host.querySelector('.proj-remove')?.textContent).toBe('Confirm remove?');
    await click(host.querySelector('.proj-remove'));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('disables the Remove button and shows "Removing…" while in flight', async () => {
    await render(<ProjectRow {...baseProps({ remove: { state: 'removing', error: null, onClick: vi.fn() } })} />);
    const btn = host.querySelector('.proj-remove') as HTMLButtonElement;
    expect(btn.textContent).toBe('Removing…');
    expect(btn.disabled).toBe(true);
  });

  it('shows an inline error after a failed remove', async () => {
    await render(<ProjectRow {...baseProps({ remove: { state: 'idle', error: 'An Explain is already running for this project.', onClick: vi.fn() } })} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('An Explain is already running for this project.');
  });

  it('shows the headline only when passed (All-projects), never in the bare project-panel shape', async () => {
    await render(<ProjectRow {...baseProps()} />);
    expect(host.querySelector('.proj-headline')).toBeNull();

    await render(<ProjectRow {...baseProps({ headline: 'Backups now retry failed uploads' })} />);
    expect(host.querySelector('.proj-headline')?.textContent).toBe('Backups now retry failed uploads');
  });

  it('dims a caught-up row with the quiet style', async () => {
    await render(<ProjectRow {...baseProps({ quiet: true, headline: 'You’re caught up' })} />);
    expect(host.querySelector('.proj-row')?.className).toContain('caught-up');
  });

  it('is a plain button in a list item (no option role), so a sibling Remove button stays valid ARIA', async () => {
    await render(<ProjectRow {...baseProps({ current: true })} />);
    const main = host.querySelector('.proj-row-main')!;
    expect(main.getAttribute('role')).toBeNull();
    expect(main.getAttribute('aria-selected')).toBeNull();
    expect(host.querySelector('.proj-row')?.getAttribute('role')).toBeNull();
  });
});
