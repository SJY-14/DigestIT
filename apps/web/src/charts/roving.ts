import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Roving tabindex over a 1-D list of marks: only the focused mark is in the tab order, arrow
 * keys move it (and move real DOM focus with it, since changing `tabIndex` alone does not),
 * Enter/Space activates it. Shared by bar groups, line points and dot-strip groups.
 */
export function useRovingIndex(count: number, onActivate: (i: number) => void) {
  const [focused, setFocused] = useState(0);
  const nodes = useRef(new Map<number, SVGElement>());
  const pendingFocus = useRef(false);
  const clamp = (i: number) => Math.min(Math.max(count - 1, 0), Math.max(0, i));

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    nodes.current.get(focused)?.focus();
  }, [focused]);

  const move = (i: number) => {
    pendingFocus.current = true;
    setFocused(clamp(i));
  };

  const onKeyDown = useCallback(
    (e: KeyboardEvent, i: number) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        move(i + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        move(i - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        move(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        move(count - 1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate(i);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [count, onActivate],
  );

  const ref = (i: number) => (el: SVGElement | null) => {
    if (el) nodes.current.set(i, el);
    else nodes.current.delete(i);
  };

  return { focused, setFocused, tabIndex: (i: number) => (i === focused ? 0 : -1), onKeyDown, ref };
}

/** Roving tabindex over a 2-D grid (the heatmap): all four arrows move the focused cell. */
export function useRovingGrid(rows: number, cols: number, onActivate: (row: number, col: number) => void) {
  const [pos, setPos] = useState({ row: 0, col: 0 });
  const nodes = useRef(new Map<string, SVGElement>());
  const pendingFocus = useRef(false);
  const clamp = (row: number, col: number) => ({
    row: Math.min(Math.max(rows - 1, 0), Math.max(0, row)),
    col: Math.min(Math.max(cols - 1, 0), Math.max(0, col)),
  });

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    nodes.current.get(`${pos.row}:${pos.col}`)?.focus();
  }, [pos]);

  const move = (row: number, col: number) => {
    pendingFocus.current = true;
    setPos(clamp(row, col));
  };

  const onKeyDown = useCallback(
    (e: KeyboardEvent, row: number, col: number) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        move(row, col + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        move(row, col - 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(row + 1, col);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(row - 1, col);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate(row, col);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [rows, cols, onActivate],
  );

  const ref = (row: number, col: number) => (el: SVGElement | null) => {
    const k = `${row}:${col}`;
    if (el) nodes.current.set(k, el);
    else nodes.current.delete(k);
  };

  return { pos, setPos, tabIndex: (row: number, col: number) => (row === pos.row && col === pos.col ? 0 : -1), onKeyDown, ref };
}
