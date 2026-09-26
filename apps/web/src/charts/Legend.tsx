export interface LegendItem {
  key: string;
  label: string;
  className: string;
}

/** Series identity as text + a swatch, never color alone. */
export function Legend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <span className="legend">
      {items.map((it) => (
        <span className="key-item" key={it.key}>
          <span className={`swatch ${it.className}`} aria-hidden="true" />
          {it.label}
        </span>
      ))}
    </span>
  );
}

export function TableToggle({ table, onToggle }: { table: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="btn view-toggle" aria-pressed={table} onClick={onToggle}>
      {table ? 'Show chart' : 'Show table'}
    </button>
  );
}
