import { useEffect, useRef, useState } from 'react';
import {
  fetchUnit, postUiEvent,
  type Level, type UnitState, type WorkUnitDetail, type WorkUnitMember, type WorkUnitSummary,
} from './api.js';
import { formatDate, relativeTime, shortSha } from './format.js';
import { unitText, type ReviewState } from './feed.js';
import { Panel } from './Panel.js';

// All generated text is rendered as React text nodes (escaped), never as HTML.

const STATE_LABEL: Record<UnitState, string> = { active: 'Active', handoff: 'Handoff', merged: 'Merged' };

export function StateBadge({ state }: { state: UnitState }) {
  return <span className={`badge state-${state}`}><span className="dot" aria-hidden="true" />{STATE_LABEL[state]}</span>;
}

export function UnreadBadge() {
  return <span className="badge unread">New</span>;
}

export function DirtyChip({ unit }: { unit: WorkUnitSummary }) {
  const d = unit.dirty;
  if (d.length === 0) return null;
  const files = d.reduce((n, x) => n + x.files, 0);
  const add = d.reduce((n, x) => n + x.additions, 0);
  const del = d.reduce((n, x) => n + x.deletions, 0);
  return (
    <span className="stats" title="Uncommitted changes in a worktree on this branch">
      in progress: {files} {files === 1 ? 'file' : 'files'} <span className="add">+{add}</span> <span className="del">−{del}</span>
    </span>
  );
}

function useMembers(unit: WorkUnitSummary, enabled: boolean) {
  const [s, setS] = useState<{ key: string; members: WorkUnitMember[] | null; error: string | null }>({ key: '', members: null, error: null });
  const key = `${unit.id}:${unit.tipSha}:${unit.commitCount}`;
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    fetchUnit(unit.key, unit.repoId, ac.signal).then(
      (d) => !ac.signal.aborted && setS({ key, members: d.members, error: null }),
      (e: unknown) => !ac.signal.aborted && setS({ key, members: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => ac.abort();
  }, [enabled, key, unit.key, unit.repoId]);
  return s.key === key ? s : { key, members: null, error: null };
}

function Members({ unit, onOpenCommit }: { unit: WorkUnitSummary; onOpenCommit: (m: WorkUnitMember) => void }) {
  const { members, error } = useMembers(unit, true);
  if (error) return <p role="alert" className="error member-note">Could not load commits: {error}</p>;
  if (!members) return <p className="muted member-note">Loading…</p>;
  return (
    <ul className="members" aria-label={`Commits in ${unit.key}`}>
      {members.map((m) => (
        <li key={m.sha}>
          <button type="button" className="member" onClick={() => onOpenCommit(m)} disabled={m.changeId === null}>
            <code className="sha">{shortSha(m.sha)}</code>
            <span className="member-title">{m.title}</span>
            <span className="muted">{m.authorName} · <time dateTime={m.committedAt} title={formatDate(m.committedAt)}>{relativeTime(m.committedAt)}</time></span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function UnitRow({ unit, review, selected, compact, onSelect, onOpenCommit }: {
  unit: WorkUnitSummary;
  review?: ReviewState | undefined;
  selected: boolean;
  compact?: boolean;
  onSelect: (u: WorkUnitSummary) => void;
  onOpenCommit: (m: WorkUnitMember) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = unitText(unit);
  return (
    <li className={`unit state-${unit.state}`} data-unit={unit.key}>
      <div className="unit-line">
        <button
          type="button"
          className="expander"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} ${unit.commitCount} commits of ${unit.key}`}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        <button
          type="button"
          className="unit-main"
          aria-current={selected ? 'true' : undefined}
          onClick={() => onSelect(unit)}
        >
          <span className="label-line">
            {review?.unread && <UnreadBadge />}
            <span className={label.explained ? 'label' : 'label pending'}>{label.text}</span>
          </span>
          <span className="meta">
            <StateBadge state={unit.state} />
            <span className="key">{unit.key}</span>
            <span>{unit.commitCount} {unit.commitCount === 1 ? 'commit' : 'commits'}</span>
            <time dateTime={unit.lastCommitAt} title={formatDate(unit.lastCommitAt)}>{relativeTime(unit.lastCommitAt)}</time>
            {review?.decidedBy === 'reviewed' && <span>reviewed</span>}
            {unit.pendingBudget && <span className="pending-chip">pending (budget)</span>}
            {!compact && <DirtyChip unit={unit} />}
          </span>
        </button>
      </div>
      {open && <Members unit={unit} onOpenCommit={onOpenCommit} />}
    </li>
  );
}

export function UnitList({ units, reviews, selectedId, compact, onSelect, onOpenCommit, label }: {
  units: WorkUnitSummary[];
  reviews: Map<number, ReviewState>;
  selectedId: number | null;
  compact?: boolean;
  onSelect: (u: WorkUnitSummary) => void;
  onOpenCommit: (m: WorkUnitMember) => void;
  label: string;
}) {
  return (
    <ul className="units" aria-label={label}>
      {units.map((u) => (
        <UnitRow key={u.id} unit={u} review={reviews.get(u.id)} selected={selectedId === u.id} compact={compact} onSelect={onSelect} onOpenCommit={onOpenCommit} />
      ))}
    </ul>
  );
}

export function NewPill({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <div className="new-pill-slot" role="status" aria-live="polite">
      {count > 0 && (
        <button type="button" className="new-pill" onClick={onClick}>
          {count} new
        </button>
      )}
    </div>
  );
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function Rollup({ content }: { content: unknown }) {
  const c = rec(content);
  const l0 = rec(c.l0).text;
  const bullets = Array.isArray(rec(c.l1).bullets) ? (rec(c.l1).bullets as unknown[]).filter(isStr) : [];
  if (!isStr(l0)) return null;
  return (
    <div className="rollup">
      <p className="l0">{l0}</p>
      {bullets.length > 0 && <ul>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
    </div>
  );
}

const MIN_VIEW_MS = 500;

/** Sends `level_viewed` with the time spent when the level or unit changes (or the panel closes). */
function useLevelTracking(unitId: number, changeId: number | null, level: Level) {
  useEffect(() => {
    if (changeId === null) return;
    const t0 = Date.now();
    return () => {
      const ms = Date.now() - t0;
      if (ms < MIN_VIEW_MS) return; // StrictMode's simulated unmount and flicks through tabs are not views
      void postUiEvent({ kind: 'level_viewed', workUnitId: unitId, changeId, level, ms });
    };
  }, [unitId, changeId, level]);
}

/** Sends `opened` once per unit opened (StrictMode's double effect is deduped by the ref). */
function useOpened(unitId: number, onSent: () => void) {
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (last.current === unitId) return;
    last.current = unitId;
    void postUiEvent({ kind: 'opened', workUnitId: unitId }).then((ok) => ok && onSent());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId]);
}

export function UnitPanel({ unit, review, level, onLevel, onClose, onEvent }: {
  unit: WorkUnitSummary;
  review?: ReviewState | undefined;
  level: Level;
  onLevel: (l: Level) => void;
  onClose: () => void;
  /** Called after an event was recorded so unread/decided state can be refetched. */
  onEvent: () => void;
}) {
  const changeId = unit.latestRangeUnitId;
  const [detail, setDetail] = useState<WorkUnitDetail | null>(null);
  const [marking, setMarking] = useState<'idle' | 'busy' | 'failed'>('idle');
  useOpened(unit.id, onEvent);
  useLevelTracking(unit.id, changeId, level);
  useEffect(() => {
    const ac = new AbortController();
    setDetail(null);
    fetchUnit(unit.key, unit.repoId, ac.signal).then((d) => !ac.signal.aborted && setDetail(d), () => undefined);
    return () => ac.abort();
  }, [unit.key, unit.repoId, unit.tipSha]);

  const reviewed = review?.decidedBy === 'reviewed';
  const mark = async () => {
    setMarking('busy');
    const ok = await postUiEvent({ kind: 'reviewed', workUnitId: unit.id, ...(changeId !== null ? { changeId } : {}) });
    setMarking(ok ? 'idle' : 'failed');
    if (ok) onEvent();
  };
  const stale = detail?.explanation?.stale === true;

  return (
    <Panel
      changeId={changeId}
      sha={unit.tipSha ?? ''}
      title={unitText(unit).text}
      level={level}
      onLevel={onLevel}
      onClose={onClose}
      emptyNote={unit.pendingBudget ? 'pending (budget): the daily explanation budget is used up; this unit is explained next.' : 'No range explanation yet. It is generated after a 15 min quiet period or when the unit merges.'}
    >
      <div className="unit-info">
        <div className="unit-facts">
          <StateBadge state={unit.state} />
          <span className="key">{unit.key}</span>
          <span className="muted">{unit.commitCount} {unit.commitCount === 1 ? 'commit' : 'commits'}</span>
          {unit.pendingBudget && <span className="pending-chip">pending (budget)</span>}
          <DirtyChip unit={unit} />
        </div>
        {stale && <p className="muted">This explanation predates the latest commits; a newer one is queued.</p>}
        <div className="unit-actions">
          {review?.decidedBy === 'merged' ? (
            <span className="muted">Merged into main, which counts as decided.</span>
          ) : (
            <button type="button" className="btn primary" disabled={reviewed || marking === 'busy'} onClick={() => void mark()}>
              {reviewed ? 'Reviewed ✓' : 'Mark reviewed'}
            </button>
          )}
          {marking === 'failed' && <span role="alert" className="error">Could not record; try again.</span>}
        </div>
      </div>
    </Panel>
  );
}
