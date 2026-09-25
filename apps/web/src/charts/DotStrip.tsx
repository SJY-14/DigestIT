import { useState } from 'react';
import { TableToggle } from './Legend.js';
import { useRovingIndex } from './roving.js';
import { bandScale, jitter, linearY, median, niceMax, ticks } from './scale.js';

export interface DotStripGroup {
  key: string;
  values: number[];
}

export interface DotStripProps {
  groups: DotStripGroup[];
  ariaLabel: string;
  formatValue?: (v: number) => string;
  /** Axis label text, kept separate from the group identity used for drill/tooltip/table. */
  formatGroup?: (group: string) => string;
  onDrill?: (group: string) => void;
}

const W = 720, H = 220, PAD = { l: 32, r: 8, t: 8, b: 24 };
const DOT_R = 4, DOT_GAP = 10;

/** One column per group, a dot per value (jittered so close values stay legible), a median tick. */
export function DotStrip({ groups, ariaLabel, formatValue = String, formatGroup = (g) => g, onDrill }: DotStripProps) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...groups.flatMap((g) => g.values)));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const { slot, x } = bandScale(groups.length, PAD.l, iw);
  const tickVals = ticks(max);
  const { tabIndex, onKeyDown, ref } = useRovingIndex(groups.length, (i) => onDrill?.(groups[i]!.key));

  const summary = (i: number) => {
    const g = groups[i]!;
    return `${g.key}: ${g.values.length} value${g.values.length === 1 ? '' : 's'}, median ${formatValue(median(g.values))}`;
  };

  return (
    <div className="chart-wrap">
      <div className="chart-head">
        <span className="legend">
          <span className="key-item"><span className="swatch median-tick" aria-hidden="true" />Median</span>
        </span>
        <TableToggle table={table} onToggle={() => setTable((t) => !t)} />
      </div>
      {table ? (
        <table className="data">
          <thead>
            <tr><th>Group</th><th className="num">Count</th><th className="num">Median</th><th>Values</th></tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                <td>{g.key}</td>
                <td className="num">{g.values.length}</td>
                <td className="num">{formatValue(median(g.values))}</td>
                <td>{g.values.map(formatValue).join(', ') || '–'}</td>
              </tr>
            ))}
            {groups.length === 0 && <tr><td className="muted">No data.</td></tr>}
          </tbody>
        </table>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel} className="chart">
            {tickVals.map((t) => (
              <g key={t}>
                <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={linearY(t, max, PAD.t, ih)} y2={linearY(t, max, PAD.t, ih)} />
                <text className="axis" x={PAD.l - 6} y={linearY(t, max, PAD.t, ih) + 4} textAnchor="end">{t}</text>
              </g>
            ))}
            {groups.map((g, i) => {
              const cx = x(i) + slot / 2;
              const sorted = [...g.values].sort((a, b) => a - b);
              const m = median(g.values);
              return (
                <g
                  key={g.key}
                  ref={ref(i)}
                  tabIndex={tabIndex(i)}
                  role="button"
                  aria-label={summary(i)}
                  className="mark-group"
                  onKeyDown={(e) => onKeyDown(e, i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover((h) => (h === i ? null : h))}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onDrill?.(g.key)}
                >
                  <rect x={x(i)} y={PAD.t} width={slot} height={ih} className="hit" />
                  {g.values.length > 0 && (
                    <line className="median-tick" x1={cx - 10} x2={cx + 10} y1={linearY(m, max, PAD.t, ih)} y2={linearY(m, max, PAD.t, ih)}>
                      <title>{`${g.key}: median ${formatValue(m)}`}</title>
                    </line>
                  )}
                  {sorted.map((v, rank) => (
                    <circle key={rank} className="dot series-1" cx={cx + jitter(rank) * DOT_GAP} cy={linearY(v, max, PAD.t, ih)} r={DOT_R}>
                      <title>{`${g.key}: ${formatValue(v)}`}</title>
                    </circle>
                  ))}
                  <text className="axis" x={cx} y={H - 6} textAnchor="middle">{formatGroup(g.key)}</text>
                </g>
              );
            })}
          </svg>
          <p className="chart-tip" aria-hidden="true">{hover !== null ? summary(hover) : ' '}</p>
        </>
      )}
    </div>
  );
}
