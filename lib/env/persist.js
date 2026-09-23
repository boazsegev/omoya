/**
 * lib/env/persist.js — settings-file writes (private to Env).
 *
 * Two rules keep cloud-synced folders (iCloud, Dropbox) from breaking
 * an update:
 *   1. ATOMIC — every write is a temp file + rename, so a sync client
 *      (or a crash) never sees a half-written JSON file;
 *   2. COALESCED — a file is written ONCE per startup/update burst:
 *      inside a batch() the latest content per file is held in memory
 *      and flushed in a single write when the outermost batch ends
 *      (login performs several authSet/saveEndpoint calls; a startup
 *      model refresh touches many endpoints — each file still lands
 *      exactly one write).
 * Outside a batch, writes are immediate (still atomic) — callers that
 * read the file right after one update see it on disk.
 */

import { renameSync, writeFileSync } from "node:fs";

/**
 * Atomically write one JSON value (pretty-printed, trailing newline):
 * temp file in the same folder + rename.
 * @param {string} file
 * @param {*} value
 */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * A write queue with batch coalescing. write() is immediate outside a
 * batch; inside, only the latest value per file is kept and flushed
 * once when the outermost batch ends. Batches nest (a login inside a
 * startup batch flushes at the startup's end).
 * @returns {{write: (file: string, value: *) => void, peek: (file: string) => *, discard: (file: string) => boolean, batch: (fn: Function) => Promise<*>, flush: () => void, pending: number}}
 */
export function createWriteQueue() {
  let depth = 0;
  const pending = new Map();
  const flush = () => {
    if (depth > 0 || pending.size === 0) return;
    const writes = [...pending.entries()];
    pending.clear();
    for (const [file, value] of writes) writeJsonAtomic(file, value);
  };
  return {
    write(file, value) {
      if (depth > 0) {
        pending.set(file, value);
        return;
      }
      writeJsonAtomic(file, value);
    },
    /** The coalesced (not yet flushed) content of a file, if any. */
    peek(file) {
      return pending.get(file);
    },
    /** Cancel an unflushed write (used when a batched create is removed). */
    discard(file) {
      return pending.delete(file);
    },
    async batch(fn) {
      depth++;
      try {
        return await fn();
      } finally {
        depth--;
        flush();
      }
    },
    flush,
    get pending() {
      return pending.size;
    },
  };
}
