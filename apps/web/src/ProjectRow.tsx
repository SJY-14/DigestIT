// One project row, shared by the project panel (P4, ProjectPanel.tsx) and the All-projects view
// (P7, AllProjects.tsx) — decision-2.md §2: "the row is P4's project-panel row component, not a
// second design". `headline` is present only in the All-projects view; `remove` is present only in
// the project panel (All-projects hides it via a prop, not a fork). The current project's row is
// marked with the accent bar, the same pattern styles.css's `.commit[aria-current='true']` and
// DigestPicker's `.digest-row-main[aria-current='true']` already use, not a background tint alone.
import { projectsCopy, type Lang } from './copy.js';
import { relativeTime } from './format.js';
import { renderProse } from './prose.js';
import type { UnreadState } from './unread.js';

export type RemoveState = 'idle' | 'confirm' | 'removing';

export interface ProjectRowRemoveProps {
  state: RemoveState;
  error: string | null;
  onClick: () => void;
}

export interface ProjectRowProps {
  project: { id: number; name: string; lastCheckpointAt: string | null };
  current: boolean;
  unread: UnreadState;
  onSelect: () => void;
  /** All-projects only: the newest digest's L0 headline, or a placeholder for "caught up"/no
   * digest yet. Omitted in the project panel, which has no room for it. */
  headline?: string;
  /** All-projects only: dims the row once nothing is unread, so the roster stays a complete list
   * without every caught-up row competing visually with the ones that need attention. */
  quiet?: boolean;
  /** Project-panel only: omitted in the All-projects view (row-removal belongs to the switcher's
   * management context, not the triage view). */
  remove?: ProjectRowRemoveProps;
  lang?: Lang;
}

export function ProjectRow({ project, current, unread, onSelect, headline, quiet, remove, lang = 'en' }: ProjectRowProps) {
  const T = projectsCopy(lang);
  const activity = project.lastCheckpointAt ? T.lastActivity(relativeTime(project.lastCheckpointAt, Date.now(), lang)) : T.noActivity;
  return (
    <li className={quiet ? 'proj-row caught-up' : 'proj-row'}>
      <button
        type="button"
        className="proj-row-main"
        aria-current={current ? 'true' : undefined}
        data-project-id={project.id}
        onClick={onSelect}
      >
        <span className="proj-main">
          <span className="proj-name">{project.name}</span>
          <span className="proj-meta">{activity}</span>
          {headline !== undefined && <span className="proj-headline">{renderProse(headline)}</span>}
        </span>
        {unread.kind !== 'none' && (
          <span className="badge unread proj-unread">{unread.kind === 'new' ? T.unreadNew : T.unreadCount(unread.n)}</span>
        )}
      </button>
      {remove && (
        <button
          type="button"
          className="proj-remove"
          title={T.removeTitle(project.name)}
          disabled={remove.state === 'removing'}
          onClick={remove.onClick}
        >
          {remove.state === 'removing' ? T.removing : remove.state === 'confirm' ? T.removeConfirmLabel : T.removeLabel}
        </button>
      )}
      {remove?.error && <p role="alert" className="error proj-remove-error">{remove.error}</p>}
    </li>
  );
}
