// DIG-118 item 4: the memory A/B kit's final cleanup pass used to `rmSync` each pipeline's scratch
// `home` while its sqlite connection (WAL mode, see `openDb`) was still open. A WAL-mode db keeps
// `digestit.sqlite-wal`/`-shm` siblings next to the main file until the connection closes (a clean
// close checkpoints and removes them); a directory listing that races that trailing write turns
// "remove this temp dir" into ENOTEMPTY. `closeDbs` closes every connection first, and
// `removeScratchDirs` asks `rmSync` to retry past a transient ENOTEMPTY/EBUSY/EPERM instead of
// failing once, as a backstop for any other write this kit does not account for (a shadow snapshot,
// a git subprocess still flushing).
import { rmSync } from 'node:fs';

/** Closes every sqlite connection; a handle already closed (or never opened) is skipped rather than
 * thrown on, so one pipeline's cleanup never aborts another's. */
export function closeDbs(dbs) {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed, or never opened -- nothing left to flush
    }
  }
}

/** `rmSync` with Node's own retry for a transient ENOTEMPTY/EBUSY/EPERM (only honoured together
 * with `recursive`), so a scratch dir whose removal raced a trailing write gets one more try instead
 * of crashing the whole kit run after its metrics and pair files are already written. */
export function removeScratchDirs(dirs, opts = {}) {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100, ...opts });
  }
}
