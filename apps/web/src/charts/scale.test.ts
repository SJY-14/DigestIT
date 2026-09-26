import { describe, expect, it } from 'vitest';
import { bandScale, heatStep, jitter, linearY, median, niceMax, ticks } from './scale.js';

describe('niceMax', () => {
  it('floors small values to the step size', () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(3)).toBe(4);
    expect(niceMax(4)).toBe(4);
  });
  it('rounds up to the next multiple of the step', () => {
    expect(niceMax(5)).toBe(8);
    expect(niceMax(12)).toBe(12);
    expect(niceMax(13)).toBe(16);
  });
  it('honors a custom step count', () => {
    expect(niceMax(2, 5)).toBe(5);
    expect(niceMax(11, 5)).toBe(15);
  });
});

describe('ticks', () => {
  it('returns steps + 1 evenly spaced values from 0 to max', () => {
    expect(ticks(8)).toEqual([0, 2, 4, 6, 8]);
    expect(ticks(9, 3)).toEqual([0, 3, 6, 9]);
  });
});

describe('linearY', () => {
  it('maps 0 to the bottom and max to the top', () => {
    expect(linearY(0, 10, 0, 100)).toBe(100);
    expect(linearY(10, 10, 0, 100)).toBe(0);
    expect(linearY(5, 10, 0, 100)).toBe(50);
  });
  it('falls back to the bottom when max is 0 (no data)', () => {
    expect(linearY(0, 0, 0, 100)).toBe(100);
  });
});

describe('bandScale', () => {
  it('divides the width into equal slots', () => {
    const { slot, x } = bandScale(4, 10, 100);
    expect(slot).toBe(25);
    expect(x(0)).toBe(10);
    expect(x(1)).toBe(35);
    expect(x(3)).toBe(85);
  });
  it('does not divide by zero for an empty domain', () => {
    const { slot, x } = bandScale(0, 10, 100);
    expect(slot).toBe(100);
    expect(x(0)).toBe(10);
  });
});

describe('median', () => {
  it('averages the two middle values for an even count', () => {
    expect(median([1, 3])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('picks the middle value for an odd count', () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it('is 0 for an empty array', () => {
    expect(median([])).toBe(0);
  });
});

describe('jitter', () => {
  it('is deterministic and centers on 0', () => {
    expect(jitter(0)).toBe(0);
    expect(jitter(1)).toBe(1);
    expect(jitter(2)).toBe(-1);
  });
  it('repeats for ranks beyond the sequence', () => {
    expect(jitter(7)).toBe(jitter(0));
  });
});

describe('heatStep', () => {
  it('buckets non-positive values and an empty domain into step 0', () => {
    expect(heatStep(0, 10)).toBe(0);
    expect(heatStep(-1, 10)).toBe(0);
    expect(heatStep(5, 0)).toBe(0);
  });
  it('buckets positive values into quartiles 1-4', () => {
    expect(heatStep(1, 10)).toBe(1);
    expect(heatStep(5, 10)).toBe(2);
    expect(heatStep(7.5, 10)).toBe(3);
    expect(heatStep(10, 10)).toBe(4);
  });
});
