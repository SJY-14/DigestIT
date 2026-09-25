import { useCallback, useEffect, useState } from 'react';
import type { Metrics, OpenedVia, WorkUnitMember, WorkUnitSummary } from './api.js';
import { BarSeries } from './charts/BarSeries.js';
import { DrillList } from './DrillList.js';
import type { ReviewState } from './feed.js';
import { formatDuration } from './feed.js';

export type InsightsTab = 'digest' | 'map' | 'blindspots';

const TABS: { key: InsightsTab; label: string }[] = [
  { key: 'digest', label: 'Digest' },
  { key: 'map', label: 'Map' },
  { key: 'blindspots', label: 'Blind spots' },
];

export interface InsightsUrlState {
  tab: InsightsTab;
  window: string | null;
  area: string | null;
  day: string | null;
}

function parseTab(v: string | null): InsightsTab {
  return v === 'map' || v === 'blindspots' ? v : 'digest';
}

/** `?window=&area=&day=` (plus `tab=`) so a chart selection survives reload and can be linked. */
export function readInsightsUrlState(search: string): InsightsUrlState {
  const q = new URLSearchParams(search);
  return { tab: parseTab(q.get('tab')), window: q.get('window'), area: q.get('area'), day: q.get('day') };
}

export function insightsUrlSearch(state: InsightsUrlState): string {
  const q = new URLSearchParams();
  if (state.tab !== 'digest') q.set('tab', state.tab);
  if (state.window) q.set('window', state.window);
  if (state.area) q.set('area', state.area);
  if (state.day) q.set('day', state.day);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function useInsightsUrlState(active: boolean): [InsightsUrlState, (patch: Partial<InsightsUrlState>) => void] {
  const [state, setState] = useState<InsightsUrlState>(() => readInsightsUrlState(location.search));
  useEffect(() => {
    if (!active) return;
    const on = () => setState(readInsightsUrlState(location.search));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, [active]);
  const patch = useCallback((p: Partial<InsightsUrlState>) => {
    setState((s) => {
      const next = { ...s, ...p };
      history.replaceState(null, '', `/insights${insightsUrlSearch(next)}`);
      return next;
    });
  }, []);
  return [state, patch];
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note muted">{note}</div>}
    </div>
  );
}

interface Drill {
  day: string;
  metric: string;
  label: string;
}

const METRIC_LABEL: Record<string, string> = { landed: 'Landed', decided: 'Decided' };

function DigestTab({ metrics, error, reviews, onSelectUnit, onOpenCommit }: {
  metrics: Metrics | null;
  error: string | null;
  reviews: Map<number, ReviewState>;
  onSelectUnit: (u: WorkUnitSummary, via: OpenedVia) => void;
  onOpenCommit: (m: WorkUnitMember, via: OpenedVia) => void;
}) {
  const [drill, setDrill] = useState<Drill | null>(null);
  if (error && !metrics) return <p role="alert" className="error">Could not load metrics: {error}</p>;
  if (!metrics) return <p className="muted">Loading…</p>;
  const g = metrics.global;
  const dp = g.digestVsProduction;
  const ratio = dp.ratio === null ? '–' : dp.ratio.toFixed(2);
  const keeping = dp.ratio === null ? null : dp.ratio >= 1;

  return (
    <div className="insights-tab">
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
        <div className="box-head"><h2 id="perday" className="box-title">Units per day</h2></div>
        <div className="box-body">
          <BarSeries
            ariaLabel={`Units landed and decided per day, last ${dp.perDay.length} days`}
            categories={dp.perDay.map((d) => d.day)}
            formatCategory={(c) => c.slice(5)}
            series={[
              { key: 'landed', label: 'Landed', className: 'series-1', values: dp.perDay.map((d) => d.landed) },
              { key: 'decided', label: 'Decided', className: 'series-2', values: dp.perDay.map((d) => d.decided) },
            ]}
            onDrill={(day, metric) => setDrill({ day, metric, label: `${METRIC_LABEL[metric] ?? metric} on ${day}` })}
          />
        </div>
      </section>

      {drill && (
        <section className="box" aria-labelledby="drill">
          <div className="box-head">
            <h2 id="drill" className="box-title">{drill.label}</h2>
            <button type="button" className="btn view-toggle" onClick={() => setDrill(null)}>Close</button>
          </div>
          <div className="box-body">
            <DrillList query={{ day: drill.day, metric: drill.metric }} via="digest" reviews={reviews} label={drill.label} onSelect={onSelectUnit} onOpenCommit={onOpenCommit} />
          </div>
        </section>
      )}

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
              {[...metrics.units].reverse().map((u) => (
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
              {metrics.units.length === 0 && <tr><td colSpan={7} className="muted">No work units yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="hint">Local only: derived from git and viewer events on this server. One reader, so read the numbers as trends.</p>
    </div>
  );
}

function NotAvailable({ what }: { what: string }) {
  return <p className="muted">{what} isn't available yet — it needs the insights data API.</p>;
}

export function Insights({ metrics, error, reviews, onSelectUnit, onOpenCommit }: {
  metrics: Metrics | null;
  error: string | null;
  reviews: Map<number, ReviewState>;
  onSelectUnit: (u: WorkUnitSummary, via: OpenedVia) => void;
  onOpenCommit: (m: WorkUnitMember, via: OpenedVia) => void;
}) {
  const [state, setState] = useInsightsUrlState(true);
  return (
    <div className="insights">
      <div role="tablist" aria-label="Insights" className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={state.tab === t.key}
            tabIndex={state.tab === t.key ? 0 : -1}
            onClick={() => setState({ tab: t.key })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="insights-body">
        {state.tab === 'digest' && (
          <DigestTab metrics={metrics} error={error} reviews={reviews} onSelectUnit={onSelectUnit} onOpenCommit={onOpenCommit} />
        )}
        {state.tab === 'map' && <NotAvailable what="The change map" />}
        {state.tab === 'blindspots' && <NotAvailable what="Blind spots" />}
      </div>
    </div>
  );
}
