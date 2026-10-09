/** SettingsStore — a project-agnostic settings aggregator (public as Env.SettingsStore).
 *
 * A store is a flat, ordered list of nodes. Reads merge objects by key, with
 * later nodes overriding earlier nodes; arrays and scalars replace lower values.
 * A node holds data from one file or memory, mounted at a key path (`at`). A
 * parent store is the lowest layer: reads merge over it and writes no local
 * node takes fall through to it.
 *
 * Reads return the current state immediately, even while files are loading.
 * Writes scan nodes from last to first: the first writable node that owns the
 * exact key or accepts it as a catch-all takes the write and marks changed file
 * nodes dirty. Construction and attach may stat a path to identify a directory,
 * but do not load file content; poll loads it. Loading, saving and change
 * notices are asynchronous, grouped per round:
 *
 *   loaded  — a poll round finished reading every changed file
 *   saved   — a storage round finished writing every dirty file
 *   updated — settings data changed (after a storage or poll round)
 */
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseJsonc } from "./jsonc.js";
import { isPlainObject } from "./settings.js";

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
const POLL_MS = 2000;
const SAVE_MS = 5;
const READ_ATTEMPTS = 5;
const EVENTS = ["loaded", "saved", "updated"];
const GLOB = /[*?[{]/;
/** Discovery never loads package manifests or lockfiles. */
const DEFAULT_EXCLUDE = /^(?:package|package-lock|npm-shrinkwrap|bun)\.(?:json|lockb?)$/;

function checkPath(path) {
  if (!Array.isArray(path) || path.some((key) => typeof key !== "string" || !key || UNSAFE.has(key))) {
    throw new TypeError("SettingsStore: invalid key path");
  }
}

function valueAt(data, path) {
  let current = data;
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function hasPath(data, path) {
  let current = data;
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

/** Copy-on-write assignment; `undefined` deletes, pruning objects the deletion empties. */
function assigned(data, [key, ...rest], value) {
  const result = { ...data };
  if (!rest.length) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  } else {
    const child = assigned(isPlainObject(data[key]) ? data[key] : {}, rest, value);
    if (value === undefined && !Object.keys(child).length) delete result[key];
    else result[key] = child;
  }
  return result;
}

/** Objects merge by key; any other value masks the layers below it. */
function merged(layers) {
  const start = layers.findLastIndex((layer) => !isPlainObject(layer));
  if (start >= 0) return start === layers.length - 1 ? layers[start] : merged(layers.slice(start + 1));
  if (layers.length === 1) return layers[0];
  const result = {};
  for (const key of new Set(layers.flatMap((layer) => Object.keys(layer)))) {
    if (UNSAFE.has(key)) continue;
    result[key] = merged(layers.filter((layer) => Object.hasOwn(layer, key)).map((layer) => layer[key]));
  }
  return result;
}

/** A plain deep copy of JSON-shaped data; accepts live views (proxies) of settings too. */
function detached(value) {
  if (Array.isArray(value)) return value.map(detached);
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const key of Object.keys(value)) if (!UNSAFE.has(key) && value[key] !== undefined) result[key] = detached(value[key]);
  return result;
}

/** Whether two key paths overlap (one is a prefix of the other). */
const overlaps = (left, right) => left.every((key, index) => index >= right.length || right[index] === key);

const fingerprint = (meta) => `${meta.mtimeMs}:${meta.ctimeMs}:${meta.size}:${meta.ino}:${meta.dev}`;

async function fileVersion(filename) {
  try { return fingerprint(await stat(filename)); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Read a file's data and version. Files are not locked: a read that overlaps a change is repeated. */
async function fileRead(filename) {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const version = await fileVersion(filename);
    if (version === null) return { data: {}, version };
    let text;
    try { text = await readFile(filename, "utf8"); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (await fileVersion(filename) !== version) continue;
    const data = text.trim() ? parseJsonc(text) : {};
    if (!isPlainObject(data)) throw new TypeError(`SettingsStore: ${filename}: file root must be an object`);
    return { data, version };
  }
  throw new Error(`SettingsStore: ${filename} kept changing while being read`);
}

/** Atomic replacement; an empty object deletes the file. Returns the new version. */
async function fileWrite(filename, data) {
  if (!Object.keys(data).length) {
    try { await unlink(filename); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return null;
  }
  const temp = `${filename}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    await rename(temp, filename);
  } catch (error) {
    try { await unlink(temp); } catch { /* the original error is reported */ }
    throw error;
  }
  return fileVersion(filename);
}

/** Split a glob into its literal directory and the pattern below it. */
function globParts(source) {
  const parts = source.split(sep);
  const index = parts.findIndex((part) => GLOB.test(part));
  return { cwd: parts.slice(0, index).join(sep) || sep, pattern: parts.slice(index).join("/") };
}

/** An attached source handle, returned by `SettingsStore.attach()` or exposed in `store.nodes`.
 * File handles retain their filename in `source`; memory handles have `source === false`.
 * `at` is the mount path; `writable`, `catchAll`, `dirty`, and `error` describe
 * current node state. Treat `data` as internal; use `own()`, `has()`, `assign()`
 * and `replace()` to access or change node-owned data. A detached handle is no
 * longer a store layer; discovery may also remove clean file handles on poll.
 */
class SettingsNode {
  constructor(store, { source = false, at = [], data, filter, catchAll = false, writable = true }) {
    checkPath(at);
    if (source !== false && data !== undefined) throw new TypeError("SettingsStore: choose data or source");
    if (data !== undefined && !isPlainObject(data)) throw new TypeError("SettingsStore: data must be an object");
    if (filter !== undefined && typeof filter !== "function") throw new TypeError("SettingsStore: filter must be a function");
    if (catchAll && !writable) throw new TypeError("SettingsStore: a catch-all must be writable");
    this.store = store;
    this.source = source;
    this.at = at;
    this.filter = filter;
    this.catchAll = catchAll;
    this.writable = writable;
    this.data = data === undefined ? {} : detached(data);
    this.version = source ? undefined : null; // undefined until a file's first load
    this.dirty = false;
    this.error = null;
    this.writing = null;
  }

  /** The node-relative form of an absolute path inside this node's mount, else null. */
  relative(path) {
    if (path.length < this.at.length || this.at.some((key, index) => path[index] !== key)) return null;
    return path.slice(this.at.length);
  }

  /** This node's contribution at an absolute path (shared data; callers copy). */
  layer(path) {
    const relative = this.relative(path);
    if (relative) return valueAt(this.data, relative);
    if (this.at.length <= path.length || path.some((key, index) => this.at[index] !== key)) return undefined;
    if (!Object.keys(this.data).length) return undefined;
    return this.at.slice(path.length).reduceRight((value, key) => ({ [key]: value }), this.data);
  }

  /** Whether a store write at the absolute `path` lands on this node. */
  takes(path, value) {
    const relative = this.relative(path);
    if (!this.writable || relative === null) return false;
    if (!relative.length) return this.catchAll && (value === undefined || isPlainObject(value));
    return hasPath(this.data, relative) || (this.catchAll && value !== undefined);
  }

  /** Whether this node holds the exact absolute `path` and takes writes. */
  owns(path) {
    const relative = this.relative(path);
    return this.writable && Boolean(relative?.length) && hasPath(this.data, relative);
  }

  /** Read this node's own data, without merging other layers.
   * @param {string[]} [path=[]] Node-relative nonempty safe string segments; `[]` reads all data.
   * @returns {*} A detached copy, or `undefined` for an absent path; mutating it does not edit the node.
   * @throws {TypeError} Invalid path; correct the path before retrying.
   */
  own(path = []) {
    checkPath(path);
    return detached(valueAt(this.data, path));
  }

  /** Test exact membership in this node, regardless of other layers.
   * @param {string[]} path Node-relative safe string segments; `[]` tests the root.
   * @returns {boolean} Whether the path exists; does not mutate state.
   * @throws {TypeError} Invalid path; correct the path before retrying.
   */
  has(path) {
    checkPath(path);
    return hasPath(this.data, path);
  }

  /** Set or delete one node-owned path, bypassing store write routing.
   * @param {string[]} path Node-relative safe string segments; `[]` replaces all data.
   * @param {*} value JSON-shaped value, detached before storage; `undefined` deletes the path, and at `[]` resets to `{}`.
   * @returns {undefined} No value; equal writes do not schedule a change. Memory changes remain in memory; file changes queue a save.
   * @throws {TypeError} Invalid path, non-object root, or read-only file; correct input or use a writable source before retrying.
   */
  assign(path, value) {
    if (this.store.closed || this.store.closing) throw new TypeError("SettingsStore: closed");
    checkPath(path);
    if (!path.length) return this.replace(value ?? {});
    if (!this.writable && this.source) throw new TypeError("SettingsStore: file node is read-only");
    const next = detached(value);
    if (next === undefined ? !hasPath(this.data, path) : isDeepStrictEqual(valueAt(this.data, path), next)) return;
    this.data = assigned(this.data, path, next);
    this.#changed([...this.at, ...path]);
  }

  /** Replace the node's entire data without changing other layers.
   * @param {object} data Plain object of JSON-shaped data; copied on entry, not retained by reference.
   * @returns {undefined} No value; equal replacement has no side effects. A changed file node queues a save.
   * @throws {TypeError} Non-object data or read-only file; correct input or use a writable source before retrying.
   */
  replace(data) {
    if (this.store.closed || this.store.closing) throw new TypeError("SettingsStore: closed");
    if (!isPlainObject(data)) throw new TypeError("SettingsStore: data must be an object");
    if (!this.writable && this.source) throw new TypeError("SettingsStore: file node is read-only");
    const next = detached(data);
    if (isDeepStrictEqual(this.data, next)) return;
    this.data = next;
    this.#changed(this.at);
  }

  #changed(path) {
    if (this.source) this.dirty = true;
    this.store.changed(this, path);
  }

  /** Apply a fresh file read. On the first load, data written before it merges over the
   * file's content and stays dirty (it saves next). Returns whether data changed. */
  loaded({ data, version }) {
    let next = this.filter ? this.filter(data) : data;
    const early = this.version === undefined && this.dirty;
    if (early) next = merged([next, this.data]);
    this.version = version;
    this.error = null;
    this.dirty = early;
    if (isDeepStrictEqual(this.data, next)) return false;
    this.data = next;
    return true;
  }

  /** Write this dirty, loaded file node after any write in flight. Resolves to an Error on failure. */
  save() {
    const run = async () => {
      if (!this.dirty || this.version === undefined) return; // never replace a file not yet read
      const data = this.data;
      this.dirty = false;
      try {
        const version = await fileWrite(this.source, data);
        if (this.data === data) this.version = version; // polling never rereads our own write
        this.error = null;
      } catch (error) {
        this.dirty = true;
        this.error = error;
        return error;
      }
    };
    const writing = (this.writing ?? Promise.resolve()).then(run);
    this.writing = writing;
    void writing.then(() => { if (this.writing === writing) this.writing = null; });
    return writing;
  }
}

/**
 * An independently usable, ordered settings store, exported as `Env.SettingsStore`.
 * Create with `new SettingsStore({ parent, sources })`; `parent` is an optional
 * SettingsStore below local sources, and `sources` defaults to `[]`. Each source
 * spec is a plain object with these supported fields:
 * - `source`: nonempty file path, existing directory (`*.json` discovery), or
 *   glob (discovery). Omit it for an in-memory source; missing file paths are
 *   files, not directories. Discovery runs on poll, sorts filenames and skips
 *   package manifests/lockfiles and files already attached here or in a parent.
 * - `data`: initial plain object for memory (default `{}`), copied rather than
 *   retained. File sources cannot specify `data`.
 * - `at`: safe string-segment mount path (default `[]`, the root); retained by
 *   reference on its node handle, so do not mutate it while attached.
 * - `catchAll`: default false; accepts writes in its mount during the reverse
 *   node scan even when an earlier node owns the path. A catch-all must be
 *   writable. Without one, new writes may return false.
 * - `writable`: default true; false excludes the node from store write routing.
 *   A read-only file cannot be edited through its handle; memory owners can
 *   still change a read-only memory handle directly.
 * - `filter(data)`: optional file-read projection. Return the file data to keep;
 *   dropped keys are omitted when the file is subsequently saved.
 * - `exclude`: optional RegExp matching basenames to omit from discovery.
 *
 * Read immediately with `read(path)`; plain objects merge by key across layers,
 * while arrays and scalar values replace lower layers. Write synchronously with
 * `write(path, value)`: search nodes from last to first; the first writable
 * node holding the exact path or accepting it as a catch-all takes the write.
 * If none takes it, routing falls through to the parent. File changes are saved asynchronously; call
 * `await poll()` to load files and `await save()` to flush edits. A missing file
 * loads as `{}`; an empty saved file node deletes its file. Construction and
 * attach may stat paths for directory detection but do not load file content.
 * Polling also runs periodically while open.
 *
 * Standalone file and ephemeral memory sources:
 *
 * ```js
 * import { Env } from "./lib/env.js";
 * const store = new Env.SettingsStore({ sources: [
 *   { source: "./config.json", catchAll: true },
 *   { at: ["session"], catchAll: true, data: {} },
 * ] });
 * await store.poll();
 * store.write(["theme"], "dark");
 * store.write(["session", "active"], true); // memory only
 * await store.save();
 * await store.close();
 * ```
 *
 * Missing paths and invalid root writes:
 *
 * ```js
 * import { Env } from "./lib/env.js";
 * const store = new Env.SettingsStore();
 * store.read(["missing"]); // undefined
 * store.write(["missing"], 1); // false: no writable owner or catch-all
 * try { store.write([], 1); } catch (error) {
 *   console.log(error instanceof TypeError); // true: root writes are unsupported
 * }
 * await store.close();
 * ```
 *
 * Compose a local store over a shared parent:
 *
 * ```js
 * import { Env } from "./lib/env.js";
 * const shared = new Env.SettingsStore({ sources: [{ catchAll: true, data: {} }] });
 * const project = new Env.SettingsStore({ parent: shared,
 *   sources: [{ at: ["project"], catchAll: true, data: {} }] });
 * project.write(["shared"], 1); // falls through to shared
 * project.write(["project", "name"], "demo"); // local only
 * await project.save(); // also saves shared by default
 * await project.close(); // shared remains open
 * await shared.close();
 * ```
 */
export class SettingsStore {
  #parent;
  #sources = [];   // ordered: { node } | { discovery, nodes }
  #nodes = [];     // the flat node list, lowest first
  #listeners = new Map(EVENTS.map((name) => [name, new Set()]));
  #relays = [];
  #dirty = new Set();
  #saveTimer = null;
  #saving = null;
  #polling = null;
  #pollAgain = null;
  #pollTimer = null;
  #cache = new Map();   // read cache: id -> { path, value }, invalidated by overlapping paths
  #children = new Set();
  #version = 0;
  #grouping = null; // while polling or saving with the parent: notices buffered into one set per event
  closed = false;
  #closePromise = null;
  #closing = false;

  /** Create an open store and attach ordered sources; starts an unref'ed polling timer.
   * @param {object} [options={}] Options are not retained; source data is copied, while `parent` is referenced until close.
   * @param {SettingsStore} [options.parent] Existing parent below this store; the child does not own or close it.
   * @param {object[]} [options.sources=[]] Source specs documented on the class; attached in order, lowest first.
   * @throws {TypeError} Invalid options container, unknown own top-level keys (including symbols), parent, sources, or source spec; fix options before retrying. Unknown top-level keys fail before source attachment and poll timer allocation.
   */
  constructor(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("SettingsStore: options must be an object");
    const keys = new Set(["parent", "sources"]);
    for (const key of Reflect.ownKeys(options)) if (!keys.has(key)) throw new TypeError(`SettingsStore: unknown option ${String(key)}`);
    const { parent, sources = [] } = options;
    if (parent !== undefined && !(parent instanceof SettingsStore)) throw new TypeError("SettingsStore: parent must be a SettingsStore");
    if (!Array.isArray(sources)) throw new TypeError("SettingsStore: sources must be an array");
    this.#parent = parent;
    for (const spec of sources) this.attach(spec);
    if (parent) {
      for (const event of EVENTS) this.#relays.push(parent.on(event, ({ nodes }) => this.#emit(event, nodes)));
      parent.#children.add(this);
    }
    this.#pollTimer = setInterval(() => { void this.poll({ parent: false }).catch(() => {}); }, POLL_MS);
    this.#pollTimer.unref?.();
  }

  /** Read the referenced parent store, or `undefined`; querying does not mutate it. */
  get parent() { return this.#parent; }

  /** Whether close has started; node handles reject edits at this boundary. */
  get closing() { return this.#closing; }

  /** Read a new array of current local node handles, lowest first; parent nodes are excluded. Mutating the array does not edit membership; handles remain live only while attached. */
  get nodes() { return [...this.#nodes]; }

  /** Read a number useful for cache invalidation; local or parent data/membership changes advance it. The query does not mutate state. */
  get version() { return this.#version + (this.#parent?.version ?? 0); }

  /** Attach one source spec from the class contract, last unless placed before a local handle.
   * @param {object} spec Source spec; memory `data` is copied. File data loads on poll, not attach.
   * @param {object} [options={}] Placement options, not retained.
   * @param {object} [options.before] Existing local node or discovery handle to insert before.
   * @returns {object} File/memory node handle (`own`, `has`, `assign`, `replace`), or discovery handle whose `nodes` property is replaced on membership changes during poll. Read the property again after polling. Attaching an already attached file returns its existing node, including from a parent; it is not newly owned by this store.
   * @throws {TypeError} Closed store, invalid spec/field, or unknown `before` handle; correct input or use an open store before retrying.
   */
  attach(spec, { before } = {}) {
    if (this.closed || this.#closing) throw new TypeError("SettingsStore: closed");
    if (!isPlainObject(spec)) throw new TypeError("SettingsStore: invalid source spec");
    const { source, exclude, ...options } = spec;
    if (exclude !== undefined && !(exclude instanceof RegExp)) throw new TypeError("SettingsStore: exclude must be a RegExp");
    let entry;
    if (typeof source === "string" && source) {
      let folder = false;
      try { folder = !GLOB.test(source) && statSync(source).isDirectory(); } catch { /* a missing path is a file */ }
      if (GLOB.test(source) || folder) {
        entry = { discovery: { ...(folder ? { cwd: source, pattern: "*.json" } : globParts(source)), exclude, options }, nodes: [] };
      } else {
        const existing = this.attached(source);
        if (existing) return existing;
        entry = { node: new SettingsNode(this, { ...options, source }) };
      }
    } else entry = { node: new SettingsNode(this, options) };
    const index = before === undefined ? -1 : this.#sources.findIndex((item) => item.node === before || item === before);
    if (before !== undefined && index < 0) throw new TypeError("SettingsStore: unknown `before` handle");
    this.#sources.splice(index < 0 ? this.#sources.length : index, 0, entry);
    this.#rebuild();
    return entry.node ?? entry;
  }

  /** Remove a locally attached node or discovery handle and its discovered nodes; file content is not deleted.
   * @param {object} handle Handle returned by a local `attach()` (or a local node in `nodes`).
   * @returns {boolean} True if removed; false for unknown/already removed or inherited handles. Membership and reads update immediately; the handle is no longer a store layer.
   */
  detach(handle) {
    const index = this.#sources.findIndex((item) => item.node === handle || item === handle);
    if (index < 0) return false;
    this.#sources.splice(index, 1);
    this.#rebuild();
    return true;
  }

  /** Find an attached file node locally or in the parent without changing membership.
   * @param {string} filename File path in the same spelling used at attach/discovery; no path normalization occurs.
   * @returns {object|undefined} Shared live node handle if attached, otherwise `undefined`; caller does not acquire ownership by lookup.
   */
  attached(filename) {
    return this.#nodes.find((node) => node.source === filename) ?? this.#parent?.attached(filename);
  }

  /** Membership changed: a new layer list, not an edit (nothing to save or announce). */
  #rebuild() {
    this.#nodes = this.#sources.flatMap((item) => item.node ? [item.node] : item.nodes);
    this.#version++;
    this.#invalidate();
  }

  /** Subscribe to a round notice, including notices relayed from the parent.
   * `loaded` reports file nodes read, `saved` reports successfully saved file
   * nodes, and `updated` reports nodes whose data/membership changed. A notice
   * is emitted once per round only when its set is nonempty; listener exceptions
   * are ignored so other listeners still run.
   * @param {"loaded"|"saved"|"updated"} event Notice name.
   * @param {Function} listener Receives `{ nodes: Set }` of live node handles; do not mutate the set. The store retains this callback until disposed or closed.
   * @returns {Function} Idempotent disposer; call when no longer interested. Closing the store removes its subscriptions.
   * @throws {TypeError} Unknown event or nonfunction listener; correct inputs before retrying.
   */
  on(event, listener) {
    const listeners = this.#listeners.get(event);
    if (!listeners || typeof listener !== "function") throw new TypeError("SettingsStore: invalid event listener");
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  #emit(event, nodes) {
    if (!nodes.size || this.closed) return;
    if (this.#grouping) { for (const node of nodes) this.#grouping[event].add(node); return; }
    for (const listener of [...this.#listeners.get(event)]) {
      try { listener({ nodes }); } catch { /* one listener never blocks the others */ }
    }
  }

  /** Run `work` (rounds of this store and its parent) and announce their notices together. */
  async #group(work) {
    if (this.#grouping) return work();
    const groups = this.#grouping = Object.fromEntries(EVENTS.map((event) => [event, new Set()]));
    try { return await work(); } finally {
      this.#grouping = null;
      for (const event of EVENTS) this.#emit(event, groups[event]);
    }
  }

  /** Read the current merged value immediately; file data can be partial before poll completes.
   * @param {string[]} [path=[]] Absolute safe string-segment path; `[]` reads the root.
   * @param {object} [options={}] Query options, not retained.
   * @param {object} [options.skip] One node handle to exclude from this merge, including a parent node.
   * @returns {*} Detached JSON-shaped value, or `undefined` when absent; changing it never changes stored data. Does not mutate the store.
   * @throws {TypeError} Invalid path (empty/nonstring/unsafe segment); correct it before retrying.
   */
  read(path = [], { skip } = {}) {
    checkPath(path);
    const compute = () => {
      const layers = [this.#parent?.read(path, { skip }),
        ...this.#nodes.filter((node) => node !== skip).map((node) => node.layer(path))].filter((value) => value !== undefined);
      return layers.length ? merged(layers) : undefined;
    };
    if (skip) return detached(compute());
    const id = path.join("\0");
    if (!this.#cache.has(id)) this.#cache.set(id, { path, value: compute() });
    return detached(this.#cache.get(id).value);
  }

  /** Drop cached reads overlapping `path` (all when undefined), here and in child stores. */
  #invalidate(path) {
    if (path === undefined) this.#cache.clear();
    else for (const [id, entry] of this.#cache) if (overlaps(entry.path, path)) this.#cache.delete(id);
    for (const child of this.#children) child.#invalidate(path);
  }

  /** Route an immediate write from the last node backward to the first writable exact owner or accepting catch-all, otherwise to the parent.
   * @param {string[]} path Nonempty absolute safe string-segment path; root writes are unsupported.
   * @param {*} value JSON-shaped value copied on storage; `undefined` deletes the owned path, revealing lower layers. An absent deletion without an owner is not captured by a catch-all.
   * @returns {boolean} Whether a node accepted the write (including an equal no-op); false if no node takes it. Changed file nodes are queued for save; changed memory nodes stay in memory.
   * @throws {TypeError} Invalid/root path or closed store; correct the input or use an open store before retrying.
   */
  write(path, value) {
    checkPath(path);
    if (!path.length) throw new TypeError("SettingsStore: cannot write the root");
    if (this.closed || this.#closing) throw new TypeError("SettingsStore: closed");
    for (let index = this.#nodes.length - 1; index >= 0; index--) {
      const node = this.#nodes[index];
      if (!node.takes(path, value)) continue;
      node.assign(node.relative(path), value);
      return true;
    }
    return this.#parent?.write(path, value) ?? false;
  }

  /** Find the last writable node holding the exact path, locally or in the parent; do not use this to predict catch-all routing.
   * @param {string[]} path Absolute safe string-segment path; `[]` has no exact owner.
   * @returns {object|undefined} Live node handle or `undefined`; does not mutate state or transfer ownership.
   * @throws {TypeError} Invalid path; correct it before retrying.
   */
  owner(path) {
    checkPath(path);
    return this.#nodes.findLast((node) => node.owns(path)) ?? this.#parent?.owner(path);
  }

  /** Internal: a node's data at `path` (or, without one, this store's membership) changed.
   * Schedules a storage round. */
  changed(node, path) {
    if (this.closed) return;
    this.#version++;
    this.#invalidate(path);
    if (node) this.#dirty.add(node);
    clearTimeout(this.#saveTimer);
    if (this.#closing) return;
    this.#saveTimer = setTimeout(() => { void this.save({ parent: false }).catch(() => {}); }, SAVE_MS);
    this.#saveTimer.unref?.();
  }

  /** Flush queued local edits, optionally including the parent; queued file writes are atomic replacements (empty objects remove files).
   * File nodes not yet loaded are not overwritten: call `poll()` before expecting
   * their early edits to save. Equal writes do not create notices. A background
   * debounced save also follows changes; await this method to observe completion.
   * @param {object} [options={}] Round options, not retained.
   * @param {boolean} [options.parent=true] Also save the parent when present; false limits this round to local nodes.
   * @returns {Promise<void>} Resolves after file writes and grouped `saved`/`updated` notices; listeners receive sets of affected nodes. Safe to retry after failure: failed file nodes remain dirty.
   * @throws {Error|AggregateError} One or multiple filesystem write failures; fix access/path and retry `save()`.
   */
  save({ parent = true } = {}) {
    return parent && this.#parent ? this.#group(() => this.#save(true)) : this.#save(false);
  }

  async #save(parent) {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    const parentSaved = parent ? this.#parent.save() : undefined;
    while (this.#saving) await this.#saving.catch(() => {});
    const changed = new Set(this.#dirty);
    this.#dirty.clear();
    const files = this.#nodes.filter((node) => node.source && (node.dirty || node.writing));
    const round = (async () => {
      const results = await Promise.all(files.map((node) => node.dirty ? node.save() : node.writing));
      const errors = results.filter((result) => result instanceof Error);
      this.#emit("saved", new Set(files.filter((node, index) => !(results[index] instanceof Error) && node.version !== undefined)));
      this.#emit("updated", changed);
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "SettingsStore: settings files failed to save");
    })();
    this.#saving = round;
    const results = await Promise.allSettled([round.finally(() => { if (this.#saving === round) this.#saving = null; }), parentSaved]);
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "SettingsStore: own and parent saves failed");
  }

  /** Discover files and read changed file nodes, optionally including the parent.
   * Discovery adds sorted matching files and removes vanished clean ones; dirty
   * vanished nodes stay attached until saved. A missing direct file loads as `{}`;
   * JSONC is accepted, but file roots must be plain objects. Successful reads
   * apply even when another file fails; pending edits made before the first load
   * overlay the file data and remain dirty for a later save. Local edits to an
   * already loaded dirty file are not overwritten by a poll.
   * @param {object} [options={}] Round options, not retained.
   * @param {boolean} [options.parent=true] Also poll the parent when present; false limits the round to this store.
   * @returns {Promise<boolean>} True if data or discovery membership changed, false otherwise; emits grouped `loaded` for read nodes and `updated` for changed nodes. Concurrent polls queue another round.
   * @throws {Error|AggregateError} Read, JSONC parse, root-shape, or discovery failures; successful files still apply. Repair failing files/permissions and retry `poll()`; last good data remains for failed reads.
   */
  poll({ parent = true } = {}) {
    return parent && this.#parent ? this.#group(() => this.#poll(true)) : this.#poll(false);
  }

  #poll(parent) {
    const parentPolled = parent ? this.#parent.poll() : Promise.resolve(false);
    let round;
    if (this.#polling) {
      round = this.#pollAgain ??= this.#polling.catch(() => {}).then(() => {
        this.#pollAgain = null;
        return this.poll({ parent: false });
      });
    } else {
      round = this.#pollRound();
      this.#polling = round;
      void round.finally(() => { if (this.#polling === round) this.#polling = null; }).catch(() => {});
    }
    // Both rounds finish applying before either one's errors are reported, and announce together.
    return Promise.allSettled([round, parentPolled]).then(([own, inherited]) => {
      const failed = [own, inherited].find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      return own.value || inherited.value;
    });
  }

  async #pollRound() {
    const errors = [];
    const updated = new Set();
    const membership = await this.#discover(errors);
    if (this.closed) return false;
    const files = this.#nodes.filter((node) => node.source && !(node.dirty && node.version !== undefined));
    const results = await Promise.all(files.map(async (node) => {
      try {
        if (node.version !== undefined && await fileVersion(node.source) === node.version) return null;
        return await fileRead(node.source);
      } catch (error) {
        node.error = error;
        errors.push(error);
        return null;
      }
    }));
    if (this.closed) return false;
    const loaded = new Set();
    files.forEach((node, index) => {
      // A local edit made during the read of a loaded file wins; it saves next.
      if (!results[index] || (node.dirty && node.version !== undefined)) return;
      loaded.add(node);
      if (node.loaded(results[index])) updated.add(node);
    });
    for (const node of membership) updated.add(node);
    if (updated.size) { this.#version++; this.#invalidate(); }
    this.#emit("loaded", loaded);
    this.#emit("updated", updated);
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "SettingsStore: settings files failed to load");
    return updated.size > 0;
  }

  /** Refresh every discovery's files, in order: add new files (sorted), drop vanished clean ones.
   * Returns the nodes added or removed. */
  async #discover(errors) {
    const membership = new Set();
    for (const entry of this.#sources) {
      if (!entry.discovery) continue;
      const { cwd, pattern, exclude, options } = entry.discovery;
      let found = [];
      try {
        for await (const name of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) found.push(join(cwd, name));
      } catch (error) {
        if (error.code !== "ENOENT") { errors.push(error); continue; }
        found = [];
      }
      if (this.closed) return membership;
      found = found.filter((file) => !DEFAULT_EXCLUDE.test(basename(file)) && !exclude?.test(basename(file))).sort();
      const nodes = [];
      for (const file of found) {
        const existing = entry.nodes.find((node) => node.source === file);
        if (existing) { nodes.push(existing); continue; }
        if (this.attached(file)) continue; // attached elsewhere: one node per file
        const node = new SettingsNode(this, { ...options, source: file });
        nodes.push(node);
        membership.add(node);
      }
      // A vanished file's node stays while it has unsaved changes.
      for (const node of entry.nodes) {
        if (nodes.includes(node)) continue;
        if (node.dirty) nodes.push(node);
        else membership.add(node);
      }
      if (nodes.length === entry.nodes.length && nodes.every((node, index) => node === entry.nodes[index])) continue;
      entry.nodes = nodes;
      this.#rebuild();
    }
    return membership;
  }

  /** Stop polling and await local loads and writes; borrowed parent stays open.
   * @returns {Promise<void>} Rejects after cleanup when local persistence fails. */
  async close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    clearInterval(this.#pollTimer);
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    this.#closePromise = (async () => {
      let failure;
      try {
        // Let an in-flight initial read merge early edits before persisting.
        await Promise.allSettled([this.#polling, this.#pollAgain].filter(Boolean));
        if (this.#pollAgain) await Promise.allSettled([this.#pollAgain]);
        // A standalone store may never have been polled. Its first read must
        // merge early writes before the close barrier saves the file.
        const needsLoad = this.#nodes.some((node) => node.source && node.version === undefined);
        if (needsLoad) await Promise.allSettled([this.poll({ parent: false })]);
        try { await this.save({ parent: false }); } catch (error) { failure = error; }
        // A malformed read alone was already reported by poll()/ready().
        // An accepted early write blocked behind that read is different:
        // save() cannot persist a node whose initial version is unknown.
        const blocked = this.#nodes.filter((node) => node.source && node.dirty && node.version === undefined)
          .map((node) => node.error ?? new Error(`SettingsStore: ${node.source} could not load before close`));
        if (blocked.length) {
          const error = blocked.length === 1 ? blocked[0] : new AggregateError(blocked, "SettingsStore: early writes could not load");
          failure = failure ? new AggregateError([failure, error], "SettingsStore: failed to close") : error;
        }
        if (this.#saving) {
          const settled = await Promise.allSettled([this.#saving]);
          if (!failure && settled[0].status === "rejected") failure = settled[0].reason;
        }
      } finally {
        this.closed = true;
        this.#parent?.#children.delete(this);
        for (const off of this.#relays) off();
        for (const listeners of this.#listeners.values()) listeners.clear();
      }
      if (failure) throw failure;
    })();
    return this.#closePromise;
  }
}
