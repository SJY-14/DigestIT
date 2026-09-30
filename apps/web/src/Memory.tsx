// "What DigestIT knows" (DIG-104, milestone 4 project memory). Route /memory?project=&digest=,
// spec order: docs/ux/decision-4-memory.md (CTO decision, changes 1-11), then
// docs/ux/brief-4-memory.md, prototype docs/ux/proto/memory/index.html (fixtures only). A plain
// document reusing `.area-cards`-style hairline rows (brief §3), not a grid of cards.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AboutDto, MemoryItemDto, MemoryKind, MemoryTrigger, MemoryUsedItemDto, NoteMemory, ProjectDto,
} from '@digestit/core';
import {
  apiErrorMessage, headerCopy, humanDateTime, memoryCopy, readerCopy, memoryKindLabel, memoryKindNoun, memorySourceBadge,
  memoryTriggerLabel, plural, type Lang,
} from './copy.js';
import { relativeTime } from './format.js';
import { renderProse } from './prose.js';
import {
  ApiError, clearProjectMemory, correctMemoryItem, fetchAbout, fetchMemory, fetchMemoryUsed, fetchProjects,
  memoryExportUrl, patchMemoryItem, rollbackMemory, setMemorySummariesEnabled, type MemoryListDto,
} from './v2Api.js';

const KINDS: readonly MemoryKind[] = ['area', 'term', 'thread', 'note'];
const SHOW_ALL_CAP = 20;

function errorText(e: unknown, lang: Lang): string {
  return e instanceof ApiError ? apiErrorMessage(e.message, lang) : e instanceof Error ? e.message : String(e);
}

/** decision-4-memory.md change 11: a 401 always shows the existing `unauthorized` copy alone (it
 * means "your session expired", not "this particular action failed"); every other error shows the
 * action's own retryable message. */
function actionErrorText(e: unknown, lang: Lang, wrap: (msg: string) => string): string {
  if (e instanceof ApiError && e.status === 401) return apiErrorMessage('unauthorized', lang);
  return wrap(errorText(e, lang));
}

/** "pinned, then stale, then by usedInDigests descending, then key" (decision-4-memory.md change 5). */
export function sortMemoryItems<T extends MemoryItemDto>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aStale = a.status === 'stale';
    const bStale = b.status === 'stale';
    if (aStale !== bStale) return aStale ? -1 : 1;
    if (a.usedInDigests !== b.usedInDigests) return b.usedInDigests - a.usedInDigests;
    return a.key.localeCompare(b.key);
  });
}

/** Everything a text filter should match, across every kind — including collapsed rows (the
 * filter searches all rows, decision-4-memory.md change 5), so this never depends on what the
 * "Show all" cap currently renders. Code identifiers stay as-is (copy.ts's own rule: never
 * translated), which is also exactly what a user typing a symbol name wants to match. */
export function memoryItemSearchText(item: MemoryItemDto): string {
  const c = item.content;
  switch (c.kind) {
    case 'area': return [c.path, c.doc, c.summary, ...c.exports.map((e) => e.name)].filter(Boolean).join(' ');
    case 'term': return [c.term, c.meaning].filter(Boolean).join(' ');
    case 'thread': return [c.title, c.summary, ...c.areas, ...c.terms].filter(Boolean).join(' ');
    case 'note': return c.text;
    default: return '';
  }
}

export function filterMemoryItems<T extends MemoryItemDto>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((it) => memoryItemSearchText(it).toLowerCase().includes(q));
}

function memoryItemTitle(item: MemoryItemDto, lang: Lang): string {
  const T = memoryCopy(lang);
  const c = item.content;
  switch (c.kind) {
    case 'area': return c.path || '/';
    case 'term': return c.term;
    case 'thread': return c.title;
    case 'note': return (c as NoteMemory).origin === 'correction' ? T.noteTitleCorrection : T.noteTitleContextFile;
    default: return item.key;
  }
}

/** One line of derived text under the title (brief §3's row anatomy). `null` when a kind has
 * nothing worth showing (e.g. a term with no meaning yet). */
function memoryItemEffect(item: MemoryItemDto, lang: Lang): string | null {
  const T = memoryCopy(lang);
  const c = item.content;
  if (c.kind === 'area') {
    if (c.summary) return c.summary;
    if (c.doc) return c.doc;
    if (c.exports.length === 0) return null;
    const names = c.exports.slice(0, 3).map((e) => e.name).join(', ');
    const more = c.exports.length > 3 ? ` (+${c.exports.length - 3})` : '';
    return `${names}${more}`;
  }
  if (c.kind === 'term') return c.meaning;
  if (c.kind === 'thread') {
    const areas = c.areas.join(', ');
    const state = c.state === 'open' ? T.threadStateOpen : T.threadStateClosed;
    return `${areas ? `${areas} · ` : ''}${plural(c.digests.length, 'digest')} · ${state}`;
  }
  return c.text;
}

/** The badge's second segment (brief §4), which differs by kind: an area shows when it was last
 * checked, a term shows where it is defined, a thread and a note show nothing extra here. */
function sourceMetaSuffix(item: MemoryItemDto, lang: Lang, now: number): string | null {
  const T = memoryCopy(lang);
  if (item.source === 'code' && item.content.kind === 'area') return T.checkedAgo(relativeTime(item.confirmedAt, now, lang));
  if (item.source === 'code' && item.content.kind === 'term' && item.content.definedAt) return item.content.definedAt.file;
  return null;
}

interface RowActions {
  onPin: (item: MemoryItemDto) => void;
  onDeleteStep: (item: MemoryItemDto) => void;
  onRestore: (item: MemoryItemDto) => void;
  onOpenCorrect: (item: MemoryItemDto) => void;
  onOpenEdit: (item: MemoryItemDto) => void;
  onCloseForm: (focusId: number) => void;
  onSubmitForm: (item: MemoryItemDto) => void;
  onFormTextChange: (text: string) => void;
  onScrollToItem: (id: number) => void;
}

interface RowState {
  busy?: 'pin' | 'delete-confirm' | 'deleting' | 'restoring';
  error?: string;
}

export interface UsedForBadge {
  part: 'summary' | 'area' | 'walkthrough';
  area: string | null;
}

function usedForLabel(u: UsedForBadge, lang: Lang): string {
  const T = memoryCopy(lang);
  if (u.part === 'summary') return T.usedForSummary;
  if (u.part === 'walkthrough') return T.usedForWalkthrough(u.area ?? '');
  return T.usedForArea(u.area ?? '');
}

interface RowProps {
  item: MemoryItemDto;
  lang: Lang;
  now: number;
  mode: 'active' | 'hidden' | 'used';
  usedFor?: UsedForBadge[];
  changedSince?: boolean;
  overriddenByItem?: MemoryItemDto | null;
  correctsTarget?: MemoryItemDto | null;
  state: RowState;
  actions: RowActions;
  formOpen: boolean;
  formText: string;
  formSaving: boolean;
  formError: string | null;
  correctButtonRef: (el: HTMLButtonElement | null) => void;
}

function MemoryRow({
  item, lang, now, mode, usedFor, changedSince, overriddenByItem, correctsTarget, state, actions, formOpen, formText,
  formSaving, formError, correctButtonRef,
}: RowProps) {
  const T = memoryCopy(lang);
  const title = memoryItemTitle(item, lang);
  const effect = memoryItemEffect(item, lang);
  const suffix = sourceMetaSuffix(item, lang, now);
  const isMonoTitle = item.kind === 'term';
  const isContextNote = item.kind === 'note' && (item.content as NoteMemory).origin === 'context-md';
  const canCorrect = item.kind !== 'note' && mode !== 'hidden';
  // Notes from the context file have no Edit (decision-4-memory.md change 7): the server's PATCH
  // does not itself distinguish origin, so this is a UI-only restriction, not an API guarantee.
  const canEdit = item.kind === 'note' && item.source === 'user' && !isContextNote && mode !== 'hidden';

  const footParts: string[] = [];
  if (item.pinned) footParts.push(T.pinnedMeta);
  if (item.usedInDigests > 0) footParts.push(T.usedInDigests(item.usedInDigests));

  return (
    <li id={`mem-item-${item.id}`} tabIndex={-1} className={item.status === 'stale' ? 'mem-item is-stale' : 'mem-item'} aria-live="polite">
      <div className="mem-item-row">
        <span className={isMonoTitle ? 'mem-item-title mono' : 'mem-item-title'}>{title}</span>
        {mode === 'hidden' ? (
          <span className="mem-item-source">{T.hiddenDeletedAt(relativeTime(item.updatedAt, now, lang))}</span>
        ) : overriddenByItem && mode === 'used' ? (
          // The note is not in this digest's list, so there is nothing on this page to jump to.
          <span className="mem-item-source">{T.overriddenByLabel}</span>
        ) : overriddenByItem ? (
          <a className="mem-item-source" href={`#mem-item-${overriddenByItem.id}`} onClick={() => actions.onScrollToItem(overriddenByItem.id)}>
            {T.overriddenByLabel} <span aria-hidden="true">→</span>
          </a>
        ) : (
          <span className="mem-item-source">
            {memorySourceBadge(item.source, lang)}
            {suffix ? ` · ${suffix}` : null}
            {isContextNote && <> · {T.contextFileHint}</>}
            {correctsTarget && (
              <>
                {' · '}
                <a href={`#mem-item-${correctsTarget.id}`} onClick={() => actions.onScrollToItem(correctsTarget.id)}>
                  {T.correctsLabel(memoryKindNoun(correctsTarget.kind, lang), memoryItemTitle(correctsTarget, lang))} <span aria-hidden="true">↑</span>
                </a>
              </>
            )}
          </span>
        )}
      </div>
      {mode !== 'hidden' && item.status === 'stale' && <p className="mem-item-status">{T.staleStatus}</p>}
      {overriddenByItem && effect && <p className="mem-item-override-text">{renderProse(effect)}</p>}
      {!overriddenByItem && effect && <p className="mem-item-effect">{renderProse(effect)}</p>}
      {mode === 'used' && usedFor && usedFor.length > 0 && (
        <div className="mem-used-tags">
          {usedFor.map((u, i) => <span key={i} className="mem-used-tag">{usedForLabel(u, lang)}</span>)}
          {changedSince && <span className="mem-used-tag">{T.changedSinceDigest}</span>}
        </div>
      )}
      <div className="mem-item-foot">
        <span>{footParts.join(' · ')}</span>
        <div className="mem-item-actions">
          {mode === 'hidden' ? (
            <button type="button" disabled={state.busy === 'restoring'} onClick={() => actions.onRestore(item)}>
              {state.busy === 'restoring' ? T.restoring : T.restore}
            </button>
          ) : (
            <>
              {canCorrect && (
                <button type="button" ref={correctButtonRef} onClick={() => actions.onOpenCorrect(item)}>{T.correct}</button>
              )}
              {canEdit && (
                <button type="button" ref={correctButtonRef} onClick={() => actions.onOpenEdit(item)}>{T.edit}</button>
              )}
              <button type="button" disabled={state.busy === 'pin'} onClick={() => actions.onPin(item)}>
                {item.pinned ? T.unpin : T.pin}
              </button>
              {mode !== 'used' && (
                <button
                  type="button"
                  className="danger"
                  disabled={state.busy === 'deleting'}
                  onClick={() => actions.onDeleteStep(item)}
                >
                  {state.busy === 'deleting' ? T.deleting : state.busy === 'delete-confirm' ? T.deleteConfirmLabel : T.delete}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {state.error && <p role="alert" className="error">{state.error}</p>}
      {formOpen && (
        <CorrectForm
          lang={lang}
          text={formText}
          saving={formSaving}
          error={formError}
          onChange={actions.onFormTextChange}
          onCancel={() => actions.onCloseForm(item.id)}
          onSave={() => actions.onSubmitForm(item)}
        />
      )}
    </li>
  );
}

function CorrectForm({
  lang, text, saving, error, onChange, onCancel, onSave,
}: {
  lang: Lang; text: string; saving: boolean; error: string | null;
  onChange: (t: string) => void; onCancel: () => void; onSave: () => void;
}) {
  const T = memoryCopy(lang);
  const max = 2000;
  return (
    <div className="mem-correct-box">
      <label htmlFor="mem-correct-text">{T.correctFormLabel}</label>
      <textarea
        id="mem-correct-text"
        value={text}
        maxLength={max}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      />
      <div className="mem-correct-meta">
        <span className="muted">{T.correctCounter(text.length, max)}</span>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="mem-correct-actions">
        <button type="button" className="btn quiet" onClick={onCancel} disabled={saving}>{T.cancel}</button>
        <button type="button" className="btn primary" onClick={onSave} disabled={saving || text.trim().length === 0}>
          {saving ? T.saving : T.save}
        </button>
      </div>
    </div>
  );
}

interface TwoStepProps {
  label: string;
  confirmLabel: string;
  busyLabel: string;
  state: 'idle' | 'confirm' | 'busy';
  error: string | null;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}

function TwoStepButton({ label, confirmLabel, busyLabel, state, error, disabled, className, onClick }: TwoStepProps) {
  return (
    <span aria-live="polite">
      <button type="button" className={className} disabled={disabled || state === 'busy'} onClick={onClick}>
        {state === 'busy' ? busyLabel : state === 'confirm' ? confirmLabel : label}
      </button>
      {error && <p role="alert" className="error">{error}</p>}
    </span>
  );
}

export interface MemoryPageProps {
  /** Opens the digest reader on `projectId`/`digestId` (App.tsx's `openProject`, the same target
   * All-projects rows use) — used by the breadcrumb and the "Back to digest" link. */
  onOpenDigest: (projectId: number, digestId: number | null) => void;
  lang?: Lang;
}

/** Reads `?project=&digest=` straight off the URL (this page is mounted directly under App.tsx,
 * the same level as AllProjects, so there is no parent-owned URL state to thread through). */
function readQuery(): { project: number | null; digest: number | null } {
  const q = new URLSearchParams(location.search);
  const project = q.get('project');
  const digest = q.get('digest');
  return {
    project: project !== null && /^\d+$/.test(project) ? Number(project) : null,
    digest: digest !== null && /^\d+$/.test(digest) ? Number(digest) : null,
  };
}

export function MemoryPage({ onOpenDigest, lang: chromeLang = 'en' }: MemoryPageProps) {
  const [{ project: projectId, digest: digestId }] = useState(readQuery);
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [about, setAbout] = useState<AboutDto | null>(null);
  const [list, setList] = useState<MemoryListDto | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [usedItems, setUsedItems] = useState<MemoryUsedItemDto[] | null>(null);
  const [usedDropped, setUsedDropped] = useState(0);
  const [usedError, setUsedError] = useState<string | null>(null);

  const [tab, setTab] = useState<'active' | 'hidden'>('active');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<MemoryKind>>(new Set());

  const [formItemId, setFormItemId] = useState<number | null>(null);
  const [formMode, setFormMode] = useState<'correct' | 'edit'>('correct');
  const [formText, setFormText] = useState('');
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});
  const [undoState, setUndoState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [undoError, setUndoError] = useState<string | null>(null);
  const [clearState, setClearState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [clearError, setClearError] = useState<string | null>(null);
  const [summariesSaving, setSummariesSaving] = useState(false);
  const [summariesError, setSummariesError] = useState<string | null>(null);

  const buttonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  // Where focus goes once the next refresh has rendered (an element id): the new note after
  // Correct → Save (decision-4-memory.md change 6), the next row after Delete/Restore removes the
  // current one, the page title after Clear. Without this, focus falls back to <body>.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  const project = projects?.find((p) => p.id === projectId) ?? null;
  const lang: Lang = project?.language ?? chromeLang;
  const T = memoryCopy(lang);
  const H = headerCopy(lang);

  const refreshList = useCallback((id: number) => {
    fetchMemory(id).then(
      (dto) => { setList(dto); setListError(null); },
      (e: unknown) => setListError(errorText(e, lang)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchProjects(ac.signal).then(setProjects, () => undefined);
    fetchAbout(ac.signal).then(setAbout, () => undefined);
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (projectId === null) return;
    refreshList(projectId);
  }, [projectId, refreshList]);

  const loadUsed = useCallback((id: number, signal?: AbortSignal) => {
    fetchMemoryUsed(id, signal).then(
      (dto) => { setUsedItems(dto.items); setUsedDropped(dto.droppedForBudget); setUsedError(null); },
      (e: unknown) => { if (!signal?.aborted) setUsedError(errorText(e, lang)); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (digestId === null) return;
    const ac = new AbortController();
    loadUsed(digestId, ac.signal);
    return () => ac.abort();
  }, [digestId, loadUsed]);

  // After a write: the per-digest view renders `usedItems`, not `list`, so it needs its own
  // re-fetch or Pin/Unpin and Correct would never show there.
  const refresh = useCallback((id: number) => {
    refreshList(id);
    if (digestId !== null) loadUsed(digestId);
  }, [refreshList, loadUsed, digestId]);

  useEffect(() => {
    if (pendingFocus === null) return;
    const el = document.getElementById(pendingFocus);
    if (el) { el.focus(); setPendingFocus(null); }
  }, [pendingFocus, list, usedItems]);

  /** The row after `id` in its list (else the one before), so focus has somewhere to land when
   * Delete or Restore takes `id` out of the current list; the page title if it was the last one. */
  const focusTargetAfterRemoving = (id: number): string => {
    const li = document.getElementById(`mem-item-${id}`);
    const next = (li?.nextElementSibling ?? li?.previousElementSibling) as HTMLElement | null | undefined;
    return next?.id || 'mem-title';
  };

  const closeForm = useCallback((focusId: number) => {
    setFormItemId(null);
    setFormText('');
    setFormError(null);
    buttonRefs.current.get(focusId)?.focus();
  }, []);

  const openCorrect = useCallback((item: MemoryItemDto) => {
    setFormItemId(item.id);
    setFormMode('correct');
    setFormText('');
    setFormError(null);
  }, []);

  const openEdit = useCallback((item: MemoryItemDto) => {
    setFormItemId(item.id);
    setFormMode('edit');
    setFormText((item.content as NoteMemory).text);
    setFormError(null);
  }, []);

  const submitForm = useCallback((item: MemoryItemDto) => {
    if (projectId === null) return;
    setFormSaving(true);
    setFormError(null);
    const req = formMode === 'correct' ? correctMemoryItem(item.id, formText) : patchMemoryItem(item.id, { text: formText });
    req.then(
      (saved) => {
        setFormSaving(false);
        if (formMode === 'correct' && digestId === null) {
          // Change 6: focus moves to the new note (the per-digest view doesn't list it, so there
          // it returns to the Correct button like Cancel does).
          setFormItemId(null);
          setFormText('');
          setPendingFocus(`mem-item-${saved.id}`);
        } else {
          closeForm(item.id);
        }
        refresh(projectId);
      },
      (e: unknown) => { setFormSaving(false); setFormError(actionErrorText(e, lang, T.correctError)); },
    );
  }, [projectId, digestId, formMode, formText, closeForm, refresh, lang]);

  const setRowState = (id: number, patch: RowState | null) => {
    setRowStates((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[id];
      else next[id] = { ...next[id], ...patch };
      return next;
    });
  };

  const onPin = useCallback((item: MemoryItemDto) => {
    if (projectId === null) return;
    setRowState(item.id, { busy: 'pin' });
    patchMemoryItem(item.id, { pinned: !item.pinned }).then(
      () => { setRowState(item.id, null); refresh(projectId); },
      (e: unknown) => setRowState(item.id, { busy: undefined, error: actionErrorText(e, lang, T.pinError) }),
    );
  }, [projectId, refresh, lang, T]);

  const onDeleteStep = useCallback((item: MemoryItemDto) => {
    const current = rowStates[item.id]?.busy;
    if (current !== 'delete-confirm') { setRowState(item.id, { busy: 'delete-confirm' }); return; }
    if (projectId === null) return;
    setRowState(item.id, { busy: 'deleting' });
    patchMemoryItem(item.id, { status: 'hidden' }).then(
      () => { setRowState(item.id, null); setPendingFocus(focusTargetAfterRemoving(item.id)); refresh(projectId); },
      (e: unknown) => setRowState(item.id, { busy: undefined, error: actionErrorText(e, lang, T.deleteError) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowStates, projectId, refresh, lang, T]);

  const onRestore = useCallback((item: MemoryItemDto) => {
    if (projectId === null) return;
    setRowState(item.id, { busy: 'restoring' });
    patchMemoryItem(item.id, { status: 'active' }).then(
      () => { setRowState(item.id, null); setPendingFocus(focusTargetAfterRemoving(item.id)); refresh(projectId); },
      (e: unknown) => setRowState(item.id, { busy: undefined, error: actionErrorText(e, lang, T.restoreError) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refresh, lang, T]);

  const scrollToItem = useCallback((id: number) => {
    document.getElementById(`mem-item-${id}`)?.focus();
  }, []);

  const rowActions: RowActions = {
    onPin, onDeleteStep, onRestore, onOpenCorrect: openCorrect, onOpenEdit: openEdit, onCloseForm: closeForm,
    onSubmitForm: submitForm, onFormTextChange: setFormText, onScrollToItem: scrollToItem,
  };

  const onToggleSummaries = useCallback(() => {
    if (projectId === null || !list) return;
    setSummariesSaving(true);
    setSummariesError(null);
    setMemorySummariesEnabled(projectId, !list.summariesEnabled).then(
      (overview) => { setList((prev) => (prev ? { ...prev, ...overview } : prev)); setSummariesSaving(false); },
      (e: unknown) => { setSummariesSaving(false); setSummariesError(actionErrorText(e, lang, T.settingsError)); },
    );
  }, [projectId, list, lang, T]);

  const onUndo = useCallback(() => {
    if (projectId === null) return;
    if (undoState !== 'confirm') { setUndoState('confirm'); return; }
    setUndoState('busy');
    setUndoError(null);
    rollbackMemory(projectId).then(
      () => { setUndoState('idle'); refreshList(projectId); },
      (e: unknown) => { setUndoState('idle'); setUndoError(actionErrorText(e, lang, T.undoError)); },
    );
  }, [projectId, undoState, refreshList, lang, T]);

  const onClear = useCallback(() => {
    if (projectId === null) return;
    if (clearState !== 'confirm') { setClearState('confirm'); return; }
    setClearState('busy');
    setClearError(null);
    clearProjectMemory(projectId).then(
      () => { setClearState('idle'); setPendingFocus('mem-title'); refreshList(projectId); },
      (e: unknown) => { setClearState('idle'); setClearError(actionErrorText(e, lang, T.clearError)); },
    );
  }, [projectId, clearState, refreshList, lang, T]);

  const now = Date.now();

  const visibleItems = useMemo(() => {
    if (!list) return [];
    // decision-4-memory.md change 10: the project's language plus items with no language of their own.
    return list.items.filter((it) => it.language === null || it.language === project?.language);
  }, [list, project]);

  const byId = useMemo(() => new Map(visibleItems.map((it) => [it.id, it])), [visibleItems]);
  const byKindKey = useMemo(() => new Map(visibleItems.map((it) => [`${it.kind}:${it.key}`, it])), [visibleItems]);

  const activeItems = visibleItems.filter((it) => it.status !== 'hidden');
  const hiddenItems = visibleItems.filter((it) => it.status === 'hidden');
  const countsByKind: Record<MemoryKind, number> = { area: 0, term: 0, thread: 0, note: 0 };
  for (const it of activeItems) countsByKind[it.kind]++;

  const shown = tab === 'active' ? activeItems : hiddenItems;
  const filtered = filterMemoryItems(shown, query);
  const grouped: Record<MemoryKind, MemoryItemDto[]> = { area: [], term: [], thread: [], note: [] };
  for (const it of filtered) grouped[it.kind].push(it);
  for (const k of KINDS) grouped[k] = sortMemoryItems(grouped[k]);

  const toggleExpand = (kind: MemoryKind) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  };

  if (projectId === null) return <p role="alert" className="error">{T.loadError('no project')}</p>;
  if (projects === null || list === null) {
    if (listError) return <p role="alert" className="error">{listError}</p>;
    return <p className="muted">{H.loadingStatus}</p>;
  }
  if (project === null) return <p role="alert" className="error">{T.loadError('not_found')}</p>;

  const isEmptyProject = list.lastBatch === null && visibleItems.length === 0;

  const renderRow = (item: MemoryItemDto, mode: 'active' | 'hidden') => {
    const note = item.kind === 'note' ? (item.content as NoteMemory) : null;
    const correctsTarget = note?.target ? byKindKey.get(`${note.target.kind}:${note.target.key}`) ?? null : null;
    const overriddenByItem = item.overriddenBy !== null ? byId.get(item.overriddenBy) ?? null : null;
    return (
      <MemoryRow
        key={item.id}
        item={item}
        lang={lang}
        now={now}
        mode={mode}
        overriddenByItem={overriddenByItem}
        correctsTarget={correctsTarget}
        state={rowStates[item.id] ?? {}}
        actions={rowActions}
        formOpen={formItemId === item.id}
        formText={formText}
        formSaving={formSaving}
        formError={formError}
        correctButtonRef={(el) => { if (el) buttonRefs.current.set(item.id, el); }}
      />
    );
  };

  return (
    <div className="mem-page">
      <nav className="breadcrumb" aria-label={readerCopy(lang).breadcrumbLabel}>
        <ol>
          <li><button type="button" className="crumb" onClick={() => onOpenDigest(project.id, digestId)}>{project.name}</button></li>
          <li><span className="crumb current" aria-current="location">{T.breadcrumbCurrent}</span></li>
        </ol>
      </nav>
      {digestId !== null && (
        <button type="button" className="back-link" onClick={() => onOpenDigest(project.id, digestId)}>
          <span aria-hidden="true">← </span>{T.backToDigest}
        </button>
      )}

      {digestId !== null ? (
        <div className="mem-head">
          <h1 id="mem-title" tabIndex={-1}>{usedError ? T.loadError(usedError) : usedItems === null ? H.loadingStatus : T.usedForHeading(usedItems.length)}</h1>
          {usedDropped > 0 && <p className="mem-usage">{T.droppedForBudget(usedDropped)}</p>}
        </div>
      ) : (
        <div className="mem-head">
          <h1 id="mem-title" tabIndex={-1}>{T.pageTitle(project.name)}</h1>
          {!isEmptyProject && (
            <>
              <div className="mem-summary">
                <span className="mem-counts">{T.countsSummary(countsByKind)}</span>
                <div className="mem-actions">
                  <a className="btn" href={memoryExportUrl(project.id)} download={`${project.name}-memory.json`}>{T.exportLabel}</a>
                  <TwoStepButton
                    label={T.clearLabel} confirmLabel={T.clearConfirmLabel} busyLabel={T.clearing}
                    state={clearState} error={clearError} className="btn quiet"
                    onClick={onClear}
                  />
                </div>
              </div>
              {clearState === 'confirm' && <p className="mem-confirm">{T.clearConfirmPrompt(project.name, list.items.length)}</p>}
              {list.lastBatch && (
                <p className="mem-lastbatch">
                  {T.lastUpdatedLine(memoryTriggerLabel(list.lastBatch.trigger as MemoryTrigger, lang), humanDateTime(list.lastBatch.startedAt, now, lang), list.lastBatch.changed)}
                  {' · '}
                  <TwoStepButton
                    label={T.undoLabel} confirmLabel={T.undoConfirmLabel} busyLabel={T.undoing}
                    state={undoState} error={undoError} disabled={list.lastBatch.rolledBack}
                    onClick={onUndo}
                  />
                </p>
              )}
              {undoState === 'confirm' && list.lastBatch && (
                <p className="mem-confirm">
                  {T.undoConfirmPrompt(memoryTriggerLabel(list.lastBatch.trigger as MemoryTrigger, lang), humanDateTime(list.lastBatch.startedAt, now, lang), list.lastBatch.changed)}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {digestId === null && (
        <div className="mem-panel">
          <p className="mem-privacy-top">{T.privacyTopLine(about?.provider ?? 'stub')}</p>
          <div className="mem-toggle-row">
            <span className="mem-toggle-label" id="mem-summaries-label">{T.summariesToggleLabel}</span>
            <button
              type="button"
              className="mem-switch"
              aria-pressed={list.summariesEnabled}
              aria-labelledby="mem-summaries-label"
              aria-describedby="mem-summaries-sends"
              disabled={summariesSaving}
              onClick={onToggleSummaries}
            />
          </div>
          <details className="mem-sends" id="mem-summaries-sends">
            <summary>{T.whatThisSends}</summary>
            <p>{T.whatThisSendsBody(about?.provider ?? 'stub', list.usage.share)}</p>
          </details>
          {summariesError && <p role="alert" className="error">{summariesError}</p>}
          <p className="mem-usage">{T.usageLine(list.usage.jobsToday, list.usage.share, list.usage.reserve)}</p>
        </div>
      )}

      {digestId === null && isEmptyProject && (
        <div className="mem-empty-page">
          <p>{T.emptyProject(project.name)}</p>
        </div>
      )}

      {digestId === null && !isEmptyProject && (
        <>
          <div className="mem-filter-bar">
            <div className="mem-tabs" role="tablist" aria-label={T.filterLabel}>
              <button type="button" className="mem-tab" role="tab" aria-selected={tab === 'active'} onClick={() => setTab('active')}>
                {T.activeTab}
              </button>
              <button type="button" className="mem-tab" role="tab" aria-selected={tab === 'hidden'} onClick={() => setTab('hidden')}>
                {T.hiddenTab(hiddenItems.length)}
              </button>
            </div>
            <input
              className="mem-filter-input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={T.filterPlaceholder}
              aria-label={T.filterLabel}
            />
          </div>

          {listError && <p role="alert" className="error">{listError}</p>}

          {tab === 'active' && KINDS.map((kind) => {
            const rows = grouped[kind];
            const isExpanded = expanded.has(kind);
            const visible = isExpanded ? rows : rows.slice(0, SHOW_ALL_CAP);
            return (
              <section className="mem-section" key={kind}>
                <h2>{memoryKindLabel(kind, lang)} ({countsByKind[kind]})</h2>
                {rows.length === 0 ? (
                  <p className="mem-empty">
                    {kind === 'thread' ? T.emptyThreads : kind === 'note' ? T.emptyNotes : null}
                  </p>
                ) : (
                  <>
                    <ul className="mem-list">{visible.map((item) => renderRow(item, 'active'))}</ul>
                    {rows.length > SHOW_ALL_CAP && !isExpanded && (
                      <button type="button" className="btn quiet" onClick={() => toggleExpand(kind)}>{T.showAllLabel(rows.length)}</button>
                    )}
                  </>
                )}
              </section>
            );
          })}

          {tab === 'hidden' && (
            <section className="mem-section">
              <ul className="mem-list">{sortMemoryItems(filtered).map((item) => renderRow(item, 'hidden'))}</ul>
            </section>
          )}
        </>
      )}

      {digestId !== null && usedItems && (
        <section className="mem-section">
          <ul className="mem-list">
            {usedItems.map((u) => (
              <MemoryRow
                key={u.id}
                item={u}
                lang={lang}
                now={now}
                mode="used"
                usedFor={u.usedFor}
                changedSince={u.usedVersion < u.version}
                overriddenByItem={u.overriddenBy !== null ? byId.get(u.overriddenBy) ?? null : null}
                state={rowStates[u.id] ?? {}}
                actions={rowActions}
                formOpen={formItemId === u.id}
                formText={formText}
                formSaving={formSaving}
                formError={formError}
                correctButtonRef={(el) => { if (el) buttonRefs.current.set(u.id, el); }}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
