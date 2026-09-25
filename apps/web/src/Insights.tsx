import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DrillMetric, Metrics, OpenedVia, WorkUnitMember, WorkUnitSummary } from './api.js';
import { BarSeries } from './charts/BarSeries.js';
import { DrillList } from './DrillList.js';
import type { ReviewState } from './feed.js';
import { formatDuration } from './feed.js';

const DRILL_METRICS: readonly DrillMetric[] = ['landed', 'decided', 'unreadBacklog', 'undecidedBacklog'];
/** The URL's `metric=` is untrusted input (hand-editable/deep-linked); narrow it to the server's enum. */
function asDrillMetric(v: string | null): DrillMetric | undefined {
  return v !== null && (DRILL_METRICS as readonly string[]).includes(v) ? (v as DrillMetric) : undefined;
}

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
  metric: string | null;
}

function parseTab(v: string | null): InsightsTab {
  return v === 'map' || v === 'blindspots' ? v : 'digest';
}

/** `?window=&area=&day=&metric=` (plus `tab=`) so a chart drill survives reload and can be linked. */
export function readInsightsUrlState(search: string): InsightsUrlState {
  const q = new URLSearchParams(search);
  return { tab: parseTab(q.get('tab')), window: q.get('window'), area: q.get('area'), day: q.get('day'), metric: q.get('metric') };
}

export function insightsUrlSearch(state: InsightsUrlState): string {
  const q = new URLSearchParams();
  if (state.tab !== 'digest') q.set('tab', state.tab);
  if (state.window) q.set('window', state.window);
  if (state.area) q.set('area', state.area);
  if (state.day) q.set('day', state.day);
  if (state.metric) q.set('metric', state.metric);
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

const METRIC_LABEL: Record<string, string> = { landed: 'Landed', decided: 'Decided' };

function DigestTab({ metrics, error, reviews, onSelectUnit, onOpenCommit, drillDay, drillMetric, onDrill, onCloseDrill }: {
  metrics: Metrics | null;
  error: string | null;
  reviews: Map<number, ReviewState>;
  onSelectUnit: (u: WorkUnitSummary, via: OpenedVia) => void;
  onOpenCommit: (m: WorkUnitMember, via: OpenedVia) => void;
  /** Drill selection lives in the URL (`?day=&metric=`) so it survives reload and can be linked. */
  drillDay: string | null;
  drillMetric: string | null;
  onDrill: (day: string, metric: string) => void;
  onCloseDrill: () => void;
}) {
  if (error && !metrics) return <p role="alert" className="error">Could not load metrics: {error}</p>;
  if (!metrics) return <p className="muted">Loading…</p>;
  const g = metrics.global;
  const dp = g.digestVsProduction;
  const ratio = dp.ratio === null ? '–' : dp.ratio.toFixed(2);
  const keeping = dp.ratio === null ? null : dp.ratio >= 1;
  const drillLabel = drillDay && drillMetric ? `${METRIC_LABEL[drillMetric] ?? drillMetric} on ${drillDay}` : null;

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
            onDrill={onDrill}
          />
        </div>
      </section>

      {drillDay && drillMetric && (
        <section className="box" aria-labelledby="drill">
          <div className="box-head">
            <h2 id="drill" className="box-title">{drillLabel}</h2>
            <button type="button" className="btn view-toggle" onClick={onCloseDrill}>Close</button>
          </div>
          <div className="box-body">
            <DrillList query={{ day: drillDay, metric: asDrillMetric(drillMetric) }} via="digest" reviews={reviews} label={drillLabel!} onSelect={onSelectUnit} onOpenCommit={onOpenCommit} />
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
  const tabNodes = useRef(new Map<InsightsTab, HTMLButtonElement>());
  const focusTab = (key: InsightsTab) => {
    setState({ tab: key });
    tabNodes.current.get(key)?.focus();
  };
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.key === state.tab);
    if (e.key === 'ArrowRight') { e.preventDefault(); focusTab(TABS[(i + 1) % TABS.length]!.key); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focusTab(TABS[(i - 1 + TABS.length) % TABS.length]!.key); }
    else if (e.key === 'Home') { e.preventDefault(); focusTab(TABS[0]!.key); }
    else if (e.key === 'End') { e.preventDefault(); focusTab(TABS[TABS.length - 1]!.key); }
  };
  return (
    <div className="insights">
      <div role="tablist" aria-label="Insights" className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              if (el) tabNodes.current.set(t.key, el);
              else tabNodes.current.delete(t.key);
            }}
            id={`insights-tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={state.tab === t.key}
            aria-controls={`insights-panel-${t.key}`}
            tabIndex={state.tab === t.key ? 0 : -1}
            onClick={() => setState({ tab: t.key })}
            onKeyDown={onTabKeyDown}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        className="insights-body"
        role="tabpanel"
        id={`insights-panel-${state.tab}`}
        aria-labelledby={`insights-tab-${state.tab}`}
      >
        {state.tab === 'digest' && (
          <DigestTab
            metrics={metrics}
            error={error}
            reviews={reviews}
            onSelectUnit={onSelectUnit}
            onOpenCommit={onOpenCommit}
            drillDay={state.day}
            drillMetric={state.metric}
            onDrill={(day, metric) => setState({ day, metric })}
            onCloseDrill={() => setState({ day: null, metric: null })}
          />
        )}
        {state.tab === 'map' && <NotAvailable what="The change map" />}
        {state.tab === 'blindspots' && <NotAvailable what="Blind spots" />}
      </div>
    </div>
  );
}
