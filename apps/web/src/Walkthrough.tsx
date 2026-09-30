// L3 for one area (DIG-50, docs/ux-v3.md §2; step snippets DIG-96, docs/l3-step-snippets.md): the
// overview, then each step's title and body with only the lines its ranges cover, line-anchored
// callouts, and one "View full diff" toggle per area showing every hunk once with step badges.
// Before a walkthrough exists (or while it is being written) the area's full diff is shown
// instead, so the code is always one click away.
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { AreaDetailDto, AreaProgressEvent, AreaWalkthrough, LineRange, StepCallout, WalkthroughStep } from '@digestit/core';
import { type LineSpan, type PatchLine, rangeSpan, spanContains, spanContext, walkPatch } from '@digestit/core/hunks';
import { lineDelta, reviewedCopy, walkthroughCopy, type Lang } from './copy.js';
import { proseLabel, renderProse } from './prose.js';
import type { AreaHeading } from './Reader.js';

/** Hunks longer than this fold to their first `FOLD_PREVIEW` lines, with "Show all" (full-diff view only). */
export const FOLD_THRESHOLD = 20;
export const FOLD_PREVIEW = 12;

/** The walkthrough in `area.l3`, or null when there is none (not generated, or an older format
 * whose steps still point at whole hunks instead of exact `ranges` — DIG-96). */
export function walkthroughOf(area: AreaDetailDto): AreaWalkthrough | null {
  const l3 = area.l3 as unknown;
  if (!l3 || typeof l3 !== 'object') return null;
  const w = l3 as Partial<AreaWalkthrough>;
  if (typeof w.overview !== 'string' || !Array.isArray(w.steps) || !Array.isArray(w.check)) return null;
  if (!w.steps.every((s) => Array.isArray(s.ranges) && s.ranges.length > 0)) return null;
  return w as AreaWalkthrough;
}

type FileLines = Map<string, PatchLine[]>;

function kindClass(l: PatchLine): 'add' | 'del' | 'ctx' {
  return l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx';
}
function marker(l: PatchLine): string {
  return l.kind === '+' ? '+' : l.kind === '-' ? '−' : ' ';
}

interface Badge {
  n: number;
  current: boolean;
  label: string;
  onClick: () => void;
}

/** One diff row. `badge` is omitted (no gutter column) for a step's own snippet, and `null | Badge`
 * (a gutter column always present, filled only on covered lines) for the full-diff view. */
function LineRow({ line, dim = false, marked = false, badge }: { line: PatchLine; dim?: boolean; marked?: boolean; badge?: Badge | null }) {
  const cls = ['dl', kindClass(line), dim && 'dim', marked && 'callout'].filter(Boolean).join(' ');
  return (
    <tr className={cls}>
      {badge !== undefined && (
        <td className="step-gutter">
          {badge && (
            <button type="button" className={badge.current ? 'step-badge current' : 'step-badge'} aria-label={badge.label} onClick={badge.onClick}>
              {badge.n}
            </button>
          )}
        </td>
      )}
      <td className="no">{line.oldNo ?? ''}</td>
      <td className="no">{line.newNo ?? ''}</td>
      <td className="code"><span aria-hidden="true">{marker(line)}</span>{line.text}</td>
    </tr>
  );
}

function HeaderRow({ text, gutter }: { text: string; gutter: boolean }) {
  return (
    <tr className="dl hunk">
      {gutter && <td className="no" />}
      <td className="no" />
      <td className="no" />
      <td className="code">{text}</td>
    </tr>
  );
}

/** A callout note, right under the last line it anchors, like a review comment. The line numbers
 * are read out for screen readers even though sighted readers get them from the anchored rows above. */
function CalloutNote({ start, end, note, lang }: { start: number; end: number; note: string; lang: Lang }) {
  const T = walkthroughCopy(lang);
  return (
    <tr className="callout-note-row">
      <td colSpan={3}>
        <p className="callout-note">
          <span className="visually-hidden">{T.rangeLabel(start, end)}: </span>
          <span aria-hidden="true">← </span>{renderProse(note)}
        </p>
      </td>
    </tr>
  );
}

/** Groups one file's `walkPatch` output back into its hunks, dropping the pre-first-hunk header lines. */
function groupByHunk(lines: PatchLine[]): { header: string; content: PatchLine[] }[] {
  const groups: { header: string; content: PatchLine[] }[] = [];
  for (const l of lines) {
    if (l.kind === 'hunk') { groups.push({ header: l.text, content: [] }); continue; }
    if (l.kind === 'header') continue;
    groups[groups.length - 1]?.content.push(l);
  }
  return groups;
}

/** One hunk, folding past `FOLD_THRESHOLD` lines with a "Show all" toggle. `gutter` turns on the
 * step-badge column (full-diff view); a step snippet never passes `badgeOf`/`onStep`. */
function HunkFigure({
  path, header, content, gutter, badgeOf, currentStep, onStep, lang,
}: {
  path: string;
  header: string;
  content: PatchLine[];
  gutter: boolean;
  badgeOf?: Map<PatchLine, number>;
  currentStep?: number | null;
  onStep?: (n: number) => void;
  lang: Lang;
}) {
  const T = walkthroughCopy(lang);
  const [open, setOpen] = useState(false);
  const visible = content.filter((l) => l.kind !== '\\');
  const long = visible.length > FOLD_THRESHOLD;
  const lines = long && !open ? visible.slice(0, FOLD_PREVIEW) : visible;
  return (
    <figure className="hunk-block">
      <figcaption className="hunk-caption"><code>{path}</code></figcaption>
      <table className="diff">
        <tbody>
          <HeaderRow text={header} gutter={gutter} />
          {lines.map((l, i) => {
            if (!gutter) return <LineRow key={i} line={l} />;
            const n = badgeOf!.get(l);
            const badge: Badge | null = n === undefined ? null : { n, current: n === currentStep, label: T.goToStep(n), onClick: () => onStep!(n) };
            return <LineRow key={i} line={l} badge={badge} />;
          })}
        </tbody>
      </table>
      {long && (
        <button type="button" className="btn hunk-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? T.showLess : T.showAll(visible.length)}
        </button>
      )}
    </figure>
  );
}

function FileHunks({
  path, lines, gutter, badgeOf, currentStep, onStep, lang,
}: {
  path: string;
  lines: PatchLine[];
  gutter: boolean;
  badgeOf?: Map<PatchLine, number>;
  currentStep?: number | null;
  onStep?: (n: number) => void;
  lang: Lang;
}) {
  return (
    <>
      {groupByHunk(lines).map((g, i) => (
        <HunkFigure key={i} path={path} header={g.header} content={g.content} gutter={gutter} badgeOf={badgeOf} currentStep={currentStep} onStep={onStep} lang={lang} />
      ))}
    </>
  );
}

/** The callouts of `callouts` (a step's) that land inside `span` (one of the step's own ranges),
 * cut with the same `rangeSpan`/`spanContains` the validator uses. */
function calloutsForRange(lines: PatchLine[], range: LineRange, span: LineSpan, callouts: StepCallout[]) {
  const out: { note: string; start: number; end: number; span: LineSpan }[] = [];
  for (const c of callouts) {
    if (c.path !== range.path) continue;
    const res = rangeSpan(lines, c.side, c.start, c.end);
    if (res.ok && spanContains(span, res.span)) out.push({ note: c.note, start: c.start, end: c.end, span: res.span });
  }
  return out;
}

/** One range's snippet: `rangeSpan` cuts the lines, `spanContext` adds up to 3 dimmed lines of
 * context on each side, and any callouts inside the range get a gutter highlight plus their note
 * right under the last line they anchor. */
function RangeSnippet({
  range, lines, span, callouts, stepNumber, current, lang,
}: {
  range: LineRange;
  lines: PatchLine[];
  span: LineSpan;
  callouts: { note: string; start: number; end: number; span: LineSpan }[];
  stepNumber: number;
  current: boolean;
  lang: Lang;
}) {
  const T = walkthroughCopy(lang);
  const ctx = spanContext(lines, span, 3);
  const rows: ReactNode[] = [];
  ctx.before.forEach((l, i) => rows.push(<LineRow key={`b${i}`} line={l} dim />));
  for (let i = span.from; i <= span.to; i++) {
    const l = lines[i]!;
    if (l.kind === '\\') continue;
    const hits = callouts.filter((c) => i >= c.span.from && i <= c.span.to);
    rows.push(<LineRow key={i} line={l} marked={hits.length > 0} />);
    hits.filter((c) => c.span.to === i).forEach((c, ci) => rows.push(<CalloutNote key={`${i}n${ci}`} start={c.start} end={c.end} note={c.note} lang={lang} />));
  }
  ctx.after.forEach((l, i) => rows.push(<LineRow key={`a${i}`} line={l} dim />));
  return (
    <figure className="hunk-block range-snippet">
      <figcaption className="hunk-caption">
        <span className={current ? 'step-badge current' : 'step-badge'}>{stepNumber}</span>
        <code>{range.path}</code>
        <span className="hunk-range">· {T.rangeLabel(range.start, range.end)}</span>
      </figcaption>
      <table className="diff"><tbody>{rows}</tbody></table>
    </figure>
  );
}

/** A step's own snippets, one per range, in reading order. Never the whole hunk, and never a line
 * another step's range already shows (guaranteed by the validator, not re-checked here). */
function StepRanges({ step, stepNumber, current, fileLines, lang }: { step: WalkthroughStep; stepNumber: number; current: boolean; fileLines: FileLines; lang: Lang }) {
  const T = walkthroughCopy(lang);
  return (
    <>
      {(step.ranges ?? []).map((r, i) => {
        const lines = fileLines.get(r.path);
        const res = lines ? rangeSpan(lines, r.side, r.start, r.end) : null;
        if (!lines || !res || !res.ok) return <p key={i} className="muted range-missing">{T.missingRange(r.path, r.start, r.end)}</p>;
        return (
          <RangeSnippet
            key={i} range={r} lines={lines} span={res.span} callouts={calloutsForRange(lines, r, res.span, step.callouts ?? [])}
            stepNumber={stepNumber} current={current} lang={lang}
          />
        );
      })}
    </>
  );
}

/** The mechanical step's snippets sit behind a disclosure, collapsed by default. */
function MechanicalRanges(props: { step: WalkthroughStep; stepNumber: number; current: boolean; fileLines: FileLines; lang: Lang }) {
  const T = walkthroughCopy(props.lang);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn mechanical-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? T.hideCode : T.showCode}
      </button>
      {open && <StepRanges {...props} />}
    </>
  );
}

function StepSection({ s, i, current, fileLines, lang }: { s: WalkthroughStep; i: number; current: boolean; fileLines: FileLines; lang: Lang }) {
  const T = walkthroughCopy(lang);
  return (
    <section
      id={`step-${i + 1}`}
      className={['step', s.mechanical && 'mechanical', current && 'current'].filter(Boolean).join(' ')}
      aria-labelledby={`step-${i + 1}-title`}
    >
      <h3 id={`step-${i + 1}-title`} tabIndex={-1}>
        <span className="step-n">{T.stepLabel(i + 1)}</span> {renderProse(s.title)}
        {s.mechanical && <span className="badge step-mech">{T.mechanical}</span>}
      </h3>
      <p className="step-body">{renderProse(s.body)}</p>
      {s.mechanical
        ? <MechanicalRanges step={s} stepNumber={i + 1} current={current} fileLines={fileLines} lang={lang} />
        : <StepRanges step={s} stepNumber={i + 1} current={current} fileLines={fileLines} lang={lang} />}
    </section>
  );
}

/** Every step's ranges, cut the same way as the snippets, mapped back onto the `walkPatch` lines
 * they cover, so the full-diff view can badge them without re-deriving the cut. */
function stepOfLines(steps: readonly WalkthroughStep[], fileLines: FileLines): Map<PatchLine, number> {
  const map = new Map<PatchLine, number>();
  steps.forEach((s, i) => {
    for (const r of s.ranges ?? []) {
      const lines = fileLines.get(r.path);
      if (!lines) continue;
      const res = rangeSpan(lines, r.side, r.start, r.end);
      if (!res.ok) continue;
      for (let idx = res.span.from; idx <= res.span.to; idx++) {
        const l = lines[idx]!;
        if (!map.has(l)) map.set(l, i + 1);
      }
    }
  });
  return map;
}

/** One "View full diff" toggle per area, collapsed by default: every hunk once, with the covering
 * step's badge in the gutter (clicking it jumps to that step). Never repeated inside the steps. */
function FullDiffSection({
  files, fileLines, badgeOf, step, onStep, lang,
}: {
  files: readonly { path: string }[];
  fileLines: FileLines;
  badgeOf: Map<PatchLine, number>;
  step: number | null;
  onStep: (n: number) => void;
  lang: Lang;
}) {
  const T = walkthroughCopy(lang);
  const [open, setOpen] = useState(false);
  return (
    <section className="full-diff" aria-labelledby="wt-diff">
      <h3 id="wt-diff">
        {T.fullDiff}{' '}
        <button type="button" className="btn full-diff-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? T.hideFullDiff : T.showFullDiff}
        </button>
      </h3>
      {open && (
        <div className="full-diff-body">
          {files.map((f) => {
            const lines = fileLines.get(f.path) ?? [];
            return lines.length > 0
              ? <FileHunks key={f.path} path={f.path} lines={lines} gutter badgeOf={badgeOf} currentStep={step} onStep={onStep} lang={lang} />
              : <p key={f.path} className="muted"><code>{f.path}</code> {T.noTextChange}</p>;
          })}
        </div>
      )}
    </section>
  );
}

function StepNav({ step, total, onStep, lang = 'en' }: { step: number | null; total: number; onStep: (n: number) => void; lang?: Lang }) {
  const T = walkthroughCopy(lang);
  const cur = step ?? 0;
  return (
    <div className="step-bar">
      <span className="step-bar-pos">{cur > 0 ? T.stepOf(cur, total) : T.overview}</span>
      <button type="button" className="btn" disabled={cur <= 1} onClick={() => onStep(cur - 1)}>
        <span aria-hidden="true">← </span>{T.previous}
      </button>
      <button type="button" className="btn" disabled={cur >= total} onClick={() => onStep(cur + 1)}>
        {T.next}<span aria-hidden="true"> →</span>
      </button>
      <span className="muted step-bar-hint">{T.stepKeysHint}</span>
    </div>
  );
}

export interface WalkthroughViewProps {
  area: AreaDetailDto;
  item: AreaHeading;
  /** 1-based current step, or null (at the overview). */
  step: number | null;
  onStep: (n: number) => void;
  /** Request (or retry) this area's walkthrough. */
  onGenerate: () => void;
  /** Remaining daily LLM calls; null when unknown. */
  callsRemaining: number | null;
  /** Whether the current area is marked reviewed (DIG-61 P5-A, client-only, per project:digest:area). */
  reviewed?: boolean;
  /** Toggles the reviewed mark for the current area; absent when there is nothing to mark yet. */
  onToggleReviewed?: () => void;
  /** The walkthrough as it streams in (`area-progress`, DIG-76), while `area.l3` is still null and
   * `area.status` is `pending`. Ignored once the real, validated `l3` lands. */
  streaming?: Pick<AreaProgressEvent, 'overview' | 'steps'> | null;
  /** The UI chrome's language; defaults to English for callers (mostly tests) that don't care. */
  lang?: Lang;
}

export function WalkthroughView({
  area, item, step, onStep, onGenerate, callsRemaining, reviewed = false, onToggleReviewed, streaming = null, lang = 'en',
}: WalkthroughViewProps) {
  const T = walkthroughCopy(lang);
  const TR = reviewedCopy(lang);
  const walkthrough = walkthroughOf(area);
  const heading = item.title ?? item.label;
  const shown = useMemo(() => area.files.filter((f) => !f.filteredReason), [area.files]);
  const filtered = area.files.filter((f) => f.filteredReason);
  const fileLines: FileLines = useMemo(() => new Map(shown.map((f) => [f.path, walkPatch(f.patch ?? '')])), [shown]);
  const steps = walkthrough?.steps ?? [];
  const badgeOf = useMemo(() => stepOfLines(steps, fileLines), [steps, fileLines]);
  const stats = shown.reduce((s, f) => ({ a: s.a + f.additions, d: s.d + f.deletions }), { a: 0, d: 0 });

  const [announce, setAnnounce] = useState('');
  // Bring the current step to the top of the reading pane, announce it, and move focus to its
  // heading when the step actually changes (n/p, the side list, a reload with &step=) — but not on
  // a walkthrough re-render at the same step (polling, or DIG-76 streamed steps landing mid-read),
  // which would otherwise re-announce and yank focus. The step bar is sticky, so steps carry a
  // matching scroll-margin.
  const announcedStepRef = useRef<number | null>(null);
  useEffect(() => {
    // Leaving step mode forgets the last step, so coming back to that same step (browser back to
    // `?step=2`) still scrolls, announces and focuses.
    if (step === null) {
      announcedStepRef.current = null;
      return;
    }
    if (!walkthrough || announcedStepRef.current === step) return;
    announcedStepRef.current = step;
    document.getElementById(`step-${step}`)?.scrollIntoView?.({ block: 'start' });
    const s = walkthrough.steps[step - 1];
    const first = s?.ranges?.[0];
    const stepOf = T.stepOf(step, steps.length);
    setAnnounce(first ? `${stepOf}, ${first.path} ${T.rangeLabel(first.start, first.end)}` : stepOf);
    document.getElementById(`step-${step}-title`)?.focus();
  }, [step, walkthrough]);

  const noBudget = callsRemaining === 0;
  const notice = (() => {
    switch (area.status) {
      case 'none':
        return (
          <div className="notice generate">
            <p>{T.notGenerated}</p>
            <button type="button" className="btn primary" onClick={onGenerate} disabled={noBudget}>{T.generate}</button>
            <span className="muted">{noBudget ? T.noBudget : callsRemaining !== null ? T.generateCost(callsRemaining) : ''}</span>
          </div>
        );
      case 'pending':
        return <p className="notice muted" role="status"><span className="spinner" aria-hidden="true" /> {T.generating}</p>;
      case 'error':
        return (
          <p className="notice error" role="alert">
            {T.generateError}{' '}
            <button type="button" className="btn" onClick={onGenerate} disabled={noBudget}>{noBudget ? T.noBudget : T.retry}</button>
          </p>
        );
      case 'truncated':
        return <p className="notice muted">{T.truncated}</p>;
      default:
        return null;
    }
  })();

  return (
    <article className="walkthrough" aria-label={T.regionLabel(proseLabel(heading))}>
      <div aria-live="polite" className="visually-hidden">{announce}</div>
      <header className="walkthrough-head">
        <div className="walkthrough-head-row">
          <h2>{renderProse(heading)}</h2>
          {onToggleReviewed && (
            <button type="button" className="btn reviewed-toggle" aria-pressed={reviewed} onClick={onToggleReviewed}>
              <span aria-hidden="true">{reviewed ? '✓' : '○'}</span> {reviewed ? TR.reviewed : TR.mark}
            </button>
          )}
        </div>
        <p className="muted">
          {item.effect !== null ? renderProse(item.effect) : <span className="placeholder">{T.areaWriting}</span>}{' '}
          <span className="stats"><span className="add">+{stats.a}</span> <span className="del">−{stats.d}</span></span>
          <span className="visually-hidden"> ({lineDelta(stats.a, stats.d)})</span>
        </p>
      </header>
      {notice}
      {walkthrough ? (
        <>
          {steps.length > 0 && <StepNav step={step} total={steps.length} onStep={onStep} lang={lang} />}
          <div className={steps.length > 3 ? 'walkthrough-body with-toc' : 'walkthrough-body'}>
            {steps.length > 3 && (
              <nav className="step-toc" aria-label={T.stepsNav}>
                <ol>
                  {steps.map((s, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className={s.mechanical ? 'step-toc-item mechanical' : 'step-toc-item'}
                        aria-current={step === i + 1 ? 'step' : undefined}
                        onClick={() => onStep(i + 1)}
                      >
                        <span className="step-toc-n">{i + 1}</span> {renderProse(s.title)}
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            <div className="walkthrough-main">
              <section className="overview" aria-labelledby="wt-overview">
                <h3 id="wt-overview">{T.overview}</h3>
                <p>{renderProse(walkthrough.overview)}</p>
              </section>
              {steps.map((s, i) => <StepSection key={i} s={s} i={i} current={step === i + 1} fileLines={fileLines} lang={lang} />)}
              {walkthrough.check.length > 0 && (
                <section className="check" aria-labelledby="wt-check">
                  <h3 id="wt-check">{T.check}</h3>
                  <ul>{walkthrough.check.map((c, i) => <li key={i}>{renderProse(c)}</li>)}</ul>
                </section>
              )}
              <FullDiffSection files={shown} fileLines={fileLines} badgeOf={badgeOf} step={step} onStep={onStep} lang={lang} />
            </div>
          </div>
        </>
      ) : streaming && (streaming.overview !== null || streaming.steps.length > 0) ? (
        // The walkthrough streaming in (DIG-76 scope 5): steps appear one by one from
        // `area-progress`. Same step/section ids as the final render above, so when the real,
        // validated `l3` replaces this branch the reader's scroll position does not jump.
        <div className="walkthrough-body streaming">
          <div className="walkthrough-main">
            {streaming.overview !== null && (
              <section className="overview" aria-labelledby="wt-overview">
                <h3 id="wt-overview">{T.overview}</h3>
                <p>{renderProse(streaming.overview)}</p>
              </section>
            )}
            {streaming.steps.map((s, i) => <StepSection key={i} s={s} i={i} current={step === i + 1} fileLines={fileLines} lang={lang} />)}
          </div>
        </div>
      ) : (
        <section className="full-diff" aria-labelledby="wt-diff">
          <h3 id="wt-diff">{T.fullDiff}</h3>
          {shown.map((f) => {
            const lines = fileLines.get(f.path) ?? [];
            return lines.length > 0
              ? <FileHunks key={f.path} path={f.path} lines={lines} gutter={false} lang={lang} />
              : <p key={f.path} className="muted"><code>{f.path}</code> {T.noTextChange}</p>;
          })}
        </section>
      )}
      {filtered.length > 0 && (
        <section className="not-analysed" aria-labelledby="wt-na">
          <h3 id="wt-na">{T.notAnalysed}</h3>
          <ul>{filtered.map((f) => <li key={f.path}><code>{f.path}</code></li>)}</ul>
        </section>
      )}
    </article>
  );
}
