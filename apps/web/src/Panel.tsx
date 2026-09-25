import { useEffect, useState, type ReactNode } from 'react';
import { fetchChange, fetchExplanation, type ChangeDetail, type Explanation, type Level } from './api.js';
import { annotate, keyLineSet, lineRange, parsePatch, type Annotation } from './diff.js';
import { shortSha } from './format.js';
import { LEVELS } from './level.js';

// All generated text below is rendered as React text nodes (escaped); never as HTML.

type State<T> = { data: T | null; error: string | null };

function useFetched<T>(key: string, load: (s: AbortSignal) => Promise<T>): State<T> & { loading: boolean } {
  const [s, setS] = useState<{ key: string; data: T | null; error: string | null }>({ key: '', data: null, error: null });
  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal).then(
      (data) => !ac.signal.aborted && setS({ key, data, error: null }),
      (e: unknown) => !ac.signal.aborted && setS({ key, data: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = s.key === key;
  return { data: fresh ? s.data : null, error: fresh ? s.error : null, loading: !fresh };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function StatusNote({ e }: { e: Explanation }) {
  if (e.status === 'pending') return <p className="muted">Not generated yet. Run <code>digest explain</code>.</p>;
  if (e.status === 'error') return <p className="error">Generation failed for this level.</p>;
  if (e.status === 'truncated') return <p className="muted">Output was truncated; showing what was recovered.</p>;
  return null;
}

function Text({ e }: { e: Explanation }) {
  const c = rec(e.content);
  return <p className="l0">{isStr(c.text) ? c.text : ''}</p>;
}

function Behavior({ e }: { e: Explanation }) {
  const c = rec(e.content);
  const bullets = strs(c.bullets);
  return (
    <>
      <p className="muted">{c.userVisible === true ? 'Visible to users.' : 'No user-visible change.'}</p>
      <ul>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
    </>
  );
}

function Structure({ e }: { e: Explanation }) {
  const c = rec(e.content);
  const items = (Array.isArray(c.items) ? c.items : []).map(rec);
  const notAnalysed = strs(c.notAnalysed);
  return (
    <>
      <ul className="items">
        {items.map((it, i) => (
          <li key={i}>
            <code>{String(it.path ?? '')}</code> <span className="muted role">{String(it.role ?? '')}</span>
            <div>{String(it.change ?? '')}</div>
          </li>
        ))}
      </ul>
      <NotAnalysed paths={notAnalysed} />
    </>
  );
}

function NotAnalysed({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <section aria-label="Not analysed">
      <h3>Not analysed</h3>
      <ul className="not-analysed">{paths.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
    </section>
  );
}

function parseAnnotations(content: unknown): Annotation[] {
  const raw = rec(content).annotations;
  return (Array.isArray(raw) ? raw : []).map(rec).flatMap((a) =>
    (a.side === 'new' || a.side === 'old') && isStr(a.path) && isStr(a.note) && Number.isInteger(a.startLine) && Number.isInteger(a.endLine)
      ? [{ path: a.path, side: a.side, startLine: a.startLine as number, endLine: a.endLine as number, note: a.note }]
      : [],
  );
}

function FileDiff({ file, annotations }: { file: NonNullable<Explanation['files']>[number]; annotations: Annotation[] }) {
  const lines = parsePatch(file.patch ?? '');
  const unplaced = annotate(lines, annotations);
  const key = keyLineSet(lines, annotations);
  return (
    <details className="file" open>
      <summary>
        <code>{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}</code>{' '}
        <span className="stats"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
      </summary>
      {lines.length === 0 ? (
        <p className="muted">No textual changes to show.</p>
      ) : (
        <table className="diff">
          <tbody>
            {lines.map((l, i) => (
              <DiffRow key={i} line={l} key_={key.has(l)} />
            ))}
          </tbody>
        </table>
      )}
      {unplaced.map((a, i) => <div key={i} className="loose"><Note a={a} /></div>)}
    </details>
  );
}

function DiffRow({ line: l, key_ }: { line: ReturnType<typeof parsePatch>[number]; key_: boolean }) {
  const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
  return (
    <>
      <tr className={`dl ${l.kind}${key_ ? ' key' : ''}`}>
        <td className="no">{l.oldNo ?? ''}</td>
        <td className="no">{l.newNo ?? ''}</td>
        <td className="code">{l.kind === 'hunk' ? l.text : <><span aria-hidden="true">{marker}</span>{l.text}</>}</td>
      </tr>
      {l.notes.map((n, i) => (
        <tr key={i} className="annotation">
          <td colSpan={3}><Note a={n} /></td>
        </tr>
      ))}
    </>
  );
}

function Note({ a }: { a: Annotation }) {
  return (
    <div className="note" role="note">
      <div className="note-head">{lineRange(a)}</div>
      <p>{a.note}</p>
    </div>
  );
}

function Code({ e }: { e: Explanation }) {
  const annotations = parseAnnotations(e.content);
  const files = e.files ?? [];
  const shown = files.filter((f) => !f.filteredReason);
  const filtered = files.filter((f) => f.filteredReason);
  return (
    <>
      {shown.map((f) => <FileDiff key={f.path} file={f} annotations={annotations.filter((a) => a.path === f.path)} />)}
      {filtered.length > 0 && (
        <section aria-label="Not analysed">
          <h3>Not analysed</h3>
          <ul className="not-analysed">
            {filtered.map((f) => (
              <li key={f.path}><code>{f.path}</code> <span className="muted">({f.filteredReason})</span></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Body({ changeId, level }: { changeId: number; level: Level }) {
  const { data, error, loading } = useFetched(`${changeId}:${level}`, (s) => fetchExplanation(changeId, level, s));
  if (loading) return <p className="muted">Loading…</p>;
  if (error || !data) return <p role="alert" className="error">Could not load explanation: {error}</p>;
  return (
    <>
      <StatusNote e={data} />
      {data.status !== 'pending' && data.status !== 'error' && level === 0 && <Text e={data} />}
      {data.status !== 'pending' && data.status !== 'error' && level === 1 && <Behavior e={data} />}
      {data.status !== 'pending' && data.status !== 'error' && level === 2 && <Structure e={data} />}
      {level === 3 && <Code e={data} />}
    </>
  );
}

export function Panel({ changeId, sha, title, level, onLevel, onClose, children, emptyNote }: {
  changeId: number | null;
  sha: string;
  title: string;
  level: Level;
  onLevel: (l: Level) => void;
  onClose: () => void;
  /** Extra content between the header and the level tabs (used by the work-unit panel). */
  children?: ReactNode;
  emptyNote?: string;
}) {
  const change = useFetched<ChangeDetail | null>(`c${changeId}`, (s) => (changeId === null ? Promise.resolve(null) : fetchChange(changeId, s)));
  return (
    <aside className="panel" aria-label="Explanation">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <span className="panel-meta">{sha && <code>{shortSha(sha)}</code>}{change.data?.commit ? ` · ${change.data.commit.authorName}` : ''}</span>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close explanation">×</button>
      </div>
      {children}
      <div role="tablist" aria-label="Explanation level" className="tabs">
        {LEVELS.map((l) => (
          <button
            key={l.level}
            type="button"
            role="tab"
            id={`tab-${l.level}`}
            aria-selected={level === l.level}
            aria-controls="level-panel"
            tabIndex={level === l.level ? 0 : -1}
            onClick={() => onLevel(l.level)}
            onKeyDown={(e) => {
              const next: Level | null =
                e.key === 'ArrowRight' ? (((level + 1) % 4) as Level)
                : e.key === 'ArrowLeft' ? (((level + 3) % 4) as Level)
                : e.key === 'Home' ? 0
                : e.key === 'End' ? 3
                : null;
              if (next === null) return;
              e.preventDefault();
              onLevel(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
          >
            {l.name} <span className="muted">{l.hint}</span>
          </button>
        ))}
      </div>
      <div id="level-panel" role="tabpanel" aria-labelledby={`tab-${level}`} className="level-body">
        {changeId === null ? <p className="muted">{emptyNote ?? 'This commit has not been ingested as a change yet.'}</p> : <Body changeId={changeId} level={level} />}
      </div>
    </aside>
  );
}
