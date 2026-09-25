import { useEffect, useState } from 'react';
import { fetchInsightsDrill, type DrillQuery, type OpenedVia, type WorkUnitMember, type WorkUnitSummary } from './api.js';
import type { ReviewState } from './feed.js';
import { UnitList } from './Units.js';

export interface DrillListProps {
  query: DrillQuery;
  via: OpenedVia;
  reviews: Map<number, ReviewState>;
  label: string;
  onSelect: (unit: WorkUnitSummary, via: OpenedVia) => void;
  onOpenCommit: (member: WorkUnitMember, via: OpenedVia) => void;
}

/** A chart mark's drill query -> the work units behind it, opened in the existing unit panel. */
export function DrillList({ query, via, reviews, label, onSelect, onOpenCommit }: DrillListProps) {
  const key = JSON.stringify(query);
  const [state, setState] = useState<{ key: string; units: WorkUnitSummary[] | null; error: string | null }>({
    key: '',
    units: null,
    error: null,
  });
  useEffect(() => {
    const ac = new AbortController();
    fetchInsightsDrill(query, ac.signal).then(
      (r) => !ac.signal.aborted && setState({ key, units: r.workUnits, error: null }),
      (e: unknown) => !ac.signal.aborted && setState({ key, units: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (state.key !== key) return <p className="muted">Loading…</p>;
  if (state.error) return <p role="alert" className="error">Could not load this drill-down: {state.error}</p>;
  const units = state.units ?? [];
  if (units.length === 0) return <p className="empty">No work units match this selection.</p>;
  return (
    <UnitList
      label={label}
      units={units}
      reviews={reviews}
      selectedId={null}
      onSelect={(u) => onSelect(u, via)}
      onOpenCommit={(m) => onOpenCommit(m, via)}
    />
  );
}
