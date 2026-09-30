// Project panel (UX cycle 2 P4, decision-2.md §2): replaces the bare `<select className=
// "project-switcher">` with a small overlay, built the same way as the digest picker
// (DigestPicker.tsx) — Escape, an outside click, or picking a row closes it and returns focus to
// the trigger. Each row (ProjectRow.tsx) adds last-activity and an unread badge over the old
// name-only list, plus an inline two-step Remove ("Remove" -> "Confirm remove?", no modal: this is
// a reversible soft-delete). Kept open across a removal so the operator can remove several
// projects in one sitting; only the row that was mid-confirm resets once it is gone.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectDto } from '@digestit/core';
import { ApiError } from './v2Api.js';
import { apiErrorMessage, projectsCopy, type Lang } from './copy.js';
import { getLastSeen } from './storage.js';
import { computeUnread } from './unread.js';
import { ProjectRow, type RemoveState } from './ProjectRow.js';

function removeErrorText(e: unknown, lang: Lang): string {
  const msg = e instanceof ApiError ? apiErrorMessage(e.message, lang) : e instanceof Error ? e.message : String(e);
  return projectsCopy(lang).removeError(msg);
}

export interface ProjectPanelProps {
  projects: ProjectDto[];
  currentProject: ProjectDto;
  onSwitch: (id: number) => void;
  /** Resolves once the soft-delete lands; rejects with the API error (409 while an Explain is
   * running, 404 if it is already gone) so the row can show it inline. */
  onRemove: (id: number) => Promise<void>;
  lang?: Lang;
}

export function ProjectPanel({ projects, currentProject, onSwitch, onRemove, lang = 'en' }: ProjectPanelProps) {
  const T = projectsCopy(lang);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const panelId = useId();
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  // Outside click closes without stealing focus; Escape closes and returns focus to the trigger —
  // the same behaviour as DigestPicker's overlay.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) close(false); };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // On open, focus the current project's row (else the first) so arrows start from there.
  useEffect(() => {
    if (!open) return;
    const rows = list.current?.querySelectorAll<HTMLButtonElement>('.proj-row-main');
    const cur = list.current?.querySelector<HTMLButtonElement>('.proj-row-main[aria-current="true"]');
    (cur ?? rows?.[0])?.focus();
  }, [open]);

  // A closed-then-reopened panel starts with no row mid-confirm and no stale error showing.
  useEffect(() => {
    if (!open) {
      setConfirmId(null);
      setErrors({});
    }
  }, [open]);

  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.proj-row-main') ?? []);
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const onRowRemoveClick = (id: number) => {
    if (confirmId !== id) {
      setConfirmId(id);
      setErrors((prev) => { if (!(id in prev)) return prev; const { [id]: _drop, ...rest } = prev; return rest; });
      return;
    }
    setConfirmId(null);
    setRemovingId(id);
    onRemove(id)
      .catch((e: unknown) => setErrors((prev) => ({ ...prev, [id]: removeErrorText(e, lang) })))
      .finally(() => setRemovingId(null));
  };

  const removeStateFor = (id: number): RemoveState => (removingId === id ? 'removing' : confirmId === id ? 'confirm' : 'idle');

  return (
    <div className="proj-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="proj-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="proj-trigger-name">{currentProject.name}</span>
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="proj-panel" id={panelId} role="dialog" aria-label={T.switchProjectLabel}>
          <h2>{T.projectsHeading}</h2>
          {/* A plain list, not a listbox: each row also carries its own Remove button, and a
             listbox may only own options. The current project is marked with aria-current. */}
          <ul className="proj-list" aria-label={T.projectsHeading} ref={list} onKeyDown={onListKey}>
            {projects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                current={p.id === currentProject.id}
                unread={computeUnread(p, getLastSeen(p.id))}
                onSelect={() => { onSwitch(p.id); close(true); }}
                remove={{ state: removeStateFor(p.id), error: errors[p.id] ?? null, onClick: () => onRowRemoveClick(p.id) }}
                lang={lang}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
