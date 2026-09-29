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
  /** ISO timestamp of when this was recorded, shown as "2h ago". */
  at: string;
}

const lastSeenKey = (projectId: number) => `digestit.lastSeen.${projectId}`;

export function getLastSeen(projectId: number): LastSeen | null {
  const v = readJSON<LastSeen>(lastSeenKey(projectId));
  return v && typeof v.digestId === 'number' && typeof v.at === 'string' ? v : null;
}

export function setLastSeen(projectId: number, digestId: number, at: string = new Date().toISOString()): void {
  writeJSON(lastSeenKey(projectId), { digestId, at } satisfies LastSeen);
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
