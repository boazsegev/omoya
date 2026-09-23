/**
 * lib/session.js — JSONL session store (Agent-owned persistence).
 *
 * On-disk NAME (the core skill's `YYYY-MM-DD NNN descriptive title`
 * convention, adapted): `<dir>/<date> <uuid8>[ <name>].jsonl` (default
 * directory under the settings folder — OUTSIDE the project tree, so an
 * agent's own cwd-rooted file tools can never rewrite its session log
 * and fake work) — NO "session-" prefix: the dedicated folder already
 * says what the file is, so the prefix would be pure noise — `date`
 * the session's creation date, `uuid8` the first 4 hex bytes of its
 * sessionUUID (the disambiguator, standing in for the skill's NNN
 * counter — no folder scan needed to pick one), `name` the session's
 * given name when it has one, else the first 24 characters of its
 * first REAL message (user, or assistant with actual text — a
 * pure-thinking-only message never qualifies), filled in on the
 * session's first real flush and then frozen. The FILE NAME is a
 * presentation detail ONLY: the store's stable identity is `id` (an
 * explicit chosen name, or a fresh UUID by default) — every lookup
 * (resume/originOf) matches by the metadata line's `id` field, a
 * directory scan, never by reconstructing the path from it. Every
 * `*.jsonl` file in the folder is scanned regardless of name; only
 * files carrying the metadata header are sessions.
 * `/session-name` (rename()) changes id AND name together (same uuid8/
 * date prefix — the same session, a new label); the auto-derived name
 * above only ever fires for a session that was never explicitly named.
 *
 * Holds the CURRENT context, one message per line, preceded by ONE
 * metadata line (see below). There is NO change log: an edit/rollback/
 * pop/merge is a full atomic rewrite (write temp + rename), while a
 * stretch of pure tail appends flushes as just the new lines (a crash
 * can tear the tail line; the tolerant reader drops it) — see
 * _planFlush(). A session file is a plain message store — to preserve
 * a snapshot of a conversation, fork it (ai /fork).
 *
 * The FIRST line is a METADATA record — `{"type":"session-metadata",
 * "id", "uuid", "name", "cwd", "created"}` — not a message (no numeric
 * type): the tolerant reader ignores it on load, and it is what maps a
 * session to the folder it ran in (and its id to its file, now that
 * the two are decoupled). list()/latest() take a `cwd` and scan only
 * each file's FIRST line, so `resume` offers exactly the sessions
 * associated with the current folder (hundreds of files scan cheaply).
 *
 * Loading (SessionStore.resume / loadMessages) is a tolerant reader:
 * one JSON value per line (JSONL).
 * Messages (numeric `type`) load; metadata RECORDS (a string `type` —
 * the note tool's store backup, user annotations) load too and ride
 * the context, EXCEPT the file's own `session-metadata` header (it
 * maps the file, never re-enters the context); anything else is
 * quietly ignored, never an error.
 *
 * Mutations buffer in memory and flush synchronously (see _planFlush):
 * Agent flushes after every terminal (done/error —
 * "synced onDone"), and a lib/finish.js onFinish hook flushes as the
 * crash backstop. A hard crash loses at most the unflushed in-flight
 * work.
 *
 * Retention: none — plain files; the caller owns cleanup (the TUI's
 * /sessions-delete-all! command empties the folder on confirmation).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { rm, writeFile, readdir, readFile, stat, realpath, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { onFinish } from "./finish.js";
import Context from "../context.js";
const { isMessage, isRecord, MessageType, ContentType, editBlock, editMessage, pop, rollbackTo, removeMessages, appendMessage } = Context;
import Env from "../env.js";
const { defaultSessionsDir } = Env;

/** The default namespace session folder under settings (created when
 *  missing) — outside the project tree by design (see the header). */
export function sessionDir() {
  return defaultSessionsDir();
}

/** The metadata record's type marker (NOT a message type — the
 *  tolerant reader ignores it). */
const METADATA_TYPE = "session-metadata";
const METADATA_VERSION = 1;

/** A session id becomes a FILE NAME (`<id>.jsonl`): no whitespace, no
 *  path separators, no dot-files, 1–64 chars; the anonymous spellings
 *  stay reserved for /session-new. */
const SESSION_ID = /^[^\s/\\]{1,64}$/;
const RESERVED_IDS = new Set(["0", "false", "anon"]);

/**
 * Validate a session id (chosen names ride into the file name).
 * @param {*} id
 * @returns {string} the id, trimmed
 */
export function validateSessionId(id) {
  if (typeof id !== "string" || id.trim() === "") throw new Error("a session name must be a non-empty string");
  const trimmed = id.trim();
  if (RESERVED_IDS.has(trimmed)) throw new Error(`"${trimmed}" is reserved (it spells an anonymous session)`);
  if (trimmed === "." || trimmed === ".." || !SESSION_ID.test(trimmed)) {
    throw new Error(`invalid session name "${trimmed}" — 1–64 characters, no whitespace, no path separators`);
  }
  return trimmed;
}

/** The metadata record a session file opens with. */
function metadataRecord(id, origin, created, uuid, name) {
  return { type: METADATA_TYPE, version: METADATA_VERSION, id, uuid, name, cwd: origin, created };
}

/** A canonical randomUUID() shape — used to tell an AUTO id (a bare
 *  UUID, no name given) from an EXPLICIT one (a chosen name). */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session file's STEM (everything before ".jsonl", and the whole
 *  file name — no prefix): `<date> <uuid8>[ <name>]` — see the module doc. */
function fileStem({ created, uuid, name }) {
  const date = new Date(created).toISOString().slice(0, 10);
  const short = uuid.slice(0, 8);
  return name ? `${date} ${short} ${name}` : `${date} ${short}`;
}

/**
 * The auto-derived NAME when none was given: the first 24 characters
 * of the first REAL message (User, or Assistant with actual text — an
 * assistant message that is ONLY thinking blocks has no text and never
 * qualifies), whitespace-folded. undefined when the context holds no
 * such message yet (System-only, or a context of tool/thinking noise).
 * @param {Array<object>} context
 * @returns {string|undefined}
 */
function deriveNameFromContext(context) {
  for (const m of context) {
    if (m?.type !== MessageType.User && m?.type !== MessageType.Assistant) continue;
    const text = (m.content ?? [])
      .filter((b) => b?.type === ContentType.Text)
      .map((b) => b.text ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text === "") continue;
    return text.replace(/[/\\]/g, "-").slice(0, 24);
  }
  return undefined;
}

/**
 * Find a session file in `folder` by its STABLE `id` (a directory
 * scan reading each file's first line — cheap even at hundreds of
 * files; the file name does not encode `id` directly).
 * @param {string} folder
 * @param {string} id
 * @returns {string|undefined} the file path, or undefined
 */
export function findSessionFile(folder, id) {
  if (!existsSync(folder)) return undefined;
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(folder, name);
    if (readSessionMetadata(file)?.id === id) return file;
  }
  return undefined;
}

/**
 * Read a session file's FIRST LINE only (hundreds of files scan
 * cheaply) and parse its metadata record — {id, cwd, created} or
 * null (a foreign file — not a session: it never lists).
 * @param {string} file
 * @returns {{id?: string, cwd?: string, created?: string}|null}
 */
export function readSessionMetadata(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(4096);
    const bytes = readSync(fd, buffer, 0, 4096, 0);
    return parseSessionMetadata(buffer.toString("utf8", 0, bytes));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

function parseSessionMetadata(text) {
  try {
    const parsed = JSON.parse(text.split("\n", 1)[0]);
    return parsed?.type === METADATA_TYPE ? parsed : null;
  } catch {
    return null;
  }
}

/** Async first-4KiB counterpart of readSessionMetadata(). */
async function readSessionMetadataAsync(file) {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    return parseSessionMetadata(buffer.toString("utf8", 0, bytesRead));
  } catch {
    return null;
  } finally {
    if (handle !== undefined) try { await handle.close(); } catch { /* already closed */ }
  }
}

/** Two folder paths are the same place (realpath when it exists). */
export function sameFolder(a, b) {
  const identity = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return identity(a) === identity(b);
}

const TEXT_TOKEN = '"text":"';
const PREVIEW_CAPTURE = 2048;
const SCAN_CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

/** The display preview out of one serialized User-message line: the first
 *  text block's content, JSON-unescaped from a bounded window (a display
 *  snippet never justifies parsing a megabyte-long line). */
function extractTextPreview(line) {
  const at = line.indexOf(TEXT_TOKEN);
  if (at < 0) return "";
  const window = line.slice(at + TEXT_TOKEN.length - 1, at + TEXT_TOKEN.length + 1024);
  const match = /^"((?:[^"\\]|\\.)*)/.exec(window);
  if (!match) return "";
  let text;
  try { text = JSON.parse(`${match[0]}"`); } catch { return ""; }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 72 ? `${text.slice(0, 71)}…` : text;
}

/** Incremental session-file scanner state (see scanSessionFile*): a
 *  newline census plus the first User line's bounded capture. Byte-level
 *  matching is safe: "\n" and the ASCII head never appear inside a
 *  multibyte UTF-8 sequence. */
function createPreviewScanner(hasMetadata) {
  const USER_HEAD = Buffer.from(`{"type":${MessageType.User},`);
  let skipped = !hasMetadata;
  let messages = 0;
  let lineHasContent = false;
  let lineHead = Buffer.alloc(0);
  let capturing = false;
  let captured = [];
  let capturedBytes = 0;
  let previewDone = false;
  return {
    /** Feed one chunk. */
    feed(chunk) {
      let offset = 0;
      while (offset <= chunk.length) {
        const nl = chunk.indexOf(NEWLINE, offset);
        const end = nl < 0 ? chunk.length : nl;
        const segment = chunk.subarray(offset, end);
        if (skipped) {
          if (segment.length > 0) {
            lineHasContent = true;
            if (!previewDone && lineHead.length < USER_HEAD.length) {
              lineHead = Buffer.concat([lineHead, segment.subarray(0, USER_HEAD.length - lineHead.length)]);
            }
            if (!previewDone) {
              if (!capturing && lineHead.equals(USER_HEAD)) capturing = true;
              if (capturing && capturedBytes < PREVIEW_CAPTURE) {
                const slice = segment.subarray(0, PREVIEW_CAPTURE - capturedBytes);
                captured.push(Buffer.from(slice)); // copy: the chunk buffer is reused
                capturedBytes += slice.length;
              }
            }
          }
          if (nl < 0) break;
          if (lineHasContent) messages++;
          if (capturing) previewDone = true; // the first User line is complete
          lineHasContent = false;
          lineHead = Buffer.alloc(0);
          capturing = false;
        } else if (nl >= 0) {
          skipped = true; // the metadata line is consumed
        }
        if (nl < 0) break;
        offset = nl + 1;
      }
      return undefined;
    },
    result() {
      const preview = capturedBytes > 0 ? extractTextPreview(Buffer.concat(captured).toString("utf8")) : "";
      return { messages, preview };
    },
  };
}

/** A session file's {messages, preview} in one bounded-memory pass: the
 *  store writes one JSON value per line, so the count is a newline census
 *  and the preview is the first User line's first text token — listing a
 *  folder never holds (let alone parses) megabytes of history.
 *  @param {string} file
 *  @param {boolean} hasMetadata - whether line 1 is the metadata record
 */
function scanSessionFileSync(file, hasMetadata) {
  const scanner = createPreviewScanner(hasMetadata);
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      scanner.feed(buffer.subarray(0, bytes));
    }
    return scanner.result();
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Async counterpart of scanSessionFileSync. */
async function scanSessionFile(file, hasMetadata) {
  const scanner = createPreviewScanner(hasMetadata);
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      scanner.feed(buffer.subarray(0, bytesRead));
    }
    return scanner.result();
  } finally {
    if (handle !== undefined) try { await handle.close(); } catch { /* already closed */ }
  }
}

/** One folder-scan hit, shaped for list()/listAsync (the metadata line's
 *  `id` is the STABLE identity — the file NAME is a presentation detail;
 *  a metadata-less file falls back to its own name). */
function foundEntry(metadata, name, file, mtime) {
  return { id: metadata.id, file, mtime, hasMetadata: true };
}

const byMtimeDesc = (a, b) => b.mtime - a.mtime;

/** Preview one list entry via the bounded scanner (unreadable: no preview). */
function previewEntrySync(entry) {
  const { hasMetadata, ...rest } = entry;
  try {
    return { ...rest, ...scanSessionFileSync(entry.file, hasMetadata) };
  } catch { /* unreadable: no preview */ }
  return { ...rest, messages: 0, preview: "" };
}

/** Async counterpart of previewEntrySync. */
async function previewEntry(entry) {
  const { hasMetadata, ...rest } = entry;
  try {
    return { ...rest, ...(await scanSessionFile(entry.file, hasMetadata)) };
  } catch { /* unreadable: no preview */ }
  return { ...rest, messages: 0, preview: "" };
}

/**
 * Parse session data (file text or an already-parsed value) into a
 * context array. Tolerant reader: accepts a JSON array, or JSONL (one
 * JSON value per line); quietly drops every value that isn't a
 * core-shaped message OR a metadata RECORD (an object with a string
 * `type` — isRecord, lib/context/validate.js): records (the note
 * tool's store backup, user annotations) ride into the context, while
 * the file's own `session-metadata` header record stays OUT (it maps
 * the file to its folder — it is not context content, and re-loading
 * it would duplicate it on the next flush).
 * @param {string|Array} data - raw file text or a parsed array
 * @returns {Array<object>} the messages and records found, in order
 */
export function loadMessages(data) {
  if (Array.isArray(data)) {
    return data.filter((v) => isMessage(v) || (isRecord(v) && v.type !== METADATA_TYPE));
  }
  const values = [];
  for (const line of String(data ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch { /* unparseable lines are ignored, never fatal */ }
  }
  return values.filter((v) => isMessage(v) || (isRecord(v) && v.type !== METADATA_TYPE));
}

/** A JSONL session store: the live context array plus its atomic file rewrite. */
export class SessionStore {
  /**
   * Open a store for a session id (the file is created on the first
   * flush of a non-empty context); registers the crash-safe finish hook.
   * @param {Object} [options]
   * @param {string} [options.id] - session id (default: random UUID)
   * @param {string} [options.dir] - session folder (default: the
   *   namespace session directory outside the project tree)
   * @param {Array} [options.context] - the live context array (Agent-owned)
   * @param {string} [options.origin] - the folder the session RUNS in
   *   (default: process.cwd()) — recorded in the file's metadata line;
   *   resume's scans list only sessions of the current folder
   * @param {NodeJS.Process} [options.process] - injectable for tests
   * @param {string} [options.uuid] - carry an existing sessionUUID
   *   forward (SessionStore.resume() only — a fresh session always
   *   gets a new one)
   * @param {string} [options.name] - carry an existing stored NAME
   *   forward (SessionStore.resume() only — see the module doc)
   * @param {boolean} [options.save=true] - whether this store writes its
   *   context to disk; false retains it only in memory
   */
  constructor({ id, dir, context = [], origin, process: proc, uuid, name, save = true } = {}) {
    if (typeof save !== "boolean") throw new TypeError("SessionStore: save must be a boolean");
    this.id = id ?? randomUUID();
    this.dir = dir ?? sessionDir();
    this._save = save;
    // RECONSTRUCTING an id that already has a file on disk (fork/reseat/
    // /session-delete!'s restart-in-place all build a FRESH store under
    // the SAME id, discarding content but expecting the SAME file slot
    // — e.g. so the fresh empty store's flush() can clean up the old
    // one) adopts that file's uuid/name/created: same identity, same
    // file, no matter how many stores get built for it.
    const adopted = save && uuid === undefined && id !== undefined
      ? readSessionMetadata(findSessionFile(this.dir, id) ?? "") : null;
    // an id that IS a bare UUID (nothing explicit was chosen) has no
    // name yet — it derives one from the first real message on the
    // first real flush (see flush()); an explicit id doubles as the
    // name (it already IS the session's chosen label)
    this.uuid = uuid ?? adopted?.uuid ?? (UUID_SHAPE.test(this.id) ? this.id : randomUUID());
    this.name = name ?? adopted?.name ?? (UUID_SHAPE.test(this.id) ? undefined : this.id);
    this._fileFinalized = this.name !== undefined; // nothing left to auto-derive
    this.origin = origin ?? process.cwd();
    this.created = adopted?.created ?? new Date().toISOString();
    this.context = context;
    this.file = join(this.dir, `${fileStem(this)}.jsonl`);
    // _dirty: false | "append" (only pure tail appends since the last
    // flush) | "full" (anything else). _flushedCount: how many context
    // messages the file durably holds (-1: unknown/stale — the next
    // flush must rewrite). Both feed _planFlush()'s append fast-path.
    this._dirty = context.length > 0 ? "full" : false; // seed content must reach disk
    this._flushedCount = -1;
    this._version = 0; // async flush clears dirty only for the snapshot it wrote
    this._flushSeq = 0;
    this._closed = false;
    if (this._save) mkdirSync(this.dir, { recursive: true });
    this._unregister = onFinish(() => this.flush(), { process: proc });
  }

  /** @returns {boolean} whether this store writes its context to disk */
  get save() {
    return this._save;
  }

  /**
   * Enable or disable persistence without replacing the live context. Enabling
   * saving makes the complete current context eligible for the next flush.
   * @param {boolean} value
   * @returns {boolean} whether saving is enabled
   */
  saveSet(value) {
    if (typeof value !== "boolean") throw new TypeError("SessionStore.saveSet: value must be a boolean");
    if (value === this._save) return this._save;
    this._save = value;
    this._version++;
    if (value) {
      mkdirSync(this.dir, { recursive: true });
      this._dirty = this.context.length > 0 ? "full" : false;
      this._flushedCount = -1;
    }
    return this._save;
  }

  _mutate(kind = "full") {
    if (this._closed) throw new Error(`SessionStore "${this.id}" is closed`);
    // "full" always wins; it also invalidates the durable-prefix ledger.
    this._dirty = this._dirty === "full" || kind === "full" ? "full" : "append";
    if (this._dirty === "full") this._flushedCount = -1;
    this._version++;
  }

  /** Append a message, MERGING with the last one when possible
   *  (consecutive same-type messages / same-sub-type blocks fold —
   *  Context appendMessage). Returns the stored message. */
  append(message, options) {
    const before = this.context.at(-1);
    const stored = appendMessage(this.context, message, options);
    // A merge REWRITES the last stored message (its file line changes) —
    // only a brand-new tail message keeps the append fast-path alive.
    this._mutate(before !== undefined && stored === before ? "full" : "append");
    return stored;
  }

  /** Insert messages at the FRONT of the context — Agent's seeded
   *  system prompt, which must always be the first message(s) of a
   *  fresh context. */
  prepend(messages) {
    if (messages.length === 0) return;
    this.context.unshift(...messages);
    this._mutate();
  }

  /** Replace context[i] through Context (stale identifiers dropped). */
  edit(i, message) {
    const clean = editMessage(this.context, i, message);
    this._mutate();
    return clean;
  }

  /** Replace context[i].content[j] through Context. */
  editBlock(i, j, block) {
    const clean = editBlock(this.context, i, j, block);
    this._mutate();
    return clean;
  }

  /** Remove all messages at index >= i. */
  rollback(i) {
    const removed = rollbackTo(this.context, i);
    if (removed.length > 0) this._mutate();
    return removed;
  }

  /** Remove the last message. */
  pop() {
    const removed = pop(this.context);
    if (removed !== undefined) this._mutate();
    return removed;
  }

  /** Remove selected messages. */
  removeMessages(indexes) {
    const removed = removeMessages(this.context, indexes);
    this._mutate();
    return removed;
  }

  /**
   * The flush DECISION, shared by the synchronous flush() and the async
   *  loop driver (_flushAsync): what makes the current context durable.
   *   - "remove": an empty (or System-only) context never has a file;
   *     a stale one goes away.
   *   - "none": nothing changed since the last flush.
   *   - "append": FAST-PATH — every mutation since the last flush was a
   *     pure tail append and the file already holds _flushedCount
   *     messages: writing just the new tail lines suffices (a crash can
   *     tear the last line; the tolerant reader drops it).
   *   - "full": anything else — the whole context, atomic temp+rename.
   *  An UNNAMED session (a bare-UUID id, nothing chosen) derives its
   *  file's NAME segment from the first real message the FIRST time
   *  there is real content to flush, then freezes it — later edits to
   *  that message never rename the file again (see the module doc).
   * @returns {{kind:"remove"}|{kind:"none"}|{kind:"append"|"full", file:string, body:string}}
   */
  _planFlush() {
    if (!this._save) return { kind: "none" };
    const started = this.context.some((m) => m?.type !== MessageType.System);
    if (this.context.length === 0 || !started) return { kind: "remove" };
    if (!this._fileFinalized) {
      const derived = deriveNameFromContext(this.context);
      if (derived !== undefined) {
        this.name = derived;
        this.file = join(this.dir, `${fileStem(this)}.jsonl`);
        this._fileFinalized = true;
      }
    }
    if (!this._dirty) return { kind: "none" };
    if (this._dirty === "append" && this._flushedCount > 0 && existsSync(this.file)) {
      const body = this.context.slice(this._flushedCount).map((m) => JSON.stringify(m)).join("\n") + "\n";
      return { kind: "append", file: this.file, body };
    }
    const body = [JSON.stringify(metadataRecord(this.id, this.origin, this.created, this.uuid, this.name)),
      ...this.context.map((m) => JSON.stringify(m))].join("\n") + "\n";
    return { kind: "full", file: this.file, body };
  }

  /** Execute a flush plan synchronously (no yield, no interleaving). */
  _commitSync(plan) {
    if (plan.kind === "none") return;
    if (plan.kind === "remove") {
      if (existsSync(this.file)) rmSync(this.file, { force: true });
      this._flushedCount = 0;
    } else if (plan.kind === "append") {
      writeFileSync(plan.file, plan.body, { flag: "a" });
      this._flushedCount = this.context.length;
    } else {
      const tmp = `${plan.file}.tmp-${process.pid}`;
      writeFileSync(tmp, plan.body);
      renameSync(tmp, plan.file);
      this._flushedCount = this.context.length;
    }
    this._dirty = false;
  }

  /**
   * Synchronously make the CURRENT context durable (see _planFlush for
   * the remove/none/append/full decision). Idempotent; a no-op when
   * nothing changed since the last flush.
   */
  flush() {
    this._commitSync(this._planFlush());
  }

  /**
   * Async counterpart used only by Agent's live request/tool loop. The
   * public synchronous flush() remains the crash/exit and library contract.
   * "remove"/"append" plans are tiny and interleave-free, so they commit
   * synchronously; only a "full" rewrite yields, snapshotting one version
   * so a mutation while I/O is pending remains dirty for the following
   * flush rather than being lost.
   * @private
   */
  async _flushAsync() {
    const version = this._version;
    const plan = this._planFlush();
    if (plan.kind !== "full") {
      this._commitSync(plan);
      return;
    }
    const tmp = `${plan.file}.tmp-${process.pid}-${++this._flushSeq}`;
    try {
      await writeFile(tmp, plan.body);
      // A public synchronous mutation/flush may have completed while the
      // write yielded. Never let this older snapshot rename over it.
      if (!this._save || this._version !== version || this.file !== plan.file) return;
      renameSync(tmp, plan.file); // tiny atomic commit; no yield between check and rename
      this._flushedCount = this.context.length;
      this._dirty = false;
    } finally {
      // writeFile failures and stale snapshots leave no retry-confusing temp.
      if (existsSync(tmp)) await rm(tmp, { force: true });
    }
  }

  /** Flush and detach the finish hook. */
  close() {
    if (this._closed) return;
    this.flush();
    this._unregister?.();
    this._closed = true;
  }

  /**
   * Rename the session: BOTH the stable `id` and the file's NAME
   * segment become `newId` (the same session — the date/uuid8 prefix
   * carries over unchanged) and the old file is gone. Refuses to
   * clobber an EXISTING other session (a directory scan by `id`, the
   * file name no longer being a direct function of it).
   * @param {string} newId
   * @returns {{id: string, file: string}}
   */
  rename(newId) {
    if (this._closed) throw new Error(`SessionStore "${this.id}" is closed`);
    const id = validateSessionId(newId);
    const clash = findSessionFile(this.dir, id);
    if (clash !== undefined && clash !== this.file) {
      throw new Error(`a session named "${id}" already exists — pick another name`);
    }
    const oldFile = this.file;
    this.id = id;
    this.name = id;
    this._fileFinalized = true;
    this.file = join(this.dir, `${fileStem(this)}.jsonl`);
    if (oldFile !== this.file) rmSync(oldFile, { force: true }); // the old name's file goes away
    this._mutate(); // the metadata line's id/name rewrite on the next flush
    this.flush();
    return { id: this.id, file: this.file };
  }

  /**
   * The ORIGIN FOLDER recorded in a session file's metadata line (the
   * cwd the session ran in), or undefined (no such session). The
   * resume-anywhere contract: an explicit --resume <id> makes this
   * folder the process cwd.
   * @param {Object} options
   * @param {string} options.id
   * @param {string} [options.dir]
   * @returns {string|undefined}
   */
  static originOf({ id, dir } = {}) {
    const folder = dir ?? sessionDir();
    const file = findSessionFile(folder, id);
    if (file === undefined) return undefined;
    return readSessionMetadata(file)?.cwd ?? undefined;
  }

  /**
   * Load a session file into a fresh store holding its live context.
   * The file is found by a directory scan matching `id` against each
   * file's metadata line (the file name is a presentation detail, not
   * a direct function of `id` — see the module doc). Non-message
   * records in the file are quietly ignored (tolerant reader — see
   * loadMessages).
   * @param {Object} options
   * @param {string} options.id
   * @param {string} [options.dir]
   * @param {NodeJS.Process} [options.process] - injectable for tests
   * @param {boolean} [options.save=true] - whether the resumed store writes to disk
   * @returns {SessionStore} store holding the loaded live context
   */
  static resume({ id, dir, process: proc, save = true } = {}) {
    const folder = dir ?? sessionDir();
    const file = findSessionFile(folder, id);
    if (file === undefined) {
      throw new Error(`SessionStore.resume: no session "${id}" in ${folder}`);
    }
    const context = loadMessages(readFileSync(file, "utf8"));
    const metadata = readSessionMetadata(file);
    const store = new SessionStore({
      id, dir: folder, context, process: proc,
      uuid: metadata?.uuid, name: metadata?.name, save,
    });
    if (metadata?.cwd) store.origin = metadata.cwd;
    if (metadata?.created) store.created = metadata.created;
    store.file = file; // PIN to the exact file loaded — never recompute/rename it implicitly
    store._fileFinalized = true; // a resumed file keeps its name; only an explicit rename touches it
    store._dirty = false; // the file already holds exactly this context
    store._flushedCount = context.length; // appends resume the fast-path
    return store;
  }

  /**
   * Every session in the folder, LATEST FIRST, each with a small
   * preview: a snippet of the first user message (whitespace-folded,
   * capped). With `cwd`, only sessions whose metadata records THAT
   * origin folder list (the resume contract: a project sees its own
   * sessions; foreign metadata-less files are skipped by
   * the FIRST-LINE scan, never parsed in full). Previews are read
   * only for the newest `limit` files (stats are cheap; parsing is
   * not). Unreadable files list without a preview, never an error.
   * @param {Object} [options]
   * @param {string} [options.dir]
   * @param {string} [options.cwd] - only sessions of THIS origin folder
   * @param {number} [options.limit] - max sessions returned (default 50)
   * @returns {Array<{id: string, file: string, mtime: number, messages: number, preview: string}>}
   */
  static list({ dir, cwd, limit = 50 } = {}) {
    const folder = dir ?? sessionDir();
    if (!existsSync(folder)) return [];
    const found = [];
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(folder, name);
      try {
        // the metadata line's `id` is the STABLE identity (the file
        // NAME is a presentation detail — see the module doc); a file
        // with no metadata line at all is not a session
        const metadata = readSessionMetadata(file); // the first line only
        if (!metadata) continue;
        if (cwd !== undefined && (!metadata.cwd || !sameFolder(metadata.cwd, cwd))) continue;
        const stat = statSync(file);
        if (stat.isFile()) found.push(foundEntry(metadata, name, file, stat.mtimeMs));
      } catch { /* vanished between readdir and stat: skip */ }
    }
    found.sort(byMtimeDesc);
    return found.slice(0, Math.max(1, limit)).map(previewEntrySync);
  }

  /**
   * Nonblocking counterpart of list(). It deliberately has its own async
   * folder identity rather than calling sameFolder(), whose realpathSync
   * would stall the interactive loop.
   * @returns {Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string}>>}
   */
  static async listAsync({ dir, cwd, limit = 50 } = {}) {
    const folder = dir ?? sessionDir();
    let names;
    try { names = await readdir(folder); } catch { return []; }
    const identity = async (path) => {
      try { return await realpath(path); } catch { return resolve(path); }
    };
    const cwdIdentity = cwd === undefined ? undefined : await identity(cwd);
    const found = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(folder, name);
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        const metadata = await readSessionMetadataAsync(file);
        if (!metadata) continue;
        if (cwdIdentity !== undefined && (!metadata.cwd || await identity(metadata.cwd) !== cwdIdentity)) continue;
        found.push(foundEntry(metadata, name, file, info.mtimeMs));
      } catch { /* vanished between readdir and stat: skip */ }
    }
    found.sort(byMtimeDesc);
    const result = [];
    for (const entry of found.slice(0, Math.max(1, limit))) result.push(await previewEntry(entry));
    return result;
  }

  /**
   * The id of the most recently modified session in the folder (of
   * the `cwd` origin when given), or undefined when the folder has none.
   * @param {Object} [options]
   * @param {string} [options.dir]
   * @param {string} [options.cwd] - only sessions of THIS origin folder
   * @returns {string|undefined}
   */
  static latest({ dir, cwd } = {}) {
    return SessionStore.list({ dir, cwd, limit: 1 })[0]?.id;
  }

  /**
   * Delete EVERY session file in the folder (the /sessions-delete-all!
   * contract — the user confirmed; foreign files stay untouched).
   * @param {Object} [options]
   * @param {string} [options.dir]
   * @returns {{deleted: number}}
   */
  static deleteAll({ dir } = {}) {
    const folder = dir ?? sessionDir();
    if (!existsSync(folder)) return { deleted: 0 };
    let deleted = 0;
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(folder, name);
      // "foreign" (never ours) files stay untouched: a session carries
      // the metadata line
      if (readSessionMetadata(file) === null) continue;
      rmSync(file, { force: true });
      deleted++;
    }
    return { deleted };
  }

}
