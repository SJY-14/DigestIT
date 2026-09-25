import { useState } from 'react';
import { Legend, TableToggle, type LegendItem } from './Legend.js';
import { useRovingIndex } from './roving.js';
import { bandScale, linearY, niceMax, ticks } from './scale.js';

export interface BarSeriesDef {
  key: string;
  label: string;
  /** CSS class applied to `.bar` and `.swatch`, e.g. `series-1` -> `var(--series-1)`. */
  className: string;
  values: number[];
}

export interface BarSeriesProps {
  categories: string[];
  series: BarSeriesDef[];
  mode?: 'grouped' | 'stacked';
  ariaLabel: string;
  formatValue?: (v: number) => string;
  /** Axis label text, kept separate from the category identity used for drill/tooltip/table. */
  formatCategory?: (category: string) => string;
  /** Drills a single bar: the category (e.g. a day) and which series it belongs to. */
  onDrill?: (category: string, seriesKey: string) => void;
}

const W = 720, H = 220, PAD = { l: 32, r: 8, t: 8, b: 24 };

/** Grouped or stacked bars over ordered categories (e.g. days). Hand-rolled SVG, no dependency. */
export function BarSeries({
  categories, series, mode = 'grouped', ariaLabel, formatValue = String, formatCategory = (c) => c, onDrill,
}: BarSeriesProps) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const legendItems: LegendItem[] = series.map((s) => ({ key: s.key, label: s.label, className: s.className }));
  const totals = categories.map((_, i) =>
    mode === 'stacked' ? series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0) : Math.max(0, ...series.map((s) => s.values[i] ?? 0)),
  );
  const max = niceMax(Math.max(0, ...totals));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const { slot, x } = bandScale(categories.length, PAD.l, iw);
  const barWidth = mode === 'stacked' ? Math.min(24, slot - 6) : Math.min(14, (slot - 6 - 2 * (series.length - 1)) / series.length);
  const groupWidth = mode === 'stacked' ? barWidth : barWidth * series.length + 2 * (series.length - 1);
  const y0 = linearY(0, max, PAD.t, ih);
  const tickVals = ticks(max);
  const marks = categories.length * series.length;
  const { tabIndex, onKeyDown, ref } = useRovingIndex(marks, (m) => {
    const ci = Math.floor(m / series.length), si = m % series.length;
    onDrill?.(categories[ci]!, series[si]!.key);
  });

  const summary = (i: number) => `${categories[i]}: ${series.map((s) => `${s.label} ${formatValue(s.values[i] ?? 0)}`).join(', ')}`;
  const markSummary = (i: number, si: number) => `${categories[i]}: ${series[si]!.label} ${formatValue(series[si]!.values[i] ?? 0)}`;

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
                <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={linearY(t, max, PAD.t, ih)} y2={linearY(t, max, PAD.t, ih)} />
                <text className="axis" x={PAD.l - 6} y={linearY(t, max, PAD.t, ih) + 4} textAnchor="end">{t}</text>
              </g>
            ))}
            {categories.map((c, i) => {
              const gx = x(i) + (slot - groupWidth) / 2;
              let stackY = y0;
              return (
                <g key={c}>
                  <rect x={x(i)} y={PAD.t} width={slot} height={ih} className="hit" />
                  {series.map((s, si) => {
                    const v = s.values[i] ?? 0;
                    const barH = Math.max(0, y0 - linearY(v, max, PAD.t, ih));
                    const bx = mode === 'stacked' ? gx : gx + si * (barWidth + 2);
                    const by = mode === 'stacked' ? stackY - barH : linearY(v, max, PAD.t, ih);
                    if (mode === 'stacked') stackY -= barH;
                    const m = i * series.length + si;
                    return (
                      <rect
                        key={s.key}
                        ref={ref(m)}
                        tabIndex={tabIndex(m)}
                        role="button"
                        aria-label={markSummary(i, si)}
                        className={`bar ${s.className}`}
                        x={bx}
                        y={by}
                        width={barWidth}
                        height={barH}
                        rx={2}
                        onKeyDown={(e) => onKeyDown(e, m)}
                        onFocus={() => setHover(i)}
                        onBlur={() => setHover((h) => (h === i ? null : h))}
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => onDrill?.(c, s.key)}
                      >
                        <title>{`${c}: ${s.label} ${formatValue(v)}`}</title>
                      </rect>
                    );
                  })}
                  {(i % 2 === categories.length % 2 || categories.length < 8) && (
                    <text className="axis" x={x(i) + slot / 2} y={H - 6} textAnchor="middle">{formatCategory(c)}</text>
                  )}
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
