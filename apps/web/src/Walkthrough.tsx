// L3 for one area (DIG-50, docs/ux-v3.md §2): the overview, then each step's title and body with
// the exact hunks it explains right under the text, "What to check", and last the hunks no step
// covers (cut by the token budget). Before a walkthrough exists (or while it is being written)
// the area's full diff is shown instead, so the code is always one click away.
import { useEffect, useMemo, useState } from 'react';
import type { AreaDetailDto, AreaWalkthrough, DigestL2Item, HunkRef } from '@digestit/core';
import { WALKTHROUGH as T, lineDelta } from './copy.js';
import { splitPatch, uncoveredHunks, type PatchHunk } from './hunks.js';
import type { DiffLine } from './diff.js';

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
export function HunkBlock({ path, hunk }: { path: string; hunk: PatchHunk }) {
  const [open, setOpen] = useState(false);
  const long = hunk.lines.length > FOLD_THRESHOLD;
  const lines = long && !open ? hunk.lines.slice(0, FOLD_PREVIEW) : hunk.lines;
  return (
    <figure className="hunk-block">
      <figcaption><code>{path}</code></figcaption>
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

function StepHunks({ refs, index }: { refs: HunkRef[]; index: HunkIndex }) {
  return (
    <>
      {refs.map((r) => {
        const h = index.get(r.path)?.[r.hunk - 1];
        return h
          ? <HunkBlock key={`${r.path}#${r.hunk}`} path={r.path} hunk={h} />
          : <p key={`${r.path}#${r.hunk}`} className="muted hunk-missing">{T.missingHunk(r.path, r.hunk)}</p>;
      })}
    </>
  );
}

function StepNav({ step, total, onStep }: { step: number | null; total: number; onStep: (n: number) => void }) {
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
  item: DigestL2Item;
  /** 1-based current step, or null (at the overview). */
  step: number | null;
  onStep: (n: number) => void;
  /** Request (or retry) this area's walkthrough. */
  onGenerate: () => void;
  /** Remaining daily LLM calls; null when unknown. */
  callsRemaining: number | null;
}

export function WalkthroughView({ area, item, step, onStep, onGenerate, callsRemaining }: WalkthroughViewProps) {
  const walkthrough = walkthroughOf(area);
  const shown = useMemo(() => area.files.filter((f) => !f.filteredReason), [area.files]);
  const filtered = area.files.filter((f) => f.filteredReason);
  const index: HunkIndex = useMemo(() => new Map(shown.map((f) => [f.path, splitPatch(f.patch ?? '')])), [shown]);
  const leftover = useMemo(() => uncoveredHunks(shown, walkthrough), [shown, walkthrough]);
  const steps = walkthrough?.steps ?? [];
  const stats = shown.reduce((s, f) => ({ a: s.a + f.additions, d: s.d + f.deletions }), { a: 0, d: 0 });

  // Bring the current step to the top of the reading pane when it changes (n/p, the side list, a
  // reload with &step=). The step bar is sticky, so steps carry a matching scroll-margin.
  useEffect(() => {
    if (step === null || !walkthrough) return;
    document.getElementById(`step-${step}`)?.scrollIntoView?.({ block: 'start' });
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
    <article className="walkthrough" aria-label={T.regionLabel(item.title)}>
      <header className="walkthrough-head">
        <h2>{item.title}</h2>
        <p className="muted">
          {item.effect} <span className="stats"><span className="add">+{stats.a}</span> <span className="del">−{stats.d}</span></span>
          <span className="visually-hidden"> ({lineDelta(stats.a, stats.d)})</span>
        </p>
      </header>
      {notice}
      {walkthrough ? (
        <>
          {steps.length > 0 && <StepNav step={step} total={steps.length} onStep={onStep} />}
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
                        <span className="step-toc-n">{i + 1}</span> {s.title}
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            <div className="walkthrough-main">
              <section className="overview" aria-labelledby="wt-overview">
                <h3 id="wt-overview">{T.overview}</h3>
                <p>{walkthrough.overview}</p>
              </section>
              {steps.map((s, i) => (
                <section
                  key={i}
                  id={`step-${i + 1}`}
                  className={['step', s.mechanical && 'mechanical', step === i + 1 && 'current'].filter(Boolean).join(' ')}
                  aria-labelledby={`step-${i + 1}-title`}
                >
                  <h3 id={`step-${i + 1}-title`}>
                    <span className="step-n">{T.stepLabel(i + 1)}</span> {s.title}
                    {s.mechanical && <span className="badge step-mech">{T.mechanical}</span>}
                  </h3>
                  <p className="step-body">{s.body}</p>
                  <StepHunks refs={s.hunks} index={index} />
                </section>
              ))}
              {walkthrough.check.length > 0 && (
                <section className="check" aria-labelledby="wt-check">
                  <h3 id="wt-check">{T.check}</h3>
                  <ul>{walkthrough.check.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </section>
              )}
              {leftover.length > 0 && (
                <section className="uncovered" aria-labelledby="wt-uncovered">
                  <h3 id="wt-uncovered">{T.uncovered}</h3>
                  <p className="muted">{T.uncoveredNote}</p>
                  {leftover.map((h) => <HunkBlock key={`${h.path}#${h.hunk}`} path={h.path} hunk={h} />)}
                </section>
              )}
            </div>
          </div>
        </>
      ) : (
        <section className="full-diff" aria-labelledby="wt-diff">
          <h3 id="wt-diff">{T.fullDiff}</h3>
          {shown.map((f) => {
            const hunks = index.get(f.path) ?? [];
            return hunks.length > 0
              ? hunks.map((h) => <HunkBlock key={`${f.path}#${h.hunk}`} path={f.path} hunk={h} />)
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
