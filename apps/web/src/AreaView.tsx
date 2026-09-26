// L3 area view (DIG-41, docs/direction-v2.md §4-5): why/design/risks, then the diff. Hunks of
// <= 20 lines show inline with their notes; longer ones fold to the annotated lines +/- 3, with
// an Expand per fold and a Show all per file. Swaps in for the project graph in the right pane;
// "Back to graph" returns. If `focusPath` names a file, it opens first and is scrolled to.
import { useEffect, useRef, useState } from 'react';
import type { AreaDetailDto, DigestFileDto } from '@digestit/core';
import { annotate, foldHunk, keyLineSet, lineRange, parsePatch, splitHunks, type Annotation, type DiffLine } from './diff.js';

function Note({ note }: { note: Annotation }) {
  return (
    <div className="note" role="note">
      <div className="note-head">{lineRange(note)}</div>
      <p>{note.note}</p>
    </div>
  );
}

function DiffRow({ line, keyLine }: { line: DiffLine; keyLine: boolean }) {
  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  return (
    <>
      <tr className={`dl ${line.kind}${keyLine ? ' key' : ''}`}>
        <td className="no">{line.oldNo ?? ''}</td>
        <td className="no">{line.newNo ?? ''}</td>
        <td className="code">{line.kind === 'hunk' ? line.text : <><span aria-hidden="true">{marker}</span>{line.text}</>}</td>
      </tr>
      {line.notes.map((n, i) => (
        <tr key={i} className="annotation">
          <td colSpan={3}><Note note={n} /></td>
        </tr>
      ))}
    </>
  );
}

function FoldedHunk({ header, content, keySet, showAll, foldKeyPrefix, openFolds, onExpandFold }: {
  header: DiffLine;
  content: DiffLine[];
  keySet: Set<DiffLine>;
  showAll: boolean;
  foldKeyPrefix: string;
  openFolds: ReadonlySet<string>;
  onExpandFold: (key: string) => void;
}) {
  const segments = foldHunk(content, keySet);
  return (
    <>
      <DiffRow line={header} keyLine={false} />
      {segments.map((seg, si) => {
        const foldKey = `${foldKeyPrefix}:${si}`;
        if (seg.visible || showAll || openFolds.has(foldKey)) {
          return seg.lines.map((l, li) => <DiffRow key={`${si}-${li}`} line={l} keyLine={keySet.has(l)} />);
        }
        return (
          <tr key={foldKey} className="fold">
            <td colSpan={3}>
              <button type="button" className="btn fold-expand" onClick={() => onExpandFold(foldKey)}>
                Expand {seg.lines.length} {seg.lines.length === 1 ? 'line' : 'lines'}
              </button>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function AreaFile({ file, annotations, focused }: {
  file: DigestFileDto & { patch: string | null };
  annotations: Annotation[];
  focused: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
  const lines = parsePatch(file.patch ?? '');
  const fileAnnotations = annotations.filter((a) => a.path === file.path);
  const unplaced = annotate(lines, fileAnnotations);
  const keySet = keyLineSet(lines, fileAnnotations);
  const hunks = splitHunks(lines);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'start' });
  }, [focused]);

  return (
    <details ref={ref} className="file" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <code>{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}</code>{' '}
        <span className="stats"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
      </summary>
      {lines.length === 0 ? (
        <p className="muted">No textual changes to show.</p>
      ) : (
        <>
          {hunks.some((h) => h.content.length > 20) && (
            <div className="fold-actions">
              <button type="button" className="btn" onClick={() => setShowAll((s) => !s)}>{showAll ? 'Fold' : 'Show all'}</button>
            </div>
          )}
          <table className="diff">
            <tbody>
              {hunks.map((h, hi) => (
                <FoldedHunk
                  key={hi}
                  header={h.header}
                  content={h.content}
                  keySet={keySet}
                  showAll={showAll}
                  foldKeyPrefix={`${file.path}:${hi}`}
                  openFolds={openFolds}
                  onExpandFold={(k) => setOpenFolds((s) => new Set(s).add(k))}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
      {unplaced.map((a, i) => <div key={i} className="loose"><Note note={a} /></div>)}
    </details>
  );
}

export interface AreaViewProps {
  area: AreaDetailDto;
  /** L0 for the area (the row's title), shown as the pane heading. */
  title: string;
  onBack: () => void;
  /** File to open and scroll to first (set when a file node was selected in the graph). */
  focusPath?: string | null;
}

export function AreaView({ area, title, onBack, focusPath }: AreaViewProps) {
  const l3 = area.l3;
  const shown = area.files.filter((f) => !f.filteredReason);
  const filtered = area.files.filter((f) => f.filteredReason);
  const annotations: Annotation[] = l3?.notes ?? [];

  return (
    <section className="area-view" aria-label={`Code: ${title}`}>
      <div className="area-view-head">
        <button type="button" className="btn back" onClick={onBack}>← Back to graph</button>
        <h2>{title}</h2>
      </div>
      {area.status === 'pending' && <p className="muted">Generating this area's explanation…</p>}
      {area.status === 'error' && <p role="alert" className="error">Could not generate this area's explanation.</p>}
      {l3 && (
        <div className="area-l3">
          <p>{l3.why}</p>
          <p className="muted">{l3.design}</p>
          {l3.risks.length > 0 && (
            <>
              <h3>Risks</h3>
              <ul>{l3.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </>
          )}
        </div>
      )}
      {shown.map((f) => <AreaFile key={f.path} file={f} annotations={annotations} focused={f.path === focusPath} />)}
      {filtered.length > 0 && (
        <section aria-label="Not analysed">
          <h3>Not analysed</h3>
          <ul className="not-analysed">
            {filtered.map((f) => <li key={f.path}><code>{f.path}</code> <span className="muted">({f.filteredReason})</span></li>)}
          </ul>
        </section>
      )}
    </section>
  );
}
