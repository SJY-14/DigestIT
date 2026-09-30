// Compact project header (DIG-49, docs/ux-v3.md §4): one row with the project switcher, the digest
// picker (passed in as `picker`), a calls-left badge, the Settings panel (context/language/ignore,
// plus budget/provider/read-only per UX cycle 2 P5) behind a "Settings" trigger, and the primary
// Explain button. Every pixel it takes comes out of the reading pane below, so it stays a single line.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AboutDto, ExplainLanguage, ProjectDto, ProjectIgnoreDto, ProjectStatusDto } from '@digestit/core';
import {
  apiErrorMessage, callsLeftLabel, contextSummary, EXPLAIN_LANGUAGE_LIST, explainButtonLabel, explainingLabel,
  headerCopy, humanDateTime, ignoreCopy, LANGUAGE_NAMES, notTrackedReasonLabel, trustCopy, type Lang,
} from './copy.js';
import { relativeTime } from './format.js';
import { addIgnorePatterns, ApiError, fetchProjectIgnore, removeIgnorePattern } from './v2Api.js';
import { ProjectPanel } from './ProjectPanel.js';

function ignoreErrorText(e: unknown, lang: Lang): string {
  return e instanceof ApiError ? apiErrorMessage(e.message, lang) : e instanceof Error ? e.message : String(e);
}

/** Seconds since the running Explain started, ticking once a second. The server's `startedAt`
 * wins (it survives a reload and covers a CLI run); until the first status poll brings it, the
 * count runs from when this header first saw `explaining` (the click), so it never sits at 0s. */
export function useElapsedSeconds(explaining: boolean, startedAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  const localStart = useRef<number | null>(null);
  if (!explaining) localStart.current = null;
  else if (localStart.current === null) localStart.current = Date.now();
  useEffect(() => {
    if (!explaining) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [explaining]);
  if (!explaining) return 0;
  const server = startedAt === null ? Number.NaN : new Date(startedAt).getTime();
  const start = Number.isNaN(server) ? localStart.current! : server;
  return Math.max(0, (Math.max(now, Date.now()) - start) / 1000);
}

function ExplainButton({
  status, explaining, elapsedSeconds, onExplain, lang,
}: {
  status: ProjectStatusDto;
  explaining: boolean;
  elapsedSeconds: number;
  onExplain: () => void;
  lang: Lang;
}) {
  const T = headerCopy(lang);
  const nothingPending = status.pending.files === 0;
  const budgetSpent = status.budget.remaining === 0;
  const disabled = explaining || nothingPending || budgetSpent;
  const label = explaining
    ? explainingLabel(elapsedSeconds, lang)
    : explainButtonLabel(status.pending.files, lang);
  const title = explaining ? undefined : nothingPending ? T.nothingPendingHint : budgetSpent ? T.noCallsHint : undefined;
  // Nothing pending or no calls left drops the "primary" look on purpose (docs/ux-v3.md §4): it
  // must read as a calm no-op, not a disabled/broken version of the call-to-action button.
  const primary = explaining || (!nothingPending && !budgetSpent);
  const className = `btn explain-btn${primary ? ' primary' : ''}${explaining ? ' running' : ''}`;
  return (
    <button type="button" className={className} disabled={disabled} onClick={onExplain} title={title} aria-live="polite">
      {explaining && <span className="spinner" aria-hidden="true" />}
      {label}
    </button>
  );
}

function InfoPopover({
  project, about, status, statusError, onRefreshContext, refreshingContext, onSetLanguage, settingLanguage, languageError, lang,
}: {
  project: ProjectDto;
  /** Global provider/model/read-only/legacy-data info (P5, `GET /api/about`); null while loading. */
  about: AboutDto | null;
  status: ProjectStatusDto | null;
  statusError: string | null;
  onRefreshContext: () => void;
  refreshingContext: boolean;
  onSetLanguage: (language: ExplainLanguage) => void;
  settingLanguage: boolean;
  languageError: string | null;
  lang: Lang;
}) {
  const T = headerCopy(lang);
  const TT = trustCopy(lang);
  const TI = ignoreCopy(lang);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [ignore, setIgnore] = useState<ProjectIgnoreDto | null>(null);
  const [ignoreError, setIgnoreError] = useState<string | null>(null);
  const [newPattern, setNewPattern] = useState('');
  const [addingPattern, setAddingPattern] = useState(false);
  const [removingPattern, setRemovingPattern] = useState<string | null>(null);
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

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setIgnoreError(null);
    fetchProjectIgnore(project.id)
      .then((dto) => { if (active) setIgnore(dto); })
      .catch((e: unknown) => { if (active) setIgnoreError(ignoreErrorText(e, lang)); });
    return () => { active = false; };
  }, [open, project.id, lang]);

  const onAddPattern = (e: FormEvent) => {
    e.preventDefault();
    const pattern = newPattern.trim();
    if (!pattern) return;
    setAddingPattern(true);
    setIgnoreError(null);
    addIgnorePatterns(project.id, [pattern])
      .then((dto) => { setIgnore(dto); setNewPattern(''); })
      .catch((e2: unknown) => setIgnoreError(ignoreErrorText(e2, lang)))
      .finally(() => setAddingPattern(false));
  };

  const onRemovePattern = (pattern: string) => {
    setRemovingPattern(pattern);
    setIgnoreError(null);
    removeIgnorePattern(project.id, pattern)
      .then(setIgnore)
      .catch((e2: unknown) => setIgnoreError(ignoreErrorText(e2, lang)))
      .finally(() => setRemovingPattern(null));
  };

  const context = status?.project.context;
  const built = context?.builtAt ? relativeTime(context.builtAt, Date.now(), lang) : null;
  const summary = context ? contextSummary(context.status, built, context.fromFiles, context.hasUserContext, lang) : null;

  return (
    <details className="info-popover" ref={detailsRef} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary aria-label={T.settingsLabel} title={T.settingsLabel}>{T.settingsLabel}</summary>
      <div className="info-popover-panel" role="dialog" aria-label={T.settingsLabel}>
        {status && (
          <div className="settings-row">
            <span>{T.budgetRowLabel}</span>
            <span>{callsLeftLabel(status.budget.remaining, status.budget.resetsAt, Date.now(), lang)}</span>
          </div>
        )}
        {about && (
          <div className="settings-row"><span>{T.providerRowLabel}</span><span className="mono">{about.provider}</span></div>
        )}
        {about?.model && (
          <div className="settings-row"><span>{T.modelRowLabel}</span><span className="mono">{about.model}</span></div>
        )}
        <p className="settings-readonly">{TT.readOnly}</p>

        <p className="context-status">
          {statusError ? T.statusError(statusError) : (summary ?? T.loadingStatus)}
        </p>
        <button type="button" className="btn" onClick={onRefreshContext} disabled={refreshingContext || !status}>
          {refreshingContext ? T.refreshingContext : T.refreshContext}
        </button>
        <label className="field language-field">
          <span>{T.languageLabel}</span>
          <select
            value={project.language}
            disabled={settingLanguage}
            onChange={(e) => onSetLanguage(e.target.value as ExplainLanguage)}
          >
            {EXPLAIN_LANGUAGE_LIST.map((l) => (
              <option key={l} value={l}>{LANGUAGE_NAMES[l]}</option>
            ))}
          </select>
        </label>
        <p className="muted language-hint">{T.languageHint}</p>
        {languageError && <p role="alert" className="error">{T.languageError(languageError)}</p>}

        <div className="ignore-section">
          <h3>{TI.heading}</h3>
          <p className="muted">{TI.hint}</p>
          {ignoreError && <p role="alert" className="error">{ignoreError}</p>}
          {ignore && (
            <>
              <ul className="ignore-pattern-list">
                {ignore.patterns.length === 0 && <li className="muted">{TI.empty}</li>}
                {ignore.patterns.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                    <button
                      type="button"
                      className="btn-icon"
                      aria-label={TI.remove(p)}
                      disabled={removingPattern === p}
                      onClick={() => onRemovePattern(p)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <form className="ignore-add-form" onSubmit={onAddPattern}>
                <input
                  type="text"
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  placeholder={TI.placeholder}
                  aria-label={TI.heading}
                />
                <button type="submit" className="btn" disabled={addingPattern || newPattern.trim() === ''}>
                  {addingPattern ? TI.adding : TI.add}
                </button>
              </form>
              <h3>{TI.notTrackedHeading}</h3>
              {ignore.notTracked.length === 0 ? (
                <p className="muted">{TI.notTrackedEmpty}</p>
              ) : (
                <ul className="not-tracked-list">
                  {ignore.notTracked.map((g) => (
                    <li key={g.reason}>
                      {g.count} — {notTrackedReasonLabel(g.reason, lang)}
                      {g.examples.length > 0 && <span> ({TI.notTrackedExamples(g.examples)})</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        {about?.hasLegacyData && (
          // Demoted, not deleted (decision-2.md IA decision): the only way to reach the pre-v2
          // Insights view is this link, and only once a project actually has legacy data
          // (`unit_event` rows) — a clean v2-only install never sees it. A plain navigation, not a
          // client-side route push: Settings has no reference to App.tsx's page state.
          <a className="legacy-insights-link" href="/insights">
            {T.legacyInsightsLink} <span aria-hidden="true">→</span>
          </a>
        )}
      </div>
    </details>
  );
}

export interface ProjectHeaderProps {
  projects: ProjectDto[];
  currentProject: ProjectDto;
  onSwitch: (id: number) => void;
  /** UX cycle 2 P4: soft-removes a project (ProjectPanel.tsx's Remove); resolves once it lands,
   * rejects with the API error otherwise. */
  onRemove: (id: number) => Promise<void>;
  /** Global provider/model/read-only/legacy-data info (P5, `GET /api/about`); null while loading. */
  about: AboutDto | null;
  status: ProjectStatusDto | null;
  statusError: string | null;
  explaining: boolean;
  onExplain: () => void;
  onRefreshContext: () => void;
  refreshingContext: boolean;
  onSetLanguage: (language: ExplainLanguage) => void;
  settingLanguage: boolean;
  languageError: string | null;
  /** The digest picker, shown between the project and the budget (absent before the first digest). */
  picker?: ReactNode;
  /** The UI chrome's language; defaults to English for callers (mostly tests) that don't care.
   * MainV2 passes the current project's `language`. */
  lang?: Lang;
}

export function ProjectHeader({
  projects, currentProject, onSwitch, onRemove, about, status, statusError, explaining, onExplain,
  onRefreshContext, refreshingContext, onSetLanguage, settingLanguage, languageError, picker, lang = 'en',
}: ProjectHeaderProps) {
  const T = headerCopy(lang);
  const elapsedSeconds = useElapsedSeconds(explaining, status?.explainStartedAt ?? null);
  const budgetSpent = status !== null && status.budget.remaining === 0;
  return (
    <div className="project-header">
      <ProjectPanel projects={projects} currentProject={currentProject} onSwitch={onSwitch} onRemove={onRemove} lang={lang} />
      <div className="header-picker">{picker}</div>
      {statusError && !status && <span role="alert" className="error">{T.statusError(statusError)}</span>}
      {status && (
        <span
          className={budgetSpent ? 'badge calls-left spent' : 'badge calls-left'}
          role={budgetSpent ? 'status' : undefined}
          title={budgetSpent ? T.noCallsHint : T.resets(humanDateTime(status.budget.resetsAt, Date.now(), lang))}
        >
          {callsLeftLabel(status.budget.remaining, status.budget.resetsAt, Date.now(), lang)}
        </span>
      )}
      <InfoPopover
        project={currentProject}
        about={about}
        status={status}
        statusError={statusError}
        onRefreshContext={onRefreshContext}
        refreshingContext={refreshingContext}
        onSetLanguage={onSetLanguage}
        settingLanguage={settingLanguage}
        languageError={languageError}
        lang={lang}
      />
      {status ? (
        <ExplainButton status={status} explaining={explaining} elapsedSeconds={elapsedSeconds} onExplain={onExplain} lang={lang} />
      ) : (
        !statusError && <span className="muted">{T.loadingStatus}</span>
      )}
    </div>
  );
}
