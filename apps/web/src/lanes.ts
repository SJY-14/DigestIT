export interface LaneCommit {
  sha: string;
  parents: string[];
}

/** Layout of one timeline row. Lane indices are columns in the graph gutter. */
export interface LaneRow {
  sha: string;
  /** Column of the commit node. */
  lane: number;
  /** Lanes entering the node from above (the node's own lane, when a child expected it, plus merged-in lanes). */
  incoming: number[];
  /** Lanes that pass the whole row untouched. */
  through: number[];
  /** Lanes leaving the node downwards, one per parent. */
  outgoing: number[];
  /** Gutter width in lanes for this row. */
  width: number;
}

/** lanes[i] = sha the lane is waiting for, or null when free. Carry it between pages. */
export type LaneState = readonly (string | null)[];

export const EMPTY_LANES: LaneState = [];

function freeSlot(lanes: (string | null)[], preferred?: number): number {
  if (preferred !== undefined && lanes[preferred] == null) return preferred;
  const i = lanes.indexOf(null);
  if (i >= 0) return i;
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * Assign graph lanes to commits given newest-first (children before parents).
 * Incremental: pass the returned state to the next page. Parents that are never
 * loaded simply keep their lane open to the bottom.
 */
export function computeLanes(
  commits: readonly LaneCommit[],
  state: LaneState = EMPTY_LANES,
): { rows: LaneRow[]; state: LaneState } {
  const lanes = [...state];
  const rows: LaneRow[] = [];

  for (const c of commits) {
    const incoming: number[] = [];
    lanes.forEach((s, i) => {
      if (s === c.sha) incoming.push(i);
    });
    const lane = incoming[0] ?? freeSlot(lanes);
    const before = lanes.length;
    const through: number[] = [];
    lanes.forEach((s, i) => {
      if (s !== null && s !== c.sha) through.push(i);
    });
    for (const i of incoming) lanes[i] = null;

    const outgoing: number[] = [];
    c.parents.forEach((p, idx) => {
      let target = lanes.indexOf(p);
      if (target < 0) {
        target = freeSlot(lanes, idx === 0 ? lane : undefined);
        lanes[target] = p;
      }
      if (!outgoing.includes(target)) outgoing.push(target);
    });

    const width = Math.max(before, lanes.length, lane + 1);
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ sha: c.sha, lane, incoming, through, outgoing, width });
  }
  return { rows, state: lanes };
}
