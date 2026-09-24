import { describe, expect, it } from 'vitest';
import { computeLanes, type LaneCommit } from './lanes.js';

const c = (sha: string, ...parents: string[]): LaneCommit => ({ sha, parents });

describe('computeLanes', () => {
  it('keeps a linear history in lane 0', () => {
    const { rows, state } = computeLanes([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0]).toMatchObject({ incoming: [], outgoing: [0], through: [] });
    expect(rows[1]).toMatchObject({ incoming: [0], outgoing: [0] });
    expect(rows[2]).toMatchObject({ incoming: [0], outgoing: [] });
    expect(state).toEqual([]);
  });

  it('opens a second lane for a merge and closes it at the fork point', () => {
    const { rows } = computeLanes([c('m', 'a', 'f'), c('f', 'base'), c('a', 'base'), c('base')]);
    expect(rows[0]).toMatchObject({ lane: 0, outgoing: [0, 1] });
    expect(rows[1]).toMatchObject({ lane: 1, incoming: [1], through: [0], outgoing: [1] });
    // a's parent is already expected in lane 1, so a's line bends over to it
    expect(rows[2]).toMatchObject({ lane: 0, incoming: [0], through: [1], outgoing: [1] });
    expect(rows[3]).toMatchObject({ lane: 1, incoming: [1], outgoing: [] });
  });

  it('gives an unreferenced branch tip its own lane', () => {
    const { rows } = computeLanes([c('t1', 'x'), c('t2', 'x'), c('x')]);
    expect(rows[0]?.lane).toBe(0);
    expect(rows[1]?.lane).toBe(1);
    // t2 joins x's existing lane straight away
    expect(rows[1]).toMatchObject({ lane: 1, incoming: [], outgoing: [0] });
    expect(rows[2]).toMatchObject({ lane: 0, incoming: [0] });
  });

  it('reuses freed lanes', () => {
    const { rows } = computeLanes([c('m', 'a', 'f'), c('f', 'a'), c('a', 'r'), c('n', 'r'), c('r')]);
    expect(rows[3]?.lane).toBe(1);
  });

  it('is incremental: paging gives the same layout as one pass', () => {
    const all = [c('m', 'a', 'f'), c('f', 'base'), c('a', 'base'), c('base', 'root'), c('root')];
    const whole = computeLanes(all).rows;
    const p1 = computeLanes(all.slice(0, 2));
    const p2 = computeLanes(all.slice(2), p1.state);
    expect([...p1.rows, ...p2.rows]).toEqual(whole);
  });

  it('keeps lanes open for parents outside the loaded window', () => {
    const { rows, state } = computeLanes([c('b', 'a')]);
    expect(rows[0]?.outgoing).toEqual([0]);
    expect(state).toEqual(['a']);
  });

  it('follows a first parent that is already claimed by another lane', () => {
    const { rows } = computeLanes([c('f', 'a'), c('m', 'x'), c('x', 'a'), c('a')]);
    expect(rows[0]).toMatchObject({ lane: 0, outgoing: [0] });
    expect(rows[1]).toMatchObject({ lane: 1, through: [0], outgoing: [1] });
    expect(rows[2]).toMatchObject({ lane: 1, outgoing: [0] });
    expect(rows[3]?.incoming).toEqual([0]);
  });
});
