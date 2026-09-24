import type { LaneRow } from './lanes.js';

export const LANE_W = 16;
export const ROW_H = 56;
const NODE_R = 4;
const PALETTE = 8;

const x = (lane: number) => lane * LANE_W + LANE_W / 2;
const laneClass = (lane: number) => `lane lane-${lane % PALETTE}`;

/** Bezier from (x1, y1) to (x2, y2) leaving and arriving vertically. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

/** One row of the branch graph: lines are drawn top→node→bottom; the node is on `row.lane`. */
export function Graph({ row, isMerge, width }: { row: LaneRow; isMerge: boolean; width: number }) {
  const cy = ROW_H / 2;
  const nx = x(row.lane);
  return (
    <svg className="graph" width={width * LANE_W} height={ROW_H} aria-hidden="true" focusable="false">
      {row.through.map((l) => (
        <line key={`t${l}`} className={laneClass(l)} x1={x(l)} y1={0} x2={x(l)} y2={ROW_H} />
      ))}
      {row.incoming.map((l) => (
        <path key={`i${l}`} className={laneClass(l)} d={curve(x(l), 0, nx, cy)} />
      ))}
      {row.outgoing.map((l) => (
        <path key={`o${l}`} className={laneClass(l)} d={curve(nx, cy, x(l), ROW_H)} />
      ))}
      <circle className={`node ${laneClass(row.lane)}`} cx={nx} cy={cy} r={isMerge ? NODE_R + 1 : NODE_R} />
      {isMerge && <circle className="node-hole" cx={nx} cy={cy} r={2} />}
    </svg>
  );
}
