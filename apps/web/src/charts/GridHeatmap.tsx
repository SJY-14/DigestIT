import { useState } from 'react';
import { TableToggle } from './Legend.js';
import { useRovingGrid } from './roving.js';
import { heatStep } from './scale.js';

export interface GridHeatmapProps {
  rows: string[];
  columns: string[];
  /** `values[row][col]`; missing cells count as 0 (no data). */
  values: number[][];
  ariaLabel: string;
  formatValue?: (v: number) => string;
  onDrill?: (row: string, column: string) => void;
  /** How often to draw a column label, so a 90-day grid doesn't collide. Default: every 7th. */
  columnLabelEvery?: number;
}

const CELL = 12, GAP = 2, PAD = { l: 90, r: 8, t: 8, b: 20 };

/** Contribution-graph-style grid: rows = areas, columns = days/weeks, 5-step single hue. */
export function GridHeatmap({ rows, columns, values, ariaLabel, formatValue = String, onDrill, columnLabelEvery = 7 }: GridHeatmapProps) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);
  const max = Math.max(0, ...values.flatMap((r) => r));
  const step = CELL + GAP;
  const W = PAD.l + columns.length * step + PAD.r;
  const H = PAD.t + rows.length * step + PAD.b;
  const { tabIndex, onKeyDown, ref } = useRovingGrid(rows.length, columns.length, (r, c) => onDrill?.(rows[r]!, columns[c]!));

  const at = (r: number, c: number) => values[r]?.[c] ?? 0;
  const summary = (r: number, c: number) => `${rows[r]}, ${columns[c]}: ${formatValue(at(r, c))}`;

  return (
    <div className="chart-wrap">
      <div className="chart-head">
        <span className="heat-scale" aria-hidden="true">
          <span className="muted">Less</span>
          {([0, 1, 2, 3, 4] as const).map((s) => <span key={s} className={`heat-swatch heat-${s}`} />)}
          <span className="muted">More</span>
        </span>
        <TableToggle table={table} onToggle={() => setTable((t) => !t)} />
      </div>
      {table ? (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr><th></th>{columns.map((c) => <th className="num" key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={r}>
                  <td>{r}</td>
                  {columns.map((c, ci) => <td className="num" key={c}>{formatValue(at(ri, ci))}</td>)}
                </tr>
              ))}
              {rows.length === 0 && <tr><td className="muted">No data.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel} className="chart heatmap">
            {rows.map((r, ri) => (
              <text key={r} className="axis" x={PAD.l - 8} y={PAD.t + ri * step + CELL - 2} textAnchor="end">{r}</text>
            ))}
            {columns.map((c, ci) =>
              ci % columnLabelEvery === 0 ? (
                <text key={c} className="axis" x={PAD.l + ci * step} y={H - 4} textAnchor="start">{c}</text>
              ) : null,
            )}
            {rows.map((r, ri) =>
              columns.map((c, ci) => (
                <rect
                  key={`${r}:${c}`}
                  ref={ref(ri, ci)}
                  tabIndex={tabIndex(ri, ci)}
                  role="button"
                  aria-label={summary(ri, ci)}
                  className={`cell heat-${heatStep(at(ri, ci), max)}`}
                  x={PAD.l + ci * step}
                  y={PAD.t + ri * step}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  onKeyDown={(e) => onKeyDown(e, ri, ci)}
                  onFocus={() => setHover({ row: ri, col: ci })}
                  onBlur={() => setHover((h) => (h && h.row === ri && h.col === ci ? null : h))}
                  onMouseEnter={() => setHover({ row: ri, col: ci })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onDrill?.(r, c)}
                >
                  <title>{summary(ri, ci)}</title>
                </rect>
              )),
            )}
          </svg>
          <p className="chart-tip" aria-hidden="true">{hover ? summary(hover.row, hover.col) : ' '}</p>
        </>
      )}
    </div>
  );
}
