/** Private cooperative forked-tool JSON preparation; keeps custom settings and removes every auth key. */
const CHUNK_UNITS = 32 * 1024;
const SLICE_ITEMS = 1024;
const SLICE_MS = 2;
const observers = new Set();

/** Private probe hook: reports the actual bounded writer slices (not total preparation latency). */
export function toolBootstrapObserve(listener) {
  observers.add(listener);
  return () => observers.delete(listener);
}

function* quoted(text) {
  if (text.length <= Math.floor(CHUNK_UNITS / 6) - 1) { yield JSON.stringify(text); return; }
  yield '"';
  for (let offset = 0; offset < text.length;) {
    // JSON escaping can expand one UTF-16 unit to six output characters.
    let end = Math.min(text.length, offset + Math.floor(CHUNK_UNITS / 6));
    // Do not manufacture lone-surrogate escapes by splitting a valid pair.
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    yield JSON.stringify(text.slice(offset, end)).slice(1, -1);
    offset = end;
  }
  yield '"';
}

function normalize(holder, key) {
  let value = holder[key];
  if (value !== null && (typeof value === "object" || typeof value === "bigint") && typeof value.toJSON === "function") value = value.toJSON(key);
  if (key === "auth") return undefined;
  if (value !== null && typeof value === "object") {
    if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
    else if (Object.prototype.toString.call(value) === "[object BigInt]") throw new TypeError("Do not know how to serialize a BigInt");
  }
  if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
  return value;
}

function* encode(value, ancestors) {
  if (typeof value === "string") { yield* quoted(value); return; }
  if (value === null || typeof value !== "object") { yield JSON.stringify(value) ?? "null"; return; }
  if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
  ancestors.add(value);
  if (Array.isArray(value)) {
    yield "[";
    const length = value.length;
    for (let index = 0; index < length; index++) {
      if (index) yield ",";
      yield* encode(normalize(value, String(index)), ancestors);
    }
    yield "]";
  } else {
    yield "{";
    let first = true;
    // for-in avoids an additional caller-owned full keys array. Engines may
    // still allocate an enumeration snapshot: report that indivisible cost.
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const item = normalize(value, key);
      if (item === undefined || typeof item === "function" || typeof item === "symbol") { yield ""; continue; }
      const prefix = first ? "" : ",";
      first = false;
      if (key.length <= Math.floor(CHUNK_UNITS / 6) - 1) yield `${prefix}${JSON.stringify(key)}:`;
      else { yield prefix; yield* quoted(key); yield ":"; }
      // Scalars are the common catalog leaf: avoid a generator activation for
      // every tiny number/string/boolean, which otherwise amplifies GC pauses.
      if (item === null || typeof item !== "object" && (typeof item !== "string" || item.length <= Math.floor(CHUNK_UNITS / 6) - 1)) yield JSON.stringify(item);
      else yield* encode(item, ancestors);
    }
    yield "}";
  }
  ancestors.delete(value);
}

/**
 * Validate and prepare bounded JSON chunks before spawning, yielding between slices.
 * Input is borrowed, never mutated: callers retain stable settings snapshots and
 * dispatch-owned arguments until this promise settles. Chunks are owned output.
 * Wide-object enumeration and user getters/toJSON can still be indivisible.
 */
export async function toolBootstrapChunks(value, { signal, scope } = {}) {
  const iterator = encode(normalize({ "": value }, ""), new Set());
  const chunks = [];
  let fragments = [];
  let pendingLength = 0;
  const flush = () => {
    if (!pendingLength) return;
    // Retain compact chunks, not a million-node rope of tiny JSON tokens.
    // Each join is bounded to CHUNK_UNITS rather than the full bootstrap.
    chunks.push(fragments.join(""));
    fragments = []; pendingLength = 0;
  };
  let done = false;
  while (!done) {
    signal?.throwIfAborted();
    if (scope?.closed) throw new Error("tool sandbox is closed");
    const start = performance.now();
    let items = 0;
    while (items < SLICE_ITEMS && performance.now() - start < SLICE_MS) {
      const next = iterator.next();
      items++;
      if (next.done) { done = true; break; }
      if (pendingLength + next.value.length > CHUNK_UNITS) flush();
      if (next.value) { fragments.push(next.value); pendingLength += next.value.length; }
      if (pendingLength >= CHUNK_UNITS) flush();
    }
    if (observers.size) {
      const slice = { duration: performance.now() - start, items, done };
      for (const observer of observers) observer(slice);
    }
    if (!done) await new Promise((resolve) => setImmediate(resolve));
  }
  flush();
  return chunks;
}

/** Write without a giant join or an unbounded stream queue; small legacy mock pipes accept end(string). */
export async function toolBootstrapWrite(stream, chunks, { signal, scope } = {}) {
  signal?.throwIfAborted();
  if (scope?.closed) throw new Error("tool sandbox is closed");
  if (typeof stream.write !== "function") { stream.end(chunks.join("")); return; }
  let start = performance.now();
  let writes = 0;
  for (const chunk of chunks) {
    signal?.throwIfAborted();
    if (scope?.closed) throw new Error("tool sandbox is closed");
    if (writes >= 32 || performance.now() - start >= SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
      if (scope?.closed) throw new Error("tool sandbox is closed");
      start = performance.now(); writes = 0;
    }
    writes++;
    if (stream.destroyed) throw new Error("worker input closed during bootstrap");
    if (!stream.write(chunk)) {
      await new Promise((resolve, reject) => {
        const cleanup = () => { stream.off("drain", drained); stream.off("error", failed); stream.off("close", closed); };
        const drained = () => { cleanup(); resolve(); };
        const failed = (error) => { cleanup(); reject(error); };
        const closed = () => { cleanup(); reject(new Error("worker input closed during bootstrap")); };
        stream.once("drain", drained); stream.once("error", failed); stream.once("close", closed);
      });
    }
  }
  stream.end();
}
