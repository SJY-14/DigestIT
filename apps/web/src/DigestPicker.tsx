// Digest picker (DIG-49, docs/ux-v3.md §4): a trigger in the project header that opens an overlay
// list of past digests, newest first, one row per digest ("Today, 17:05 · 15 files · <L0>").
// It floats over the reading pane instead of pushing it down. Escape, an outside click or picking
// a row closes it, and focus goes back to the trigger. Error/truncated rows carry a Retry.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { DigestSummaryDto } from '@digestit/core';
import { digestRowLabel, lineDelta, PICKER } from './copy.js';
import type { useDigests } from './useDigests.js';

function DigestRow({ d, current, onSelect, onRetry, retrying, retryDisabled }: {
  d: DigestSummaryDto;
  current: boolean;
  onSelect: () => void;
  onRetry: () => void;
  retrying: boolean;
  retryDisabled: boolean;
}) {
  const retryable = d.status === 'error' || d.status === 'truncated';
  return (
    <li className="digest-row">
      <button type="button" className="digest-row-main" aria-current={current ? 'true' : undefined} onClick={onSelect}>
        <span className="digest-row-label">{digestRowLabel(d.toAt, d.stats.files, d.l0?.text ?? null)}</span>
        <span className="meta">
          <span className="stats">{lineDelta(d.stats.additions, d.stats.deletions)}</span>
          {d.status !== 'ok' && <span className={`badge digest-status ${d.status}`}>{PICKER.status[d.status]}</span>}
        </span>
      </button>
      {retryable && (
        <button type="button" className="btn retry" onClick={onRetry} disabled={retrying || retryDisabled}>
          {retryDisabled ? PICKER.retryNoBudget : retrying ? PICKER.retrying : PICKER.retry}
        </button>
      )}
    </li>
  );
}

export interface DigestPickerProps {
  digests: ReturnType<typeof useDigests>;
  currentId: number | null;
  onSelect: (id: number) => void;
  onRetry: (id: number) => void;
  retryingId: number | null;
  retryDisabled: boolean;
}

export function DigestPicker({ digests, currentId, onSelect, onRetry, retryingId, retryDisabled }: DigestPickerProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const current = digests.items.find((d) => d.id === currentId);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  // Outside click closes without stealing focus; Escape closes and returns focus to the trigger.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) close(false); };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // On open, focus the current digest's row (else the newest) so arrows start from there.
  useEffect(() => {
    if (!open) return;
    const rows = list.current?.querySelectorAll<HTMLButtonElement>('.digest-row-main');
    const cur = list.current?.querySelector<HTMLButtonElement>('.digest-row-main[aria-current="true"]');
    (cur ?? rows?.[0])?.focus();
  }, [open]);

  // Older digests load as the list scrolls to its end (only while the overlay is open).
  useEffect(() => {
    const el = sentinel.current;
    if (!open || !el || digests.done) return undefined;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void digests.loadMore(), {
      root: list.current, rootMargin: '200px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [open, digests.done, digests.loadMore]);

  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.digest-row-main') ?? []);
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <div className="digest-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="digest-picker-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${PICKER.label}: ${current ? digestRowLabel(current.toAt, current.stats.files, current.l0?.text ?? null) : PICKER.choose}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="digest-picker-current">
          {current ? digestRowLabel(current.toAt, current.stats.files, current.l0?.text ?? null) : PICKER.choose}
        </span>
        {current && current.status !== 'ok' && <span className={`badge digest-status ${current.status}`}>{PICKER.status[current.status]}</span>}
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="digest-picker-panel" id={panelId} role="region" aria-label={PICKER.listLabel} ref={list} onKeyDown={onListKey}>
          <ol className="digest-list">
            {digests.items.map((d) => (
              <DigestRow
                key={d.id}
                d={d}
                current={d.id === currentId}
                onSelect={() => { onSelect(d.id); close(true); }}
                onRetry={() => onRetry(d.id)}
                retrying={retryingId === d.id}
                retryDisabled={retryDisabled}
              />
            ))}
          </ol>
          {digests.error && <p role="alert" className="error">{PICKER.loadError(digests.error)}</p>}
          <div ref={sentinel} className="sentinel">
            {digests.loading && <span className="muted">{PICKER.loading}</span>}
            {digests.done && digests.items.length > 0 && <span className="muted">{PICKER.startOfHistory}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
