import { useEffect, useRef, useState } from 'react';
import { commitLabel, formatDate, shortSha } from './format.js';
import { Graph } from './Graph.js';
import { useTimeline } from './useTimeline.js';

export function App() {
  const { repos, repoId, setRepoId, rows, done, loading, error, loadMore } = useTimeline();
  const [selected, setSelected] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // Infinite scroll: fetch the next page when the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMore(), {
      rootMargin: '600px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [done, error, loadMore, rows.length]);

  const gutter = rows.reduce((m, r) => Math.max(m, r.lanes.width), 1);

  return (
    <div className="app">
      <header className="top">
        <h1>DigestIT</h1>
        {repos.length > 1 && (
          <select aria-label="Repository" value={repoId ?? ''} onChange={(e) => setRepoId(Number(e.target.value))}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        {repos.length === 1 && <span className="repo-name">{repos[0]?.name}</span>}
      </header>
      <main>
        {error && (
          <p role="alert" className="error">
            Could not load the timeline: {error}{' '}
            <button type="button" onClick={() => void loadMore()}>
              Retry
            </button>
          </p>
        )}
        {done && rows.length === 0 && !error && <p className="muted">No commits ingested yet. Run <code>digest ingest</code>.</p>}
        <ol className="timeline" aria-label="Commits, newest first">
          {rows.map(({ commit: c, lanes }) => {
            const label = commitLabel(c);
            return (
              <li key={c.sha} className="row">
                <Graph row={lanes} isMerge={c.isMerge} width={gutter} />
                <button
                  type="button"
                  className="commit"
                  aria-current={selected === c.sha ? 'true' : undefined}
                  onClick={() => setSelected(c.sha)}
                >
                  <span className="label-line">
                    <span className={label.explained ? 'label' : 'label pending'}>{label.text}</span>
                    {c.branchRefs.map((r) => (
                      <span key={r} className="ref">
                        {r}
                      </span>
                    ))}
                  </span>
                  <span className="meta">
                    <time dateTime={c.committedAt}>{formatDate(c.committedAt)}</time>
                    <span>{c.authorName}</span>
                    <code>{shortSha(c.sha)}</code>
                    {c.isMerge && <span>merge</span>}
                    {!label.explained && <span>L0 pending</span>}
                    <span className="stats">
                      {c.stats.files} {c.stats.files === 1 ? 'file' : 'files'}{' '}
                      <span className="add">+{c.stats.additions}</span> <span className="del">−{c.stats.deletions}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div ref={sentinel} className="sentinel" aria-live="polite">
          {loading && <span className="muted">Loading…</span>}
          {!loading && !done && !error && (
            <button type="button" onClick={() => void loadMore()}>
              Load more
            </button>
          )}
          {done && rows.length > 0 && <span className="muted">{rows.length} commits, start of history</span>}
        </div>
      </main>
    </div>
  );
}
