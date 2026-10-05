/** Ephemeral, connection-bound browser uploads. Bytes never receive a public URL. */
export const UPLOAD_LIMITS = Object.freeze({ files: 10, fileBytes: 20 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, ttlMs: 5 * 60 * 1000 });

/**
 * Generate a 24-byte cryptographically random hexadecimal token.
 * @returns {string} A 48-character lowercase hexadecimal token.
 * @throws {Error} If the platform cryptographic random-number generator fails.
 */
const token = () => crypto.getRandomValues(new Uint8Array(24)).reduce((out, byte) => out + byte.toString(16).padStart(2, "0"), "");
/**
 * Convert a supplied filename to a safe, bounded display name.
 * @param {*} name - Input filename; nullish values default to "file".
 * @returns {string} A string with path separators and NULs replaced, capped at 255 characters; empty results become "file".
 */
const nameOf = (name) => String(name ?? "file").replace(/[\\/\0]/g, "_").slice(0, 255) || "file";

/** Registry is deliberately memory-only: no user-selected path is written to disk. */
export class UploadRegistry {
  #owners = new Map();
  #limits;
  /**
   * Create a memory-only upload registry with caller-supplied limit overrides.
   * @param {Object} [limits={}] - Limit values merged over {@link UPLOAD_LIMITS}.
   * @returns {UploadRegistry} The initialized registry instance.
   */
  constructor(limits = {}) { this.#limits = { ...UPLOAD_LIMITS, ...limits }; }
  /**
   * Open an empty upload session bound to a newly generated opaque key.
   * @returns {string} The session key; the session expires after the configured TTL.
   * @throws {Error} If secure token generation fails.
   */
  open() { const key = token(); this.#owners.set(key, { files: new Map(), bytes: 0, expires: Date.now() + this.#limits.ttlMs }); return key; }
  /**
   * Close a session and discard its stored uploads.
   * @param {string} key - Session key to remove; unknown keys are ignored.
   * @returns {void}
   */
  close(key) { this.#owners.delete(key); }
  /**
   * Whether `key` names an open upload session of this registry.
   * @param {string} key - Session key to test.
   * @returns {boolean} true while the session is open.
   */
  owns(key) { return this.#owners.has(key); }
  /**
   * Delete sessions whose expiration time is at or before the supplied time.
   * @param {number} [now=Date.now()] - Current-time value, in milliseconds, used for the expiration comparison.
   * @returns {void}
   * @effects Removes every expired session and its in-memory upload references.
   */
  sweep(now = Date.now()) { for (const [key, owner] of this.#owners) if (owner.expires <= now) this.#owners.delete(key); }
  /**
   * Validate and store one Blob in an active session.
   * @param {string} key - Active session key.
   * @param {Blob} file - Blob to store; file-like names are sanitized before storage.
   * @returns {{id: string, name: string, size: number}} Metadata for the stored attachment.
   * @throws {TypeError} If the session is missing/expired, the value is not a Blob, or file/count/total-byte limits are exceeded.
   * @effects Sweeps expired sessions before validation and retains the Blob in memory on success.
   */
  add(key, file) {
    this.sweep();
    const owner = this.#owners.get(key);
    if (!owner) throw new TypeError("upload session expired");
    if (!(file instanceof Blob)) throw new TypeError("expected one file");
    if (file.size > this.#limits.fileBytes) throw new TypeError(`file exceeds ${this.#limits.fileBytes} byte limit`);
    if (owner.files.size >= this.#limits.files) throw new TypeError(`at most ${this.#limits.files} attachments`);
    if (owner.bytes + file.size > this.#limits.totalBytes) throw new TypeError(`attachments exceed ${this.#limits.totalBytes} byte limit`);
    const id = token(); const name = nameOf(file.name);
    owner.files.set(id, { id, name, size: file.size, blob: file }); owner.bytes += file.size;
    return { id, name, size: file.size };
  }
  /**
   * Remove selected uploads from a session and materialize their bytes.
   * @param {string} key - Active session key.
   * @param {string[]} ids - Unique attachment IDs to consume; an empty list is allowed.
   * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>} Uploads in the same order as `ids`.
   * @throws {TypeError} If the session is missing/expired, IDs are not a bounded unique array, or any ID is unknown; validation failures do not consume uploads.
   * @effects On successful validation, deletes the selected uploads and decrements the session's byte count before asynchronously reading their Blobs.
   * @throws {Error} If a Blob's `arrayBuffer()` read rejects; selected uploads have already been removed.
   */
  async take(key, ids) {
    this.sweep();
    const owner = this.#owners.get(key);
    if (!owner) throw new TypeError("upload session expired");
    if (!Array.isArray(ids) || ids.length > this.#limits.files || new Set(ids).size !== ids.length) throw new TypeError("invalid attachments");
    const uploads = ids.map((id) => owner.files.get(id));
    if (uploads.some((file) => !file)) throw new TypeError("unknown attachment");
    for (const file of uploads) { owner.files.delete(file.id); owner.bytes -= file.size; }
    return Promise.all(uploads.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.blob.arrayBuffer()) })));
  }
}
