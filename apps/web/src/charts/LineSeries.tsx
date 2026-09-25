import { useState } from 'react';
import { Legend, TableToggle, type LegendItem } from './Legend.js';
import { useRovingIndex } from './roving.js';
import { bandScale, linearY, niceMax, ticks } from './scale.js';

export interface LineSeriesDef {
  key: string;
  label: string;
  /** CSS class applied to `.line`/`.dot` and the legend swatch, e.g. `series-1`. */
  className: string;
  values: number[];
}

export interface LineSeriesProps {
  categories: string[];
  series: LineSeriesDef[];
  ariaLabel: string;
  formatValue?: (v: number) => string;
  /** Axis label text, kept separate from the category identity used for drill/tooltip/table. */
  formatCategory?: (category: string) => string;
  onDrill?: (category: string) => void;
}

const W = 720, H = 220, PAD = { l: 32, r: 12, t: 8, b: 24 };

/** One or more trend lines over ordered categories (e.g. a backlog trend per day). */
export function LineSeries({ categories, series, ariaLabel, formatValue = String, formatCategory = (c) => c, onDrill }: LineSeriesProps) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const legendItems: LegendItem[] = series.map((s) => ({ key: s.key, label: s.label, className: s.className }));
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const n = Math.max(1, categories.length - 1);
  const px = (i: number) => PAD.l + (categories.length <= 1 ? iw / 2 : (iw / n) * i);
  const py = (v: number) => linearY(v, max, PAD.t, ih);
  const tickVals = ticks(max);
  const { hitWidth } = { hitWidth: categories.length > 0 ? iw / categories.length : iw };
  const { tabIndex, onKeyDown, ref } = useRovingIndex(categories.length, (i) => onDrill?.(categories[i]!));

  const summary = (i: number) => `${categories[i]}: ${series.map((s) => `${s.label} ${formatValue(s.values[i] ?? 0)}`).join(', ')}`;

  return (
    <div className="chart-wrap">
      <div className="chart-head">
        <Legend items={legendItems} />
        <TableToggle table={table} onToggle={() => setTable((t) => !t)} />
      </div>
      {table ? (
        <table className="data">
          <thead>
            <tr>
              <th></th>
              {series.map((s) => <th className="num" key={s.key}>{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {categories.map((c, i) => (
              <tr key={c}>
                <td>{c}</td>
                {series.map((s) => <td className="num" key={s.key}>{formatValue(s.values[i] ?? 0)}</td>)}
              </tr>
            ))}
            {categories.length === 0 && <tr><td className="muted">No data.</td></tr>}
          </tbody>
        </table>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="chart">
            {tickVals.map((t) => (
              <g key={t}>
                <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={py(t)} y2={py(t)} />
                <text className="axis" x={PAD.l - 6} y={py(t) + 4} textAnchor="end">{t}</text>
              </g>
            ))}
            {series.map((s) => (
              <polyline
                key={s.key}
                className={`line ${s.className}`}
                fill="none"
                points={s.values.map((v, i) => `${px(i)},${py(v)}`).join(' ')}
              />
            ))}
            {categories.map((c, i) => (
              <g
                key={c}
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
                onClick={() => onDrill?.(c)}
              >
                <rect x={px(i) - hitWidth / 2} y={PAD.t} width={hitWidth} height={ih} className="hit" />
                {series.map((s) => (
                  <circle key={s.key} className={`dot ${s.className}`} cx={px(i)} cy={py(s.values[i] ?? 0)} r={4}>
                    <title>{`${c}: ${s.label} ${formatValue(s.values[i] ?? 0)}`}</title>
                  </circle>
                ))}
                {(i % 2 === categories.length % 2 || categories.length < 8) && (
                  <text className="axis" x={px(i)} y={H - 6} textAnchor="middle">{formatCategory(c)}</text>
                )}
              </g>
            ))}
          </svg>
          <p className="chart-tip" aria-hidden="true">{hover !== null ? summary(hover) : ' '}</p>
        </>
      )}
    </div>
  );
}
