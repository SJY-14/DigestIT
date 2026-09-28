// Reading flow (DIG-50, docs/ux-v3.md §1): the level switcher, the breadcrumb, and one focused
// view per level. L0 is the headline, L1 the impact bullets, L2 the area cards, L3 without an
// area an area picker (the walkthrough itself is in Walkthrough.tsx). MainV2 composes these.
import { useRef, type KeyboardEvent, type MouseEvent } from 'react';
import type { DigestDetailDto, DigestL2Item } from '@digestit/core';
import { LEVELS, READER as T, humanDateTime, plural } from './copy.js';
import type { ReadingLevel } from './v2Url.js';

export const LEVEL_TAB_ID = (l: ReadingLevel) => `level-tab-${l}`;
export const READING_PANE_ID = 'reading-pane';

// --- keys ----------------------------------------------------------------------------------------

export type ReaderKeyAction = { kind: 'level'; level: ReadingLevel } | { kind: 'step'; delta: 1 | -1 };

/** `0`–`3` pick a level, `n`/`p` move between walkthrough steps. Nothing while the user is typing
 * in a field, composing text, or holding a modifier (so browser shortcuts keep working). */
export function readerKey(e: Pick<globalThis.KeyboardEvent, 'key' | 'target' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>): ReaderKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null;
  const t = e.target as HTMLElement | null;
  if (t && (/^(input|textarea|select)$/i.test(t.tagName ?? '') || t.isContentEditable)) return null;
  if (e.key === '0' || e.key === '1' || e.key === '2' || e.key === '3') return { kind: 'level', level: Number(e.key) as ReadingLevel };
  if (e.key === 'n') return { kind: 'step', delta: 1 };
  if (e.key === 'p') return { kind: 'step', delta: -1 };
  return null;
}

// --- level switcher ------------------------------------------------------------------------------

const ALL_LEVELS: readonly ReadingLevel[] = [0, 1, 2, 3];

/** GitHub-style underline tabs; a WAI-ARIA tablist with arrow-key roving and automatic activation. */
export function LevelSwitcher({ level, onLevel }: { level: ReadingLevel; onLevel: (l: ReadingLevel) => void }) {
  const tabs = useRef(new Map<ReadingLevel, HTMLButtonElement>());
  const go = (l: ReadingLevel) => {
    onLevel(l);
    tabs.current.get(l)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const i = ALL_LEVELS.indexOf(level);
    const to = e.key === 'ArrowRight' ? ALL_LEVELS[(i + 1) % 4]
      : e.key === 'ArrowLeft' ? ALL_LEVELS[(i + 3) % 4]
        : e.key === 'Home' ? 0 : e.key === 'End' ? 3 : null;
    if (to === null || to === undefined) return;
    e.preventDefault();
    go(to);
  };
  return (
    <div className="level-switcher">
      <div role="tablist" aria-label={T.switcherLabel} className="level-tabs" onKeyDown={onKeyDown}>
        {ALL_LEVELS.map((l) => {
          const selected = l === level;
          return (
            <button
              key={l}
              ref={(el) => { if (el) tabs.current.set(l, el); else tabs.current.delete(l); }}
              type="button"
              role="tab"
              id={LEVEL_TAB_ID(l)}
              aria-selected={selected}
              aria-controls={READING_PANE_ID}
              tabIndex={selected ? 0 : -1}
              className="level-tab"
              onClick={() => onLevel(l)}
            >
              <span className="level-key">{LEVELS[l].key}</span> {LEVELS[l].label}
            </button>
          );
        })}
      </div>
      <span className="muted level-hint">{T.switcherHint}</span>
    </div>
  );
}

// --- breadcrumb ---------------------------------------------------------------------------------

export interface BreadcrumbProps {
  digest: Pick<DigestDetailDto, 'toAt'>;
  level: ReadingLevel;
  /** The open area (shown only at L3). */
  area: DigestL2Item | null;
  onDigest: () => void;
  onArea: () => void;
  onLevel: () => void;
}

/** `Digest · Today, 17:05 › <area> › L3 Code`; every segment is a button. */
export function Breadcrumb({ digest, level, area, onDigest, onArea, onLevel }: BreadcrumbProps) {
  const lv = LEVELS[level];
  const showArea = level === 3 && area !== null;
  return (
    <nav className="breadcrumb" aria-label={T.breadcrumbLabel}>
      <ol>
        <li><button type="button" className="crumb" onClick={onDigest}>{T.digestCrumb(humanDateTime(digest.toAt))}</button></li>
        {showArea && <li><button type="button" className="crumb" onClick={onArea}>{area.title}</button></li>}
        <li>
          <button type="button" className="crumb current" aria-current="location" onClick={onLevel}>
            {lv.key} {lv.label}
          </button>
        </li>
      </ol>
    </nav>
  );
}

// --- shared bits -------------------------------------------------------------------------------

export function Delta({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="stats"><span className="add">+{additions.toLocaleString('en-US')}</span> <span className="del">−{deletions.toLocaleString('en-US')}</span></span>;
}

export function areaStats(item: DigestL2Item, digest: DigestDetailDto): { files: number; additions: number; deletions: number } {
  const files = digest.files.filter((f) => item.paths.includes(f.path));
  return {
    files: item.paths.length,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
  };
}

function NextLevel({ level, onLevel }: { level: 0 | 1 | 2; onLevel: (l: ReadingLevel) => void }) {
  const next = (level + 1) as ReadingLevel;
  return (
    <p className="next-level">
      <button type="button" className="btn" onClick={() => onLevel(next)}>
        {T.nextLevel(LEVELS[next].key, LEVELS[next].label)} <span aria-hidden="true">→</span>
      </button>
    </p>
  );
}

// --- L0 / L1 -------------------------------------------------------------------------------------

export function SummaryView({ digest, onLevel }: { digest: DigestDetailDto; onLevel: (l: ReadingLevel) => void }) {
  const { files, additions, deletions } = digest.stats;
  return (
    <section className="level-view level-0">
      <h2 className="l0-headline">{digest.l0?.text ?? T.noHeadline}</h2>
      <p className="l0-stats">
        {plural(files, 'file')} · <Delta additions={additions} deletions={deletions} />
        <span className="muted"> · {T.period(humanDateTime(digest.fromAt), humanDateTime(digest.toAt))}</span>
      </p>
      <NextLevel level={0} onLevel={onLevel} />
    </section>
  );
}

export function ImpactView({ digest, onLevel }: { digest: DigestDetailDto; onLevel: (l: ReadingLevel) => void }) {
  const l1 = digest.l1;
  return (
    <section className="level-view level-1">
      {!l1 ? (
        <p className="muted">{T.noImpact}</p>
      ) : (
        <>
          {!l1.userVisible && <p className="muted l1-internal">{T.internalOnly}</p>}
          <ul className="l1-bullets">{l1.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </>
      )}
      <NextLevel level={1} onLevel={onLevel} />
    </section>
  );
}

// --- L2 area cards --------------------------------------------------------------------------------

export interface L2Filter {
  path: string;
  areaIds: ReadonlySet<string>;
}

/** Card click opens the area unless the user was selecting text in it. */
function cardClick(open: () => void) {
  return (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // the title button handles itself
    if (window.getSelection?.()?.toString()) return;
    open();
  };
}

export interface StructureViewProps {
  digest: DigestDetailDto;
  filter: L2Filter | null;
  selectedAreaId: string | null;
  onOpenArea: (id: string) => void;
  onClearFilter: () => void;
  onHoverArea: (id: string | null) => void;
  onLevel: (l: ReadingLevel) => void;
}

export function StructureView({ digest, filter, selectedAreaId, onOpenArea, onClearFilter, onHoverArea, onLevel }: StructureViewProps) {
  const items = digest.l2?.items ?? [];
  const visible = filter ? items.filter((it) => filter.areaIds.has(it.id)) : items;
  const notAnalysed = digest.l2?.notAnalysed ?? [];
  return (
    <section className="level-view level-2">
      {filter && (
        <div className="filter-header" role="status">
          <span>{visible.length > 0 ? <>{T.filteredTo(visible.length, items.length)} <code>{filter.path}</code></> : <>{T.noAreaForNode} <code>{filter.path}</code></>}</span>
          <button type="button" className="btn clear-filter" onClick={onClearFilter}>{T.clearFilter}</button>
        </div>
      )}
      {items.length === 0 && <p className="muted">{T.noAreas}</p>}
      <ul className="area-cards">
        {visible.map((it) => {
          const s = areaStats(it, digest);
          return (
            <li
              key={it.id}
              className={it.id === selectedAreaId ? 'area-card selected' : 'area-card'}
              onClick={cardClick(() => onOpenArea(it.id))}
              onMouseEnter={() => onHoverArea(it.id)}
              onMouseLeave={() => onHoverArea(null)}
            >
              <h3 className="area-card-title">
                <button type="button" onClick={() => onOpenArea(it.id)} onFocus={() => onHoverArea(it.id)} onBlur={() => onHoverArea(null)}>
                  {it.title}
                </button>
              </h3>
              <p className="area-card-effect">{it.effect}</p>
              <p><span className="area-card-label">{T.areaHow}</span> {it.how}</p>
              <p><span className="area-card-label">{T.areaWhy}</span> {it.why}</p>
              <div className="area-card-foot">
                <span className="area-card-files">
                  {it.paths.slice(0, 4).map((p) => <code key={p}>{p}</code>)}
                  {it.paths.length > 4 && <span className="muted">+{it.paths.length - 4}</span>}
                </span>
                <span className="muted">{plural(s.files, 'file')}</span>
                <Delta additions={s.additions} deletions={s.deletions} />
                <span className="area-card-open" aria-hidden="true">{T.openArea} →</span>
              </div>
            </li>
          );
        })}
      </ul>
      {notAnalysed.length > 0 && (
        <p className="muted not-analysed-line">
          {T.notAnalysed}: {notAnalysed.map((p, i) => <span key={p}>{i > 0 && ', '}<code>{p}</code></span>)}
        </p>
      )}
      <NextLevel level={2} onLevel={onLevel} />
    </section>
  );
}

// --- L3 without an area: compact area picker ------------------------------------------------------

export function AreaPicker({ digest, onOpenArea, onHoverArea }: {
  digest: DigestDetailDto;
  onOpenArea: (id: string) => void;
  onHoverArea: (id: string | null) => void;
}) {
  const items = digest.l2?.items ?? [];
  return (
    <section className="level-view level-3-picker">
      <h2 className="picker-head">{items.length > 0 ? T.pickArea : T.noAreas}</h2>
      <ul className="area-picker">
        {items.map((it) => {
          const s = areaStats(it, digest);
          return (
            <li key={it.id}>
              <button
                type="button"
                className="area-pick"
                onClick={() => onOpenArea(it.id)}
                onMouseEnter={() => onHoverArea(it.id)}
                onMouseLeave={() => onHoverArea(null)}
                onFocus={() => onHoverArea(it.id)}
                onBlur={() => onHoverArea(null)}
              >
                <span className="area-pick-title">{it.title}</span>
                <span className="area-pick-effect">{it.effect}</span>
                <span className="area-pick-meta">
                  <span>{plural(s.files, 'file')}</span> <Delta additions={s.additions} deletions={s.deletions} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
