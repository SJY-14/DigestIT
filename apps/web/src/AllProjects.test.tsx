// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDto } from '@digestit/core';
import { AllProjects, rowHeadline, sortAllProjects } from './AllProjects.js';
import { setLastSeen } from './storage.js';
import { fixtureProject, fixtureProject2 } from './v2Fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unread = (kind: 'none' | 'new') => ({ kind }) as const;
const counted = (n: number) => ({ kind: 'count', n }) as const;

describe('sortAllProjects (UX cycle 2 P7, decision-2.md §2: unread-first, then newest)', () => {
  const p = (id: number, lastCheckpointAt: string | null): ProjectDto => ({ ...fixtureProject, id, lastCheckpointAt });

  it('puts every unread project before every caught-up one', () => {
    const rows = [
      { project: p(1, '2026-09-20T00:00:00Z'), unread: unread('none') },
      { project: p(2, '2026-09-10T00:00:00Z'), unread: counted(2) },
    ];
    expect(sortAllProjects(rows).map((r) => r.project.id)).toEqual([2, 1]);
  });

  it('breaks ties within the same unread-ness by most-recent activity first', () => {
    const rows = [
      { project: p(1, '2026-09-10T00:00:00Z'), unread: counted(1) },
      { project: p(2, '2026-09-20T00:00:00Z'), unread: counted(3) },
      { project: p(3, null), unread: unread('none') },
      { project: p(4, '2026-09-15T00:00:00Z'), unread: unread('none') },
    ];
    expect(sortAllProjects(rows).map((r) => r.project.id)).toEqual([2, 1, 4, 3]);
  });
});

describe('rowHeadline', () => {
  it('shows the newest digest headline while there is unread work', () => {
    expect(rowHeadline(fixtureProject, counted(2), 'en')).toBe('Fixture headline');
  });

  it('shows a quiet caught-up placeholder once there is nothing new', () => {
    expect(rowHeadline(fixtureProject, unread('none'), 'en')).toBe('You’re caught up');
  });

  it('shows a "no digests yet" placeholder for a project with none, even though it counts as caught up', () => {
    expect(rowHeadline(fixtureProject2, unread('none'), 'en')).toBe('No digests yet');
  });

  it('falls back to "not explained yet" for an unread digest with no L0 line', () => {
    const pending: ProjectDto = { ...fixtureProject, latestDigest: { id: 99, seq: 9, toAt: 'x', headline: null } };
    expect(rowHeadline(pending, counted(1), 'en')).toBe('Not explained yet');
  });
});

let root: Root;
let host: HTMLElement;

function mockFetch(projects: unknown[] | Error) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') {
      if (projects instanceof Error) return { ok: false, status: 500, json: async () => ({ error: projects.message }) } as Response;
      return { ok: true, status: 200, json: async () => projects } as Response;
    }
    throw new Error(`unhandled fetch in test: ${url}`);
  }));
}

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = async (el: ReactElement) => { await act(async () => root.render(el)); };
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};
const waitFor = async (check: () => boolean, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await act(async () => undefined);
  }
  throw new Error('waitFor: condition never became true');
};

describe('AllProjects', () => {
  it('shows a loading state, then an error if the fetch fails', async () => {
    mockFetch(new Error('boom'));
    await render(<AllProjects onOpenProject={vi.fn()} />);
    await waitFor(() => host.querySelector('[role="alert"]') !== null);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('boom');
  });

  it('renders every registered project, unread first, with the heading naming how many need attention', async () => {
    mockFetch([fixtureProject, fixtureProject2]);
    await render(<AllProjects onOpenProject={vi.fn()} />);
    await waitFor(() => host.querySelector('.proj-row') !== null);
    const names = [...host.querySelectorAll('.proj-name')].map((n) => n.textContent);
    // fixtureProject (never seen -> unread) sorts before fixtureProject2 (no digest -> caught up).
    expect(names).toEqual([fixtureProject.name, fixtureProject2.name]);
    expect(host.querySelector('.inbox-head h1')?.textContent).toBe('2 projects, 1 needs attention');
  });

  it('shows a quiet caught-up row once the newest digest has been seen', async () => {
    setLastSeen(fixtureProject.id, fixtureProject.latestDigest!.id, fixtureProject.latestDigest!.seq);
    mockFetch([fixtureProject, fixtureProject2]);
    await render(<AllProjects onOpenProject={vi.fn()} />);
    await waitFor(() => host.querySelector('.proj-row') !== null);
    expect(host.querySelector('.inbox-head h1')?.textContent).toBe('2 projects, you’re all caught up');
    const row = host.querySelector(`.proj-row-main[data-project-id="${fixtureProject.id}"]`)!.closest('.proj-row');
    expect(row?.className).toContain('caught-up');
    expect(row?.querySelector('.proj-headline')?.textContent).toBe('You’re caught up');
  });

  it('opens a row on that project\'s newest digest', async () => {
    const onOpenProject = vi.fn();
    mockFetch([fixtureProject, fixtureProject2]);
    await render(<AllProjects onOpenProject={onOpenProject} />);
    await waitFor(() => host.querySelector('.proj-row') !== null);
    await click(host.querySelector(`.proj-row-main[data-project-id="${fixtureProject.id}"]`));
    expect(onOpenProject).toHaveBeenCalledWith(fixtureProject.id, fixtureProject.latestDigest!.id);

    await click(host.querySelector(`.proj-row-main[data-project-id="${fixtureProject2.id}"]`));
    expect(onOpenProject).toHaveBeenCalledWith(fixtureProject2.id, null);
  });

  it('never shows a Remove button (row-removal belongs to the project panel, not this triage view)', async () => {
    mockFetch([fixtureProject, fixtureProject2]);
    await render(<AllProjects onOpenProject={vi.fn()} />);
    await waitFor(() => host.querySelector('.proj-row') !== null);
    expect(host.querySelector('.proj-remove')).toBeNull();
  });
});
