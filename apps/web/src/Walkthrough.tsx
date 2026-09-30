// L3 for one area (DIG-50, docs/ux-v3.md §2): the overview, then each step's title and body with
// the exact hunks it explains right under the text, "What to check", and last the hunks no step
// covers (cut by the token budget). Before a walkthrough exists (or while it is being written)
// the area's full diff is shown instead, so the code is always one click away.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AreaDetailDto, AreaProgressEvent, AreaWalkthrough, HunkRef } from '@digestit/core';
import { lineDelta, reviewedCopy, walkthroughCopy, type Lang } from './copy.js';
import { hunkRange, splitPatch, uncoveredHunks, type PatchHunk } from './hunks.js';
import type { DiffLine } from './diff.js';
import { proseLabel, renderProse } from './prose.js';
import type { AreaHeading } from './Reader.js';

/** Hunks longer than this fold to their first `FOLD_PREVIEW` lines, with "Show all". */
export const FOLD_THRESHOLD = 20;
export const FOLD_PREVIEW = 12;

/** The walkthrough in `area.l3`, or null when there is none (not generated, or an older format). */
export function walkthroughOf(area: AreaDetailDto): AreaWalkthrough | null {
  const l3 = area.l3 as unknown;
  if (!l3 || typeof l3 !== 'object') return null;
  const w = l3 as Partial<AreaWalkthrough>;
  return typeof w.overview === 'string' && Array.isArray(w.steps) && Array.isArray(w.check) ? (w as AreaWalkthrough) : null;
}

function DiffRow({ line }: { line: DiffLine }) {
  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  return (
    <tr className={`dl ${line.kind}`}>
      <td className="no">{line.oldNo ?? ''}</td>
      <td className="no">{line.newNo ?? ''}</td>
      <td className="code"><span aria-hidden="true">{marker}</span>{line.text}</td>
    </tr>
  );
}

/** One hunk, rendered with the diff styling; long ones fold with "Show all". */
export function HunkBlock({
  path, hunk, lang = 'en', step, current = false, rangeIndex, rangeCount,
}: {
  path: string;
  hunk: PatchHunk;
  lang?: Lang;
  /** 1-based step number this hunk belongs to (P2); omitted for uncovered/leftover/full-diff hunks, which get no badge. */
  step?: number;
  /** Whether `step` is the currently selected step — badge fill vs. outline (P2). */
  current?: boolean;
  /** This hunk's 1-based position among its step's ranges, and how many ranges the step has (P1's "k of M ranges"); omitted for single-range steps. */
  rangeIndex?: number;
  rangeCount?: number;
}) {
  const T = walkthroughCopy(lang);
  const [open, setOpen] = useState(false);
  const long = hunk.lines.length > FOLD_THRESHOLD;
  const lines = long && !open ? hunk.lines.slice(0, FOLD_PREVIEW) : hunk.lines;
  // The label always reflects the full hunk, regardless of fold state (docs/ux/dig71-step-code-mapping.md §6).
  const range = hunkRange(hunk);
  return (
    <figure className="hunk-block">
      <figcaption className="hunk-caption">
        {step !== undefined && <span className={current ? 'step-badge current' : 'step-badge'}>{step}</span>}
        <code>{path}</code>
        <span className="hunk-range">· {T.rangeLabel(range.start, range.end)}</span>
        {rangeCount !== undefined && rangeCount > 1 && <span className="hunk-pos">{T.rangeOf(rangeIndex!, rangeCount)}</span>}
      </figcaption>
      <table className="diff">
        <tbody>
          <tr className="dl hunk">
            <td className="no" />
            <td className="no" />
            <td className="code">{hunk.header}</td>
          </tr>
          {lines.map((l, i) => <DiffRow key={i} line={l} />)}
        </tbody>
      </table>
      {long && (
        <button type="button" className="btn hunk-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? T.showLess : T.showAll(hunk.lines.length)}
        </button>
      )}
    </figure>
  );
}

type HunkIndex = Map<string, PatchHunk[]>;

function StepHunks({ refs, index, step, current, lang = 'en' }: {
  refs: HunkRef[]; index: HunkIndex; step: number; current: boolean; lang?: Lang;
}) {
  const T = walkthroughCopy(lang);
  return (
    <>
      {refs.map((r, i) => {
        const h = index.get(r.path)?.[r.hunk - 1];
        return h
          ? (
            <HunkBlock
              key={`${r.path}#${r.hunk}`} path={r.path} hunk={h} lang={lang}
              step={step} current={current} rangeIndex={i + 1} rangeCount={refs.length}
            />
          )
          : <p key={`${r.path}#${r.hunk}`} className="muted hunk-missing">{T.missingHunk(r.path, r.hunk)}</p>;
      })}
    </>
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
  const index: HunkIndex = useMemo(() => new Map(shown.map((f) => [f.path, splitPatch(f.patch ?? '')])), [shown]);
  const leftover = useMemo(() => uncoveredHunks(shown, walkthrough), [shown, walkthrough]);
  const steps = walkthrough?.steps ?? [];
  const stats = shown.reduce((s, f) => ({ a: s.a + f.additions, d: s.d + f.deletions }), { a: 0, d: 0 });

  const [announce, setAnnounce] = useState('');
  // Bring the current step to the top of the reading pane, announce it, and move focus to its
  // heading when the step actually changes (n/p, the side list, a reload with &step=) — but not on
  // a walkthrough re-render at the same step (polling, or DIG-76 streamed steps landing mid-read),
  // which would otherwise re-announce and yank focus (docs/ux/dig71-step-code-mapping.md §3). The
  // step bar is sticky, so steps carry a matching scroll-margin.
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
    const first = s?.hunks[0];
    const h = first && index.get(first.path)?.[first.hunk - 1];
    const stepOf = T.stepOf(step, steps.length);
    if (first && h) {
      const range = hunkRange(h);
      const more = s!.hunks.length - 1;
      const rangeText = T.rangeLabel(range.start, range.end);
      setAnnounce(more > 0 ? `${stepOf}, ${first.path} ${rangeText} ${T.andMore(more)}` : `${stepOf}, ${first.path} ${rangeText}`);
    } else {
      setAnnounce(stepOf);
    }
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
              {steps.map((s, i) => (
                <section
                  key={i}
                  id={`step-${i + 1}`}
                  className={['step', s.mechanical && 'mechanical', step === i + 1 && 'current'].filter(Boolean).join(' ')}
                  aria-labelledby={`step-${i + 1}-title`}
                >
                  <h3 id={`step-${i + 1}-title`} tabIndex={-1}>
                    <span className="step-n">{T.stepLabel(i + 1)}</span> {renderProse(s.title)}
                    {s.mechanical && <span className="badge step-mech">{T.mechanical}</span>}
                  </h3>
                  <p className="step-body">{renderProse(s.body)}</p>
                  <StepHunks refs={s.hunks} index={index} step={i + 1} current={step === i + 1} lang={lang} />
                </section>
              ))}
              {walkthrough.check.length > 0 && (
                <section className="check" aria-labelledby="wt-check">
                  <h3 id="wt-check">{T.check}</h3>
                  <ul>{walkthrough.check.map((c, i) => <li key={i}>{renderProse(c)}</li>)}</ul>
                </section>
              )}
              {leftover.length > 0 && (
                <section className="uncovered" aria-labelledby="wt-uncovered">
                  <h3 id="wt-uncovered">{T.uncovered}</h3>
                  <p className="muted">{T.uncoveredNote}</p>
                  {leftover.map((h) => <HunkBlock key={`${h.path}#${h.hunk}`} path={h.path} hunk={h} lang={lang} />)}
                </section>
              )}
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
            {streaming.steps.map((s, i) => (
              <section key={i} id={`step-${i + 1}`} className={s.mechanical ? 'step mechanical' : 'step'} aria-labelledby={`step-${i + 1}-title`}>
                <h3 id={`step-${i + 1}-title`}>
                  <span className="step-n">{T.stepLabel(i + 1)}</span> {renderProse(s.title)}
                  {s.mechanical && <span className="badge step-mech">{T.mechanical}</span>}
                </h3>
                <p className="step-body">{renderProse(s.body)}</p>
                <StepHunks refs={s.hunks} index={index} step={i + 1} current={step === i + 1} lang={lang} />
              </section>
            ))}
          </div>
        </div>
      ) : (
        <section className="full-diff" aria-labelledby="wt-diff">
          <h3 id="wt-diff">{T.fullDiff}</h3>
          {shown.map((f) => {
            const hunks = index.get(f.path) ?? [];
            return hunks.length > 0
              ? hunks.map((h) => <HunkBlock key={`${f.path}#${h.hunk}`} path={f.path} hunk={h} lang={lang} />)
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
