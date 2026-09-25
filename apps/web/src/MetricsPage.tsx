import { useState } from 'react';
import type { Metrics } from './api.js';
import { formatDuration } from './feed.js';

// Two series, categorical slots 1 and 2 of the validated dataviz palette (blue, orange), stepped
// per color scheme in styles.css. Identity is never color alone: legend + table view + bar titles.

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note muted">{note}</div>}
    </div>
  );
}

const W = 720, H = 220, PAD = { l: 32, r: 8, t: 8, b: 24 };

/** Nice axis maximum so gridlines land on whole counts. */
export function niceMax(n: number): number {
  return n <= 4 ? 4 : Math.ceil(n / 4) * 4;
}

export function PerDayChart({ days }: { days: Metrics['global']['digestVsProduction']['perDay'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...days.flatMap((d) => [d.landed, d.decided])));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const slot = iw / Math.max(1, days.length);
  const bw = Math.min(14, (slot - 6) / 2);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const hovered = hover === null ? null : days[hover];
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Units landed and decided per day, last 14 days" className="chart">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{t}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x0 = PAD.l + slot * i + (slot - (bw * 2 + 2)) / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={ih} className="hit" />
              <rect className="bar landed" x={x0} y={y(d.landed)} width={bw} height={Math.max(0, y(0) - y(d.landed))} rx={2}>
                <title>{`${d.day}: ${d.landed} landed`}</title>
              </rect>
              <rect className="bar decided" x={x0 + bw + 2} y={y(d.decided)} width={bw} height={Math.max(0, y(0) - y(d.decided))} rx={2}>
                <title>{`${d.day}: ${d.decided} decided`}</title>
              </rect>
              {(i % 2 === days.length % 2 || days.length < 8) && (
                <text className="axis" x={PAD.l + slot * i + slot / 2} y={H - 6} textAnchor="middle">{d.day.slice(5)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="chart-tip" aria-hidden="true">
        {hovered ? `${hovered.day}: ${hovered.landed} landed, ${hovered.decided} decided` : ' '}
      </p>
    </div>
  );
}

/**
 * Metrics come from the app's live feed (useLive), so this page opens no second /api/stream:
 * browsers allow only ~6 HTTP/1.1 connections per origin, and each open SSE stream holds one.
 */
export function MetricsPage({ metrics: m, error }: { metrics: Metrics | null; error: string | null }) {
  const [table, setTable] = useState(false);

  if (error && !m) return <p role="alert" className="error">Could not load metrics: {error}</p>;
  if (!m) return <p className="muted">Loading…</p>;
  const g = m.global;
  const dp = g.digestVsProduction;
  const ratio = dp.ratio === null ? '–' : dp.ratio.toFixed(2);
  const keeping = dp.ratio === null ? null : dp.ratio >= 1;

  return (
    <div className="metrics">
      <div className="tiles">
        <Tile label="Unread backlog" value={String(g.unreadBacklog)} note="landed, never opened" />
        <Tile label="Undecided backlog" value={String(g.undecidedBacklog)} note="not reviewed or merged" />
        <Tile label="Median time to open" value={formatDuration(g.medianTimeToOpenSec)} />
        <Tile label="Median time to decide" value={formatDuration(g.medianTimeToDecideSec)} />
        <Tile
          label={`Digest ÷ production, ${dp.windowDays} d`}
          value={ratio}
          note={keeping === null ? 'nothing landed yet' : keeping ? 'keeping up: decided ≥ landed' : 'falling behind: decided < landed'}
        />
      </div>

      <section className="box" aria-labelledby="perday">
        <div className="box-head">
          <h2 id="perday" className="box-title">Units per day</h2>
          <span className="legend">
            <span className="key-item"><span className="swatch landed" aria-hidden="true" />Landed</span>
            <span className="key-item"><span className="swatch decided" aria-hidden="true" />Decided</span>
          </span>
          <button type="button" className="btn view-toggle" aria-pressed={table} onClick={() => setTable((t) => !t)}>
            {table ? 'Show chart' : 'Show table'}
          </button>
        </div>
        <div className="box-body">
          {table ? (
            <table className="data">
              <thead><tr><th>Day (UTC)</th><th className="num">Landed</th><th className="num">Decided</th></tr></thead>
              <tbody>{dp.perDay.map((d) => <tr key={d.day}><td>{d.day}</td><td className="num">{d.landed}</td><td className="num">{d.decided}</td></tr>)}</tbody>
            </table>
          ) : (
            <PerDayChart days={dp.perDay} />
          )}
        </div>
      </section>

      <section className="box" aria-labelledby="perunit">
        <div className="box-head"><h2 id="perunit" className="box-title">Per unit</h2></div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Unit</th><th>State</th><th className="num">To explain</th><th className="num">To open</th>
                <th className="num">To decide</th><th>Levels viewed</th><th className="num">Re-opens</th>
              </tr>
            </thead>
            <tbody>
              {[...m.units].reverse().map((u) => (
                <tr key={u.id}>
                  <td><code>{u.key}</code></td>
                  <td>{u.state}{u.decidedBy ? ` · ${u.decidedBy}` : ''}</td>
                  <td className="num">{formatDuration(u.timeToExplainSec)}</td>
                  <td className="num">{formatDuration(u.timeToOpenSec)}</td>
                  <td className="num">{formatDuration(u.timeToDecideSec)}</td>
                  <td>{u.levelsViewedBeforeDeciding.length ? u.levelsViewedBeforeDeciding.map((l) => `L${l}`).join(' ') : '–'}</td>
                  <td className="num">{u.reopens}</td>
                </tr>
              ))}
              {m.units.length === 0 && <tr><td colSpan={7} className="muted">No work units yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="hint">Local only: derived from git and viewer events on this server. One reader, so read the numbers as trends.</p>
    </div>
  );
}
