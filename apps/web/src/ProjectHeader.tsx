// Compact project header (DIG-49, docs/ux-v3.md §4): project switcher, the primary Explain
// button, a calls-left badge, and an info popover (context status + language) behind an ⓘ
// trigger. Replaces the taller `ProjectBar` from MainV2.tsx (DIG-40) so DIG-50 can own the
// reading pane below it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExplainLanguage, ProjectDto, ProjectStatusDto } from '@digestit/core';
import {
  callsLeftLabel, contextSummary, EXPLAIN_LANGUAGE_LIST, explainButtonLabel, explainingLabel, humanDateTime, LANGUAGE_NAMES,
} from './copy.js';
import { relativeTime } from './format.js';

/** Ticks once a second while `startedAt` is set, so the Explain button can show elapsed time
 * (and keeps working across a reload, since `startedAt` comes from the server). */
function useElapsedSeconds(startedAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (startedAt === null) return 0;
  return Math.max(0, (now - new Date(startedAt).getTime()) / 1000);
}

function ExplainButton({
  status, explaining, elapsedSeconds, onExplain,
}: {
  status: ProjectStatusDto;
  explaining: boolean;
  elapsedSeconds: number;
  onExplain: () => void;
}) {
  const nothingPending = status.pending.files === 0;
  const budgetSpent = status.budget.remaining === 0;
  const disabled = explaining || nothingPending || budgetSpent;
  const label = explaining
    ? explainingLabel(elapsedSeconds)
    : nothingPending
      ? 'No new changes'
      : explainButtonLabel(status.pending.files);
  const title = explaining ? undefined : nothingPending ? 'Nothing pending since last check' : budgetSpent ? 'Daily budget used up' : undefined;
  // Idle (nothing pending) drops the "primary" look on purpose (docs/ux-v3.md §4): it must read as
  // a calm no-op, not a disabled/broken version of the call-to-action button.
  const className = `btn explain-btn${!explaining && !nothingPending ? ' primary' : ''}`;
  return (
    <button type="button" className={className} disabled={disabled} onClick={onExplain} title={title} aria-live="polite">
      {explaining && <span className="spinner" aria-hidden="true" />}
      {label}
    </button>
  );
}

function InfoPopover({
  project, status, statusError, onRefreshContext, refreshingContext, onSetLanguage, settingLanguage, languageError,
}: {
  project: ProjectDto;
  status: ProjectStatusDto | null;
  statusError: string | null;
  onRefreshContext: () => void;
  refreshingContext: boolean;
  onSetLanguage: (language: ExplainLanguage) => void;
  settingLanguage: boolean;
  languageError: string | null;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const close = useCallback(() => {
    const el = detailsRef.current;
    if (!el?.open) return;
    el.removeAttribute('open');
    el.querySelector('summary')?.focus();
  }, []);
  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target as Node)) detailsRef.current.removeAttribute('open');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && detailsRef.current?.open) close();
    };
    document.addEventListener('click', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [close]);

  const context = status?.project.context;
  const built = context?.builtAt ? relativeTime(context.builtAt) : null;
  const summary = context ? contextSummary(context.status, built, context.fromFiles, context.hasUserContext) : null;

  return (
    <details className="info-popover" ref={detailsRef}>
      <summary aria-label="Project context and language">ⓘ</summary>
      <div className="info-popover-panel" role="dialog" aria-label="Project context and language">
        <p className="context-status">
          {statusError ? `Could not load status: ${statusError}` : (summary ?? 'Loading context…')}
        </p>
        <button type="button" className="btn" onClick={onRefreshContext} disabled={refreshingContext || !status}>
          {refreshingContext ? 'Refreshing…' : 'Refresh context'}
        </button>
        <label className="field language-field">
          <span>Language</span>
          <select
            aria-label="Explanation language"
            value={project.language}
            disabled={settingLanguage}
            onChange={(e) => onSetLanguage(e.target.value as ExplainLanguage)}
          >
            {EXPLAIN_LANGUAGE_LIST.map((l) => (
              <option key={l} value={l}>{LANGUAGE_NAMES[l]}</option>
            ))}
          </select>
        </label>
        {languageError && <p role="alert" className="error">Could not change language: {languageError}</p>}
      </div>
    </details>
  );
}

export interface ProjectHeaderProps {
  projects: ProjectDto[];
  currentProject: ProjectDto;
  onSwitch: (id: number) => void;
  status: ProjectStatusDto | null;
  statusError: string | null;
  explaining: boolean;
  onExplain: () => void;
  onRefreshContext: () => void;
  refreshingContext: boolean;
  onSetLanguage: (language: ExplainLanguage) => void;
  settingLanguage: boolean;
  languageError: string | null;
}

export function ProjectHeader({
  projects, currentProject, onSwitch, status, statusError, explaining, onExplain,
  onRefreshContext, refreshingContext, onSetLanguage, settingLanguage, languageError,
}: ProjectHeaderProps) {
  const elapsedSeconds = useElapsedSeconds(explaining ? (status?.explainStartedAt ?? null) : null);
  return (
    <div className="project-header">
      {projects.length > 1 ? (
        <select aria-label="Project" value={currentProject.id} onChange={(e) => onSwitch(Number(e.target.value))}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      ) : (
        <span className="project-name" title={currentProject.rootPath}>{currentProject.name}</span>
      )}
      {statusError && !status ? (
        <span role="alert" className="error">Could not load status: {statusError}</span>
      ) : status ? (
        <>
          <ExplainButton status={status} explaining={explaining} elapsedSeconds={elapsedSeconds} onExplain={onExplain} />
          <span className="badge calls-left" title={`Resets ${humanDateTime(status.budget.resetsAt)}`}>
            {callsLeftLabel(status.budget.remaining)}
          </span>
        </>
      ) : (
        <span className="muted">Loading…</span>
      )}
      <InfoPopover
        project={currentProject}
        status={status}
        statusError={statusError}
        onRefreshContext={onRefreshContext}
        refreshingContext={refreshingContext}
        onSetLanguage={onSetLanguage}
        settingLanguage={settingLanguage}
        languageError={languageError}
      />
    </div>
  );
}
