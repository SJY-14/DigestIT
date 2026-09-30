// All projects (UX cycle 2 P7, decision-2.md §2): route /projects, shown in the nav only once 2+
// projects are registered (App.tsx). Reuses the project panel's row component (ProjectRow.tsx) —
// "the row is P4's project-panel row component, not a second design" — with Remove hidden (it
// belongs to the switcher's management context, not this triage view) and the newest digest's L0
// headline added. Sorted unread-first, then most-recent; a caught-up project still appears, just
// visually quieter, so the list is a complete roster rather than a worry list.
import { useCallback, useEffect, useState } from 'react';
import type { ProjectDto } from '@digestit/core';
import { fetchProjects } from './v2Api.js';
import { startLive } from './liveClient.js';
import { getLastSeen } from './storage.js';
import { computeUnread, type UnreadState } from './unread.js';
import { ProjectRow } from './ProjectRow.js';
import { headerCopy, projectsCopy, setupCopy, type Lang } from './copy.js';

export interface ProjectRowData {
  project: ProjectDto;
  unread: UnreadState;
}

/** Unread-first, then newest activity (decision-2.md §2) — the same tie-break style as MainV2's
 * `defaultProject`: a plain ISO-string compare, null-safe. */
export function sortAllProjects(rows: readonly ProjectRowData[]): ProjectRowData[] {
  return [...rows].sort((a, b) => {
    const aUnread = a.unread.kind !== 'none';
    const bUnread = b.unread.kind !== 'none';
    if (aUnread !== bUnread) return aUnread ? -1 : 1;
    return (b.project.lastCheckpointAt ?? '').localeCompare(a.project.lastCheckpointAt ?? '');
  });
}

/** What the row shows in place of a live headline: the newest digest's L0 line while there is
 * unread work to show for it, a quiet placeholder once the project is caught up or has no digest
 * yet — never a stale headline next to a "you've seen this" row. */
export function rowHeadline(project: ProjectDto, unread: UnreadState, lang: Lang): string {
  const T = projectsCopy(lang);
  if (unread.kind === 'none') return project.latestDigest ? T.caughtUp : T.noDigestsYet;
  return project.latestDigest?.headline ?? T.noHeadlineYet;
}

export interface AllProjectsProps {
  /** Opens `project` on its newest digest (or first run, when `digestId` is null) — App.tsx
   * pushes `/?project=&digest=` and switches to Home. */
  onOpenProject: (projectId: number, digestId: number | null) => void;
  lang?: Lang;
}

export function AllProjects({ onOpenProject, lang = 'en' }: AllProjectsProps) {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchProjects().then(setProjects, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    refresh();
    return startLive({ onChange: refresh, onTransport: () => undefined });
  }, [refresh]);

  const T = projectsCopy(lang);
  if (error) return <p role="alert" className="error">{setupCopy(lang).projectsLoadError(error)}</p>;
  if (projects === null) return <p className="muted">{headerCopy(lang).loadingStatus}</p>;

  const rows = sortAllProjects(projects.map((project) => ({ project, unread: computeUnread(project, getLastSeen(project.id)) })));
  const needAttention = rows.filter((r) => r.unread.kind !== 'none').length;

  return (
    <div className="all-projects">
      <div className="inbox-head">
        <h1>{T.allProjectsHeading(rows.length, needAttention)}</h1>
        <p>{T.allProjectsSubheading}</p>
      </div>
      <ul className="proj-list all-projects-list">
        {rows.map(({ project, unread }) => (
          <ProjectRow
            key={project.id}
            project={project}
            current={false}
            unread={unread}
            headline={rowHeadline(project, unread, lang)}
            quiet={unread.kind === 'none'}
            onSelect={() => onOpenProject(project.id, project.latestDigest?.id ?? null)}
            lang={lang}
          />
        ))}
      </ul>
    </div>
  );
}
