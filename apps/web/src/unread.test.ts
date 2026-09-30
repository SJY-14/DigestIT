import { describe, expect, it } from 'vitest';
import { computeUnread } from './unread.js';
import type { LastSeen } from './storage.js';

const project = (digestCount: number, latestDigest: { id: number; seq: number; toAt: string; headline: string | null } | null) => ({
  digestCount,
  latestDigest,
});

describe('computeUnread (UX cycle 2 P4/P7, decision-2.md §2)', () => {
  it('is none for a project with no digest yet', () => {
    expect(computeUnread(project(0, null), null)).toEqual({ kind: 'none' });
  });

  it('shows the full digest count for a project never opened on this browser', () => {
    const p = project(5, { id: 30, seq: 5, toAt: '2026-09-26T16:40:00Z', headline: 'x' });
    expect(computeUnread(p, null)).toEqual({ kind: 'count', n: 5 });
  });

  it('shows "new" (kind: new) for a last-seen entry written before seq existed', () => {
    const p = project(5, { id: 30, seq: 5, toAt: '2026-09-26T16:40:00Z', headline: 'x' });
    const lastSeen: LastSeen = { digestId: 28, at: '2026-09-20T00:00:00Z' };
    expect(computeUnread(p, lastSeen)).toEqual({ kind: 'new' });
  });

  it('is the seq difference when a newer digest exists since last seen', () => {
    const p = project(5, { id: 30, seq: 5, toAt: '2026-09-26T16:40:00Z', headline: 'x' });
    const lastSeen: LastSeen = { digestId: 28, seq: 3, at: '2026-09-20T00:00:00Z' };
    expect(computeUnread(p, lastSeen)).toEqual({ kind: 'count', n: 2 });
  });

  it('is none (caught up) when the last seen seq matches the latest', () => {
    const p = project(5, { id: 30, seq: 5, toAt: '2026-09-26T16:40:00Z', headline: 'x' });
    const lastSeen: LastSeen = { digestId: 30, seq: 5, at: '2026-09-20T00:00:00Z' };
    expect(computeUnread(p, lastSeen)).toEqual({ kind: 'none' });
  });

  it('never goes negative when the stored seq is somehow ahead (stale/edited storage)', () => {
    const p = project(5, { id: 30, seq: 5, toAt: '2026-09-26T16:40:00Z', headline: 'x' });
    const lastSeen: LastSeen = { digestId: 31, seq: 9, at: '2026-09-20T00:00:00Z' };
    expect(computeUnread(p, lastSeen)).toEqual({ kind: 'none' });
  });
});
