// Pure scale/tick math shared by the four chart primitives. No DOM, no React: easy to unit test.

/** Nice axis maximum so gridlines land on whole steps (0 stays 0, everything else rounds up). */
export function niceMax(n: number, steps = 4): number {
  return n <= steps ? steps : Math.ceil(n / steps) * steps;
}

/** Evenly spaced tick values from 0 to `max`, `steps + 1` of them. */
export function ticks(max: number, steps = 4): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => (max / steps) * i);
}

/** Linear value -> pixel y, inverted so larger values sit higher (SVG y grows downward). */
export function linearY(value: number, max: number, top: number, height: number): number {
  return max <= 0 ? top + height : top + height - (value / max) * height;
}

/** One equal-width slot per category, from `start` across `width`. */
export function bandScale(count: number, start: number, width: number): { slot: number; x: (i: number) => number } {
  const slot = count > 0 ? width / count : width;
  return { slot, x: (i: number) => start + slot * i };
}

/** Median of a numeric array; 0 for an empty array. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Deterministic left/right jitter so dots at nearby values don't fully overlap. */
export function jitter(rank: number): number {
  const seq = [0, 1, -1, 2, -2, 3, -3];
  return seq[rank % seq.length]!;
}

/** Bucket a value into the heatmap's 5 steps (0 = no data, 1-4 = quarters of the way to `max`). */
export function heatStep(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  const frac = value / max;
  return frac <= 0.25 ? 1 : frac <= 0.5 ? 2 : frac <= 0.75 ? 3 : 4;
}
