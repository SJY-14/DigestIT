// Client-only persistence (DIG-61, docs/ux/decision-1.md P6/P5-A): both features are
// per-browser localStorage, guarded so a project with storage unavailable (private mode, quota,
// disabled) just never shows the strip/mark instead of throwing.
function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: the feature degrades to "never seen/reviewed", not an error
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable: nothing was persisted in the first place
  }
}

// --- P6: last digest seen per project ------------------------------------------------------------

export interface LastSeen {
  digestId: number;
  /** The digest's ordinal (`DigestSummaryDto.seq`), used for unread counting (UX cycle 2 P4,
   * decision-2.md §2: `latestDigest.seq − lastSeen.seq`). Optional so entries written before this
   * field existed stay readable — `unread.ts`'s `computeUnread` treats a missing `seq` as "New"
   * rather than guessing a count. */
  seq?: number;
  /** ISO timestamp of when this was recorded, shown as "2h ago". */
  at: string;
}

const lastSeenKey = (projectId: number) => `digestit.lastSeen.${projectId}`;

export function getLastSeen(projectId: number): LastSeen | null {
  const v = readJSON<LastSeen>(lastSeenKey(projectId));
  if (!v || typeof v.digestId !== 'number' || typeof v.at !== 'string') return null;
  return typeof v.seq === 'number' ? { digestId: v.digestId, seq: v.seq, at: v.at } : { digestId: v.digestId, at: v.at };
}

export function setLastSeen(projectId: number, digestId: number, seq: number, at: string = new Date().toISOString()): void {
  writeJSON(lastSeenKey(projectId), { digestId, seq, at } satisfies LastSeen);
}

// --- P5 option A: per-area reviewed mark ----------------------------------------------------------

const reviewedKey = (projectId: number, digestId: number, areaId: string) => `digestit.reviewed.${projectId}.${digestId}.${areaId}`;

export function getReviewed(projectId: number, digestId: number, areaId: string): boolean {
  return readJSON<boolean>(reviewedKey(projectId, digestId, areaId)) === true;
}

export function setReviewed(projectId: number, digestId: number, areaId: string, reviewed: boolean): void {
  if (reviewed) writeJSON(reviewedKey(projectId, digestId, areaId), true);
  else removeKey(reviewedKey(projectId, digestId, areaId));
}
