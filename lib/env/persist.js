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
 *      (login performs several authSet calls; a startup
 *      model refresh touches many endpoints — each file still lands
 *      exactly one write).
 * Outside a batch, writes are immediate (still atomic) — callers that
 * read the file right after one update see it on disk. A DEFERRED write
 * (the settings view's) coalesces until the current tick ends.
 */

import { renameSync, writeFileSync } from "node:fs";

/**
 * Write a JSON value atomically by writing a same-directory temporary file
 * and renaming it over the destination. JSON is pretty-printed with two-space
 * indentation and a trailing newline.
 * @param {string} file Destination file path; no default.
 * @param {*} value Value passed to `JSON.stringify`; no default. Circular
 *   values and BigInts cause serialization errors; values for which stringify
 *   returns `undefined` produce the text `undefined` plus a newline.
 * @returns {void}
 * @throws {Error} Propagates serialization and filesystem errors from writing
 *   the temporary file or renaming it. A failed rename may leave the temporary
 *   file behind; the destination is not intentionally partially written.
 */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * Create an in-memory write queue. Writes outside batches are immediate;
 * writes inside nested batches are coalesced by file and flushed when the
 * outermost batch ends. Deferred writes are coalesced until a microtask runs.
 *
 * @returns {{write: (file: string, value: *) => void, defer: (file: string, value: *) => void, peek: (file: string) => *, discard: (file: string) => boolean, batch: (fn: Function) => Promise<*>, flush: () => void, drain: () => void, pending: number}} Queue API: `pending` counts batch-held writes only, not deferred writes.
 * @throws {Error} Methods that write may propagate serialization or filesystem
 *   errors from {@link writeJsonAtomic}; errors in deferred writes surface from
 *   the queued microtask.
 */
export function createWriteQueue() {
  let depth = 0;
  const pending = new Map();
  // deferred writes: until the current tick ends; any later write to the
  // same file supersedes them (its content was computed from peek())
  const deferred = new Map();
  /** Flush all batch-held writes unless a batch is still active. */
  const flush = () => {
    if (depth > 0 || pending.size === 0) return;
    const writes = [...pending.entries()];
    pending.clear();
    for (const [file, value] of writes) writeJsonAtomic(file, value);
  };
  return {
    /**
     * Write immediately outside a batch, or replace the held value for this
     * file inside a batch. Also cancels any deferred value for this file.
     * @param {string} file Destination path; no default.
     * @param {*} value JSON-serializable value to write; no default.
     * @returns {void}
     * @throws {Error} Propagates serialization and filesystem write/rename
     *   errors when the value is written immediately or later flushed.
     */
    write(file, value) {
      deferred.delete(file);
      if (depth > 0) {
        pending.set(file, value);
        return;
      }
      writeJsonAtomic(file, value);
    },
    /**
     * Hold a write until the current tick ends (one write per file per tick).
     * The latest deferred value for a path wins; during a batch the value is
     * instead held for the batch flush.
     * @param {string} file Destination path; no default.
     * @param {*} value JSON-serializable value to write; no default.
     * @returns {void}
     * @throws {Error} Serialization or filesystem errors occur asynchronously
     *   in the queued microtask outside a batch, or from the batch flush.
     */
    defer(file, value) {
      if (depth > 0) {
        pending.set(file, value);
        return;
      }
      const first = deferred.size === 0;
      deferred.set(file, value);
      if (!first) return;
      /** Flush the deferred values captured when this microtask runs. */
      queueMicrotask(() => {
        const writes = [...deferred.entries()];
        deferred.clear();
        for (const [path, content] of writes) writeJsonAtomic(path, content);
      });
    },
    /**
     * Return the held value for a file, preferring a non-nullish batch-held
     * value over a deferred value (matching the `??` lookup).
     * @param {string} file Destination path to inspect; no default.
     * @returns {*} The held value, or `undefined` when no value is held.
     */
    peek(file) {
      return pending.get(file) ?? deferred.get(file);
    },
    /**
     * Cancel any unflushed batch-held or deferred write for a file.
     * @param {string} file Destination path; no default.
     * @returns {boolean} `true` if either held write was removed, otherwise
     *   `false`.
     */
    discard(file) {
      const held = deferred.delete(file);
      return pending.delete(file) || held;
    },
    /**
     * Run an asynchronous or synchronous operation inside a nested batch, then
     * flush held writes when the outermost batch completes.
     * @param {Function} fn Operation to invoke; no default. Its result is awaited.
     * @returns {Promise<*>} Resolves to the operation's result, or rejects if
     *   the operation or the final flush fails.
     * @throws {Error} A final synchronous flush error rejects the returned
     *   promise; it can supersede an error thrown by `fn`.
     */
    async batch(fn) {
      depth++;
      try {
        return await fn();
      } finally {
        depth--;
        flush();
      }
    },
    /**
     * Flush batch-held writes if no batch is active.
     * @returns {void}
     * @throws {Error} Propagates serialization or filesystem errors; remaining
     *   writes may not be attempted after a failure.
     */
    flush,
    /**
     * Write every held deferred value immediately, then flush batch-held writes
     * if no batch is active (used during process teardown, such as env.close).
     * @returns {void}
     * @throws {Error} Propagates serialization or filesystem errors; a failure
     *   while writing deferred values prevents the subsequent batch flush.
     */
    drain() {
      const writes = [...deferred.entries()];
      deferred.clear();
      for (const [path, content] of writes) writeJsonAtomic(path, content);
      flush();
    },
    /**
     * Number of batch-held files awaiting flush; deferred-only files are not
     * included.
     * @returns {number}
     */
    get pending() {
      return pending.size;
    },
  };
}
