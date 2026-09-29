// Reading flow (DIG-50, docs/ux-v3.md §1): the level switcher, the breadcrumb, and one focused
// view per level. L0 is the headline, L1 the impact bullets, L2 the area cards, L3 without an
// area an area picker (the walkthrough itself is in Walkthrough.tsx). MainV2 composes these.
import { useRef, type KeyboardEvent, type MouseEvent } from 'react';
import type { DigestDetailDto, DigestL2Item, DigestPartsDto, PartStatus } from '@digestit/core';
import { humanDateTime, levelsCopy, readerCopy, reviewedCopy, type Lang } from './copy.js';
import { renderProse } from './prose.js';
import type { ReadingLevel } from './v2Url.js';

// --- Fast Explain (DIG-73/76): one row per area, merging the deterministic skeleton (always
// present, so the list shows instantly) with the LLM text once its part lands. An old-contract
// digest (no `areas`) has no skeleton to merge, so every area there reads as settled ('ok'). ----

export interface AreaHeading {
  id: string;
  paths: string[];
  title: string | null;
  effect: string | null;
  how: string | null;
  why: string | null;
  /** Deterministic folder/module label (`DigestAreaSkeleton.label`, or the title for an
   * old-contract digest), shown until `title` lands. */
  label: string;
}

export interface AreaRow extends AreaHeading {
  additions: number;
  deletions: number;
  status: PartStatus;
}

export function digestAreaRows(digest: DigestDetailDto): AreaRow[] {
  if (!digest.areas) {
    return (digest.l2?.items ?? []).map((it) => {
      const files = digest.files.filter((f) => it.paths.includes(f.path));
      return {
        id: it.id,
        paths: it.paths,
        additions: files.reduce((s, f) => s + f.additions, 0),
        deletions: files.reduce((s, f) => s + f.deletions, 0),
        status: 'ok',
        title: it.title,
        effect: it.effect,
        how: it.how,
        why: it.why,
        label: it.title,
      };
    });
  }
  const byId = new Map((digest.l2?.items ?? []).map((it) => [it.id, it]));
  return digest.areas.map((skel) => {
    const item = byId.get(skel.id) ?? null;
    const status: PartStatus = digest.parts?.areas[skel.id] ?? (item ? 'ok' : 'pending');
    return {
      id: skel.id,
      paths: skel.paths,
      additions: skel.additions,
      deletions: skel.deletions,
      status,
      title: item?.title ?? null,
      effect: item?.effect ?? null,
      how: item?.how ?? null,
      why: item?.why ?? null,
      label: skel.label,
    };
  });
}

export const partFailed = (status: PartStatus): boolean => status === 'error' || status === 'truncated' || status === 'budget';
export const partPending = (status: PartStatus): boolean => status === 'pending' || status === 'running';

/** Whether every part of an in-flight Explain has settled: nothing left to stream, so the SSE
 * connection for this digest can close (or need never open). */
export function partsSettled(parts: DigestPartsDto): boolean {
  return !partPending(parts.summary) && !partPending(parts.context) && Object.values(parts.areas).every((s) => !partPending(s));
}

/** A failed/`budget` part's own short message and retry (DIG-76 scope 4): the retry always POSTs
 * the whole digest's `/explain`, which re-runs only the parts still `error`/`truncated`/`budget`,
 * so every failed part on a digest shares one handler. */
function PartRetry({ status, onRetry, retrying, retryDisabled, lang = 'en' }: {
  status: PartStatus;
  onRetry: () => void;
  retrying: boolean;
  retryDisabled: boolean;
  lang?: Lang;
}) {
  const T = readerCopy(lang);
  return (
    <span className="part-failed" role="alert">
      {status === 'budget' ? T.partBudget : T.partFailed}{' '}
      <button type="button" className="btn retry" onClick={onRetry} disabled={retrying || retryDisabled}>
        {retryDisabled ? T.retryNoBudget : retrying ? T.retrying : T.retry}
      </button>
    </span>
  );
}

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
export function LevelSwitcher({ level, onLevel, lang = 'en' }: { level: ReadingLevel; onLevel: (l: ReadingLevel) => void; lang?: Lang }) {
  const T = readerCopy(lang);
  const LEVELS = levelsCopy(lang);
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
  area: AreaHeading | null;
  onDigest: () => void;
  onArea: () => void;
  onLevel: () => void;
  lang?: Lang;
}

/** `Digest · Today, 17:05 › <area> › L3 Code`; every segment is a button. */
export function Breadcrumb({ digest, level, area, onDigest, onArea, onLevel, lang = 'en' }: BreadcrumbProps) {
  const T = readerCopy(lang);
  const lv = levelsCopy(lang)[level];
  const showArea = level === 3 && area !== null;
  return (
    <nav className="breadcrumb" aria-label={T.breadcrumbLabel}>
      <ol>
        <li><button type="button" className="crumb" onClick={onDigest}>{T.digestCrumb(humanDateTime(digest.toAt, Date.now(), lang))}</button></li>
        {showArea && <li><button type="button" className="crumb" onClick={onArea}>{renderProse(area.title ?? area.label)}</button></li>}
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

/** Small per-area "reviewed" marker (DIG-61 P5-A) for the L2 area cards and the L3 picker. Not
 * color-only: a checkmark glyph plus the word, both hidden entirely when not reviewed. */
function ReviewedIndicator({ lang = 'en' }: { lang?: Lang }) {
  const T = reviewedCopy(lang);
  return (
    <span className="reviewed-indicator">
      <span aria-hidden="true">✓</span> {T.badge}
    </span>
  );
}

function NextLevel({ level, onLevel, lang = 'en' }: { level: 0 | 1 | 2; onLevel: (l: ReadingLevel) => void; lang?: Lang }) {
  const next = (level + 1) as ReadingLevel;
  const nextLv = levelsCopy(lang)[next];
  return (
    <p className="next-level">
      <button type="button" className="btn" onClick={() => onLevel(next)}>
        {readerCopy(lang).nextLevel(nextLv.key, nextLv.label)} <span aria-hidden="true">→</span>
      </button>
    </p>
  );
}

// --- L0 / L1 -------------------------------------------------------------------------------------

export interface PartRetryProps {
  /** Retries every outstanding (`error`/`truncated`/`budget`) part of the digest: one endpoint
   * for all of them (docs/explain-speed.md §5), so every failed part shares this one handler. */
  onRetryPart?: () => void;
  retryingPart?: boolean;
  retryDisabled?: boolean;
}

export interface SummaryViewProps extends PartRetryProps {
  digest: DigestDetailDto;
  onLevel: (l: ReadingLevel) => void;
  /** A P2 area card was picked: opens L2 with that area selected and scrolled into view. */
  onOpenArea: (id: string) => void;
  onHoverArea: (id: string | null) => void;
  lang?: Lang;
}

export function SummaryView({
  digest, onLevel, onOpenArea, onHoverArea, onRetryPart, retryingPart = false, retryDisabled = false, lang = 'en',
}: SummaryViewProps) {
  const T = readerCopy(lang);
  const { files, additions, deletions } = digest.stats;
  const summaryStatus = digest.parts?.summary ?? 'ok';
  return (
    <section className="level-view level-0">
      <h2 className="l0-headline">
        {digest.l0 ? renderProse(digest.l0.text)
          : partPending(summaryStatus) ? <span className="muted placeholder">{T.summaryWriting}</span>
            : partFailed(summaryStatus) && onRetryPart ? <PartRetry status={summaryStatus} onRetry={onRetryPart} retrying={retryingPart} retryDisabled={retryDisabled} lang={lang} />
              : T.noHeadline}
      </h2>
      <p className="l0-stats">
        {T.fileCount(files)} · <Delta additions={additions} deletions={deletions} />
        <span className="muted"> · {T.period(humanDateTime(digest.fromAt, Date.now(), lang), humanDateTime(digest.toAt, Date.now(), lang))}</span>
      </p>
      {digest.parts?.context === 'running' && <p className="notice muted context-building" role="status">{T.contextBuilding}</p>}
      <NextLevel level={0} onLevel={onLevel} lang={lang} />
      <AreasGlance digest={digest} onOpenArea={onOpenArea} onHoverArea={onHoverArea} lang={lang} />
    </section>
  );
}

/** "Areas in this digest" (DIG-61 P2): a compact map of the digest's areas under L0's headline.
 * Cards are real buttons (same focus/hover handling as AreaPicker below) and land on L2 with the
 * area pre-selected, not straight on L3 — L0→L3 would skip the structural framing L3 assumes.
 * Shows instantly from the deterministic area skeleton (DIG-76): the title is a placeholder
 * (the folder/module label) until that area's L2 text lands. */
function AreasGlance({ digest, onOpenArea, onHoverArea, lang = 'en' }: {
  digest: DigestDetailDto;
  onOpenArea: (id: string) => void;
  onHoverArea: (id: string | null) => void;
  lang?: Lang;
}) {
  const T = readerCopy(lang);
  const rows = digestAreaRows(digest);
  if (rows.length === 0) return null;
  return (
    <section className="areas-glance">
      <h3 className="areas-glance-label">{T.areasGlanceHeading}</h3>
      <ul className="area-glance-grid">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="area-glance-card"
              onClick={() => onOpenArea(row.id)}
              onMouseEnter={() => onHoverArea(row.id)}
              onMouseLeave={() => onHoverArea(null)}
              onFocus={() => onHoverArea(row.id)}
              onBlur={() => onHoverArea(null)}
            >
              <p className="area-glance-title">{renderProse(row.title ?? row.label)}</p>
              <p className="area-glance-meta"><span>{T.fileCount(row.paths.length)}</span> <Delta additions={row.additions} deletions={row.deletions} /></p>
              <span className="area-glance-open" aria-hidden="true">{T.openAreaCard} →</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface ImpactViewProps extends PartRetryProps {
  digest: DigestDetailDto;
  onLevel: (l: ReadingLevel) => void;
  lang?: Lang;
}

export function ImpactView({ digest, onLevel, onRetryPart, retryingPart = false, retryDisabled = false, lang = 'en' }: ImpactViewProps) {
  const T = readerCopy(lang);
  const l1 = digest.l1;
  const summaryStatus = digest.parts?.summary ?? 'ok';
  return (
    <section className="level-view level-1">
      {!l1 ? (
        partPending(summaryStatus) ? <p className="muted placeholder">{T.impactWriting}</p>
          : partFailed(summaryStatus) && onRetryPart ? <p><PartRetry status={summaryStatus} onRetry={onRetryPart} retrying={retryingPart} retryDisabled={retryDisabled} lang={lang} /></p>
            : <p className="muted">{T.noImpact}</p>
      ) : (
        <>
          {!l1.userVisible && <p className="muted l1-internal">{T.internalOnly}</p>}
          <ul className="l1-bullets">{l1.bullets.map((b, i) => <li key={i}>{renderProse(b)}</li>)}</ul>
        </>
      )}
      <NextLevel level={1} onLevel={onLevel} lang={lang} />
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

export interface StructureViewProps extends PartRetryProps {
  digest: DigestDetailDto;
  filter: L2Filter | null;
  selectedAreaId: string | null;
  onOpenArea: (id: string) => void;
  onClearFilter: () => void;
  onHoverArea: (id: string | null) => void;
  onLevel: (l: ReadingLevel) => void;
  /** Areas marked reviewed (DIG-61 P5-A), for the small non-color-only indicator. */
  reviewedAreaIds?: ReadonlySet<string>;
  lang?: Lang;
}

export function StructureView({
  digest, filter, selectedAreaId, onOpenArea, onClearFilter, onHoverArea, onLevel, reviewedAreaIds,
  onRetryPart, retryingPart = false, retryDisabled = false, lang = 'en',
}: StructureViewProps) {
  const T = readerCopy(lang);
  const rows = digestAreaRows(digest);
  const visible = filter ? rows.filter((row) => filter.areaIds.has(row.id)) : rows;
  const notAnalysed = digest.l2?.notAnalysed ?? [];
  return (
    <section className="level-view level-2">
      {filter && (
        <div className="filter-header" role="status">
          <span>{visible.length > 0 ? <>{T.filteredTo(visible.length, rows.length)} <code>{filter.path}</code></> : <>{T.noAreaForNode} <code>{filter.path}</code></>}</span>
          <button type="button" className="btn clear-filter" onClick={onClearFilter}>{T.clearFilter}</button>
        </div>
      )}
      {rows.length === 0 && <p className="muted">{T.noAreas}</p>}
      <ul className="area-cards">
        {visible.map((row) => (
          <li
            key={row.id}
            data-area-id={row.id}
            className={row.id === selectedAreaId ? 'area-card selected' : 'area-card'}
            onClick={cardClick(() => onOpenArea(row.id))}
            onMouseEnter={() => onHoverArea(row.id)}
            onMouseLeave={() => onHoverArea(null)}
          >
            <h3 className="area-card-title">
              <button type="button" onClick={() => onOpenArea(row.id)} onFocus={() => onHoverArea(row.id)} onBlur={() => onHoverArea(null)}>
                {renderProse(row.title ?? row.label)}
              </button>
              {reviewedAreaIds?.has(row.id) && <ReviewedIndicator lang={lang} />}
            </h3>
            {row.effect !== null ? (
              <p className="area-card-effect">{renderProse(row.effect)}</p>
            ) : partPending(row.status) ? (
              <p className="area-card-effect muted placeholder">{T.areaWriting}</p>
            ) : partFailed(row.status) && onRetryPart ? (
              <p className="area-card-effect">
                <PartRetry status={row.status} onRetry={onRetryPart} retrying={retryingPart} retryDisabled={retryDisabled} lang={lang} />
              </p>
            ) : null}
            {row.how !== null && row.why !== null && (
              <>
                <p><span className="area-card-label">{T.areaHow}</span> {renderProse(row.how)}</p>
                <p><span className="area-card-label">{T.areaWhy}</span> {renderProse(row.why)}</p>
              </>
            )}
            <div className="area-card-foot">
              <span className="area-card-files">
                {row.paths.slice(0, 4).map((p) => <code key={p}>{p}</code>)}
                {row.paths.length > 4 && <span className="muted">+{row.paths.length - 4}</span>}
              </span>
              <span className="muted">{T.fileCount(row.paths.length)}</span>
              <Delta additions={row.additions} deletions={row.deletions} />
              <span className="area-card-open" aria-hidden="true">{T.openArea} →</span>
            </div>
          </li>
        ))}
      </ul>
      {notAnalysed.length > 0 && (
        <p className="muted not-analysed-line">
          {T.notAnalysed}: {notAnalysed.map((p, i) => <span key={p}>{i > 0 && ', '}<code>{p}</code></span>)}
        </p>
      )}
      <NextLevel level={2} onLevel={onLevel} lang={lang} />
    </section>
  );
}

// --- L3 without an area: compact area picker ------------------------------------------------------

export function AreaPicker({ digest, onOpenArea, onHoverArea, reviewedAreaIds, lang = 'en' }: {
  digest: DigestDetailDto;
  onOpenArea: (id: string) => void;
  onHoverArea: (id: string | null) => void;
  /** Areas marked reviewed (DIG-61 P5-A), for the small non-color-only indicator. */
  reviewedAreaIds?: ReadonlySet<string>;
  lang?: Lang;
}) {
  const T = readerCopy(lang);
  const rows = digestAreaRows(digest);
  return (
    <section className="level-view level-3-picker">
      <h2 className="picker-head">{rows.length > 0 ? T.pickArea : T.noAreas}</h2>
      <ul className="area-picker">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="area-pick"
              onClick={() => onOpenArea(row.id)}
              onMouseEnter={() => onHoverArea(row.id)}
              onMouseLeave={() => onHoverArea(null)}
              onFocus={() => onHoverArea(row.id)}
              onBlur={() => onHoverArea(null)}
            >
              <span className="area-pick-title">{renderProse(row.title ?? row.label)}</span>
              {reviewedAreaIds?.has(row.id) && <ReviewedIndicator lang={lang} />}
              <span className="area-pick-effect">
                {row.effect !== null ? renderProse(row.effect) : partPending(row.status) ? <span className="muted placeholder">{T.areaWriting}</span> : null}
              </span>
              <span className="area-pick-meta">
                <span>{T.fileCount(row.paths.length)}</span> <Delta additions={row.additions} deletions={row.deletions} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
