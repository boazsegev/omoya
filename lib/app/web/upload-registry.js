/** Ephemeral, connection-bound browser uploads. Bytes never receive a public URL. */
export const UPLOAD_LIMITS = Object.freeze({ files: 10, fileBytes: 20 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, ttlMs: 5 * 60 * 1000 });

const token = () => crypto.getRandomValues(new Uint8Array(24)).reduce((out, byte) => out + byte.toString(16).padStart(2, "0"), "");
const nameOf = (name) => String(name ?? "file").replace(/[\\/\0]/g, "_").slice(0, 255) || "file";

/** Registry is deliberately memory-only: no user-selected path is written to disk. */
export class UploadRegistry {
  #owners = new Map();
  #limits;
  constructor(limits = {}) { this.#limits = { ...UPLOAD_LIMITS, ...limits }; }
  open() { const key = token(); this.#owners.set(key, { files: new Map(), bytes: 0, expires: Date.now() + this.#limits.ttlMs }); return key; }
  close(key) { this.#owners.delete(key); }
  sweep(now = Date.now()) { for (const [key, owner] of this.#owners) if (owner.expires <= now) this.#owners.delete(key); }
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
