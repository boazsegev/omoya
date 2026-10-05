/**
 * lib/context/store.js — the stateful Context (private to Context; the
 * façade lib/context.js publishes it with the data-model statics): an
 * ordered message list held in a private array, optionally NAMED and
 * LOGGED to a JSONL session file.
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
 * "id", "uuid", "name", "cwd", "created", "agent"}` — not a message (no numeric
 * type): the tolerant reader ignores it on load, and it is what maps a
 * session to the folder it ran in (and its id to its file, now that
 * the two are decoupled). `agent` holds the session-owned AGENT
 * SETTINGS snapshot (safe, thinking, endpoint/model, name, … — written
 * by Agent through the settings setter): resume restores them with the
 * context. list()/latest() take a `cwd` and scan only
 * each file's FIRST line, so `resume` offers exactly the sessions
 * associated with the current folder (hundreds of files scan cheaply).
 *
 * Loading (Context.resume / loadMessages) is a tolerant reader:
 * one JSON value per line (JSONL).
 * Messages (numeric `type`) load; metadata RECORDS (a string `type` —
 * the note tool's store backup, user annotations) load too and ride
 * the context, EXCEPT the file's own `session-metadata` header (it
 * maps the file, never re-enters the context); anything else is
 * quietly ignored, never an error.
 *
 * Mutations buffer in memory and flush synchronously (see _planFlush):
 * the owner flushes at its durability points (an Agent: after every
 * terminal, "synced onDone", plus a process-finish hook as the crash
 * backstop — lib/agent/finish.js). A hard crash loses at most the unflushed in-flight
 * work.
 *
 * Retention: none — plain files; the caller owns cleanup (the TUI's
 * /sessions-delete-all! command empties the folder on confirmation).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { rm, writeFile, readdir, readFile, stat, realpath, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { MessageType, ContentType } from "./types.js";
import { isMessage, isRecord } from "./validate.js";
import { blockAt, editBlock, editMessage, pop, popError, rollbackTo, removeMessages } from "./edit.js";
import { appendMessage } from "./merge.js";

/** A logging folder is required: Context sits below Env and never guesses one. */
function requireDir(dir, owner) {
  if (typeof dir !== "string" || dir === "") throw new TypeError(`Context.${owner}: dir (the sessions folder) is required`);
  return dir;
}

/** The metadata record's type marker (NOT a message type — the
 *  tolerant reader ignores it). */
const METADATA_TYPE = "session-metadata";
const METADATA_VERSION = 1;
// Bounded per-folder cache; every listing still stats current names to detect external changes.
const sessionListCache = new Map();

/** A session id becomes a FILE NAME (`<id>.jsonl`): no whitespace, no
 *  path separators, no dot-files, 1–64 chars; the no-log spellings
 *  stay reserved for /session-new. */
const SESSION_ID = /^[^\s/\\]{1,64}$/;

/**
 * The spellings of an ANONYMOUS (not logged, memory-only) session where a
 * session id is expected: `false`, and the typed forms "0", "false", "anon".
 * The one definition every layer (Agent, reseat, CLI, front ends) uses.
 * @param {*} id
 * @returns {boolean}
 */
const isAnonymousId = (id) => id === false || id === "0" || id === "false" || id === "anon";

/**
 * Validate a session id (chosen names ride into the file name).
 * @param {*} id
 * @returns {string} the id, trimmed
 */
export function validateSessionId(id) {
  if (typeof id !== "string" || id.trim() === "") throw new Error("a session name must be a non-empty string");
  const trimmed = id.trim();
  if (isAnonymousId(trimmed)) throw new Error(`"${trimmed}" is reserved (it spells an anonymous session)`);
  if (trimmed === "." || trimmed === ".." || !SESSION_ID.test(trimmed)) {
    throw new Error(`invalid session name "${trimmed}" — 1–64 characters, no whitespace, no path separators`);
  }
  return trimmed;
}

/** The metadata record a session file opens with. `agent` is the
 *  session-owned AGENT SETTINGS snapshot (see the settings setter):
 *  resume restores them with the context. */
function metadataRecord(id, origin, created, uuid, name, agent) {
  return { type: METADATA_TYPE, version: METADATA_VERSION, id, uuid, name, cwd: origin, created, ...(agent ? { agent } : {}) };
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
function findSessionFile(folder, id) {
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
function readSessionMetadata(file) {
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

/**
 * Parse the first line of a session file as metadata.
 * @param {string} text - file text or a first-line snippet
 * @returns {object|null} parsed metadata when its type marker matches; otherwise null
 */
function parseSessionMetadata(text) {
  try {
    const parsed = JSON.parse(text.split("\n", 1)[0]);
    return parsed?.type === METADATA_TYPE ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Asynchronously read and parse the first 4 KiB of a session file.
 * Read/open/parse failures produce null; the handle is closed in all cases.
 * @param {string} file - session file path
 * @returns {Promise<object|null>} parsed metadata, or null when unreadable/invalid
 */
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

/**
 * Compare folder paths by real path when available, otherwise resolved path.
 * @param {string} a - first folder
 * @param {string} b - second folder
 * @returns {boolean} whether both paths identify the same folder
 */
function sameFolder(a, b) {
  const identity = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return identity(a) === identity(b);
}

const TEXT_TOKEN = '"text":"';
const PREVIEW_CAPTURE = 2048;
const SCAN_CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

/** Leading list/quote/heading/checkbox markers of a markdown line. */
const LINE_MARKERS = /^(?:#{1,6}\s+|>\s*|[-*+•]\s+|\d{1,3}[.)]\s+|\[[ xX]\]\s+)+/;
/** A leading courtesy sentence ("Please fix the following:", "Hi!"). */
const COURTESY = /^(?:please|hi|hello|hey|thanks|thank you)\b[^.!?:]*(?:[.!?:]+\s*|$)/i;
/** A line with nothing to say: a lone tag or a horizontal rule. */
const NOISE_LINE = /^(?:<\/?[A-Za-z][^>]*>|[-=*_]{3,})$/;

/**
 * The first MEANINGFUL line of a message (the session preview): code
 * fences, lone tags, rules and blank lines are skipped; list, quote and
 * heading markers are stripped (a bulleted request previews as its first
 * item); leading courtesy sentences ("Please …", "Hi!") are dropped and
 * an intro line ending in ":" defers to what it introduces. With nothing
 * meaningful left, the first non-empty line stands. Line-at-a-time over
 * a bounded snippet: cheap enough for a listing loop.
 * @param {string} text
 * @returns {string}
 */
function meaningfulLine(text) {
  let fallback = "";
  let fenced = false;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    let line = text.slice(start, end).trim();
    start = end + 1;
    if (line.startsWith("```") || line.startsWith("~~~")) { fenced = !fenced; continue; }
    if (fenced || line === "") continue;
    line = line.replace(LINE_MARKERS, "");
    if (line === "" || NOISE_LINE.test(line)) continue;
    if (fallback === "") fallback = line;
    let match;
    while (line !== "" && (match = COURTESY.exec(line))) line = line.slice(match[0].length).trimStart();
    if (line !== "" && !line.endsWith(":")) return line;
  }
  return fallback;
}

/**
 * Extract a bounded display preview from a serialized User-message line:
 * the first text block's first meaningful line, JSON-unescaped. Malformed
 * or absent text returns an empty string; the snippet is capped at 72 chars.
 * @param {string} line - serialized message line
 * @returns {string} display preview
 */
function extractTextPreview(line) {
  const at = line.indexOf(TEXT_TOKEN);
  if (at < 0) return "";
  const window = line.slice(at + TEXT_TOKEN.length - 1);
  const match = /^"((?:[^"\\]|\\.)*)/.exec(window);
  if (!match) return "";
  let text;
  // the window may end inside an escape (\u12…): drop the torn tail
  try { text = JSON.parse(`${match[0].replace(/\\u[0-9a-fA-F]{0,3}$/, "")}"`); } catch { return ""; }
  text = meaningfulLine(text).replace(/\s+/g, " ").trim();
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
    /**
     * Consume a byte chunk, updating line counts and the first User preview.
     * @param {Buffer} chunk - scanner input bytes
     * @returns {undefined}
     */
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
    /** @returns {{messages: number, preview: string}} accumulated count and preview */
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

/**
 * Shape one folder-scan hit for list()/listAsync; the metadata id is its
 * stable identity. Metadata-less files are not passed here.
 * @param {object} metadata - parsed session metadata
 * @param {string} name - directory entry name
 * @param {string} file - full file path
 * @param {number} mtime - modification time in milliseconds
 * @returns {object} normalized list entry, optionally including agent name
 */
function foundEntry(metadata, name, file, mtime) {
  const agent = listedAgentName(metadata.agent?.name);
  return { id: metadata.id, file, mtime, hasMetadata: true, ...(agent ? { agent } : {}) };
}

/**
 * Normalize an agent name for display, omitting empty and default agent-N names.
 * @param {*} name - stored agent name
 * @returns {string|undefined} displayable trimmed name
 */
function listedAgentName(name) {
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  return trimmed === "" || /^agent-\d+$/.test(trimmed) ? undefined : trimmed;
}

/** Compare list entries newest first by modification time.
 * @param {{mtime:number}} a - first entry
 * @param {{mtime:number}} b - second entry
 * @returns {number} sort comparator result
 */
const byMtimeDesc = (a, b) => b.mtime - a.mtime;

/** Newest first, ONE entry per session id (the id is the identity: a
 *  leftover second file of the same session never lists twice). */
function newestPerId(found) {
  found.sort(byMtimeDesc);
  const seen = new Set();
  return found.filter((entry) => !seen.has(entry.id) && seen.add(entry.id));
}

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

/**
 * The conversation context: an ordered message list (a private array —
 * read it through length/at/messages()/iteration, change it through the
 * methods below), optionally NAMED (`id`/`name`) and LOGGED to a
 * session file in `dir` (`save`). Crash safety is the owner's: an Agent
 * flushes its context from a process-finish hook.
 */
export class Context {
  /** @returns {string} Stable context identifier; use rename() to update logged identity. */
  id;
  /** @returns {string|undefined} Session logging directory. */
  dir;
  /** @returns {string} Persistent session UUID. */
  uuid;
  /** @returns {string|undefined} Stored or automatically derived session label. */
  name;
  /** @returns {string} Origin project folder recorded in metadata. */
  origin;
  /** @returns {string} Creation timestamp in ISO form. */
  created;
  /** @returns {string|undefined} Backing session file, when a logging directory exists. */
  file;
  /**
   * Create a context, optionally named and logged (the file is created
   * on the first flush of a started conversation).
   * @param {Object} [options]
   * @param {string} [options.id] - session id (default: random UUID)
   * @param {string} [options.dir] - the sessions folder (env.settings.sessions);
   *   required to log
   * @param {Array} [options.messages] - initial messages, deep-copied into this context; no objects are shared with another context
   * @param {string} [options.origin] - the folder the session RUNS in
   *   (default: process.cwd()) — recorded in the file's metadata line;
   *   resume's scans list only sessions of the current folder
   * @param {string} [options.uuid] - carry an existing sessionUUID
   *   forward (Context.resume() only — a fresh session always
   *   gets a new one)
   * @param {string} [options.name] - carry an existing stored NAME
   *   forward (Context.resume() only — see the module doc)
   * @param {object} [options.settings] - the session-owned agent
   *   settings snapshot (Agent-managed; see the settings setter)
   * @param {boolean} [options.save] - whether the context is logged to
   *   disk (default: whenever a `dir` is given); false keeps it in memory
   */
  constructor({ id, dir, messages = [], origin, uuid, name, settings, save = dir !== undefined } = {}) {
    if (typeof save !== "boolean") throw new TypeError("Context: save must be a boolean");
    if (!Array.isArray(messages)) throw new TypeError("Context: messages must be an array");
    if (save) requireDir(dir, "constructor");
    this.id = id ?? randomUUID();
    this.dir = dir;
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
    this._settings = settings ?? adopted?.agent ?? undefined;
    this._fileFinalized = this.name !== undefined; // nothing left to auto-derive
    this.origin = origin ?? process.cwd();
    this.created = adopted?.created ?? new Date().toISOString();
    this._messages = structuredClone(messages);
    this.file = this.dir === undefined ? undefined : join(this.dir, `${fileStem(this)}.jsonl`);
    // _dirty: false | "append" (only pure tail appends since the last
    // flush) | "full" (anything else). _flushedCount: how many context
    // messages the file durably holds (-1: unknown/stale — the next
    // flush must rewrite). Both feed _planFlush()'s append fast-path.
    this._dirty = messages.length > 0 ? "full" : false; // seed content must reach disk
    this._flushedCount = -1;
    this._version = 0; // async flush clears dirty only for the snapshot it wrote
    this._flushSeq = 0;
    this._closed = false;
    if (this._save) mkdirSync(this.dir, { recursive: true });
  }

  /* ------------------------------------------------ reading */

  /** @returns {number} the message count */
  get length() {
    return this._messages.length;
  }

  /**
   * The message at index `i` (negative counts from the end).
   * @param {number} i
   * @returns {object|undefined}
   */
  at(i) {
    return this._messages.at(i);
  }

  /**
   * Block `j` of message `i` (RangeError when either index is out of range).
   * @param {number} i
   * @param {number} j
   * @returns {object}
   */
  blockAt(i, j) {
    return blockAt(this._messages, i, j);
  }

  /** @returns {object[]} A new array of LIVE message objects. Mutating a message changes this context only, without marking it dirty; use edit/update for persistence bookkeeping. Construction deep-copies seeds, so forks never share message objects. */
  messages() {
    return this._messages.slice();
  }

  /** Iterate the messages in order. */
  [Symbol.iterator]() {
    return this._messages[Symbol.iterator]();
  }

  /** JSON form: the message array. */
  toJSON() {
    return this.messages();
  }

  /* ------------------------------------------------ logging */

  /** @returns {boolean} whether this context is logged to disk */
  get save() {
    return this._save;
  }

  /** @returns {string} one line for status/command output:
   *  `<id> — <file>` while logging, `<id> — not logged (memory only)` otherwise */
  get summary() {
    return `${this.id} — ${this._save ? this.file : "not logged (memory only)"}`;
  }

  /** @returns {object|undefined} the owner's settings snapshot riding the
   *  session file (undefined: none recorded — resume keeps the caller's
   *  configuration) */
  get settings() {
    return this._settings;
  }

  /**
   * Record the owner's SETTINGS snapshot (an Agent's (safe, thinking,
   *   endpoint/model, name, … — Agent writes it; the store only persists
   *   it; a default `agent-N` name never rides the file). Only JSON-typed
   *   values ride the file; undefined entries are
   *   dropped. Marks the store dirty (the next flush is a FULL rewrite:
   *   the metadata line changes).
   * @param {object} value
   */
  set settings(value) {
    if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
      throw new TypeError("Context.settings: must be a plain object");
    }
    if (this._closed) throw new Error(`Context "${this.id}" is closed`);
    this._settings = value;
    this._mutate();
  }

  /**
   * Enable or disable persistence without replacing the live context. Enabling
   * saving makes the complete current context eligible for the next flush.
   * @param {boolean} value
   * @returns {void} Read save after assignment for the logging state.
   */
  set save(value) {
    if (typeof value !== "boolean") throw new TypeError("Context.save: value must be a boolean");
    if (value === this._save) return;
    if (value) requireDir(this.dir, "save");
    this._save = value;
    this._version++;
    if (value) {
      mkdirSync(this.dir, { recursive: true });
      this._dirty = this._messages.length > 0 ? "full" : false;
      this._flushedCount = -1;
    }
  }

  /**
   * Mark the context changed and invalidate append bookkeeping as needed.
   * @param {"full"|"append"} [kind="full"] - mutation durability class
   * @returns {void}
   * @throws {Error} if this context is closed
   */
  _mutate(kind = "full") {
    if (this._closed) throw new Error(`Context "${this.id}" is closed`);
    // "full" always wins; it also invalidates the durable-prefix ledger.
    this._dirty = this._dirty === "full" || kind === "full" ? "full" : "append";
    if (this._dirty === "full") this._flushedCount = -1;
    this._version++;
  }

  /* ------------------------------------------------ changing */

  /**
   * Append a message, MERGING with the last one when possible
   * (consecutive same-type messages / same-sub-type blocks fold —
   * Context.appendMessage); `{merge: false}` keeps a boundary.
   * @param {object} message
   * @param {{merge?: boolean}} [options]
   * @returns {object} the stored message
   */
  append(message, options) {
    const before = this._messages.at(-1);
    const stored = appendMessage(this._messages, message, options);
    // A merge REWRITES the last stored message (its file line changes) —
    // only a brand-new tail message keeps the append fast-path alive.
    this._mutate(before !== undefined && stored === before ? "full" : "append");
    return stored;
  }

  /**
   * Insert messages at the FRONT — e.g. an Agent's seeded system
   * prompt, always the first message(s) of a fresh context.
   * @param {object[]} messages
   */
  prepend(messages) {
    if (messages.length === 0) return;
    this._messages.unshift(...messages);
    this._mutate();
  }

  /**
   * Replace message `i` (rebuilt from recognized fields; stale provider
   * identifiers dropped).
   * @param {number} i
   * @param {object} message
   * @returns {object} the stored message
   */
  edit(i, message) {
    const clean = editMessage(this._messages, i, message);
    this._mutate();
    return clean;
  }

  /**
   * Replace block `j` of message `i` (the message is rebuilt).
   * @param {number} i
   * @param {number} j
   * @param {object} block
   * @returns {object} the stored block
   */
  editBlock(i, j, block) {
    const clean = editBlock(this._messages, i, j, block);
    this._mutate();
    return clean;
  }

  /**
   * Remove every message at index >= i (RangeError unless i is an
   * existing index).
   * @param {number} i
   * @returns {object[]} the removed messages
   */
  rollback(i) {
    const removed = rollbackTo(this._messages, i);
    if (removed.length > 0) this._mutate();
    return removed;
  }

  /** @returns {object|undefined} the removed last message */
  pop() {
    const removed = pop(this._messages);
    if (removed !== undefined) this._mutate();
    return removed;
  }

  /**
   * Retract a trailing FAILED RESPONSE before the context is submitted
   * again: an assistant message carrying `error` that is still the last
   * message was not responded to — the user continued as it stands — so
   * it goes and the request is re-attempted. Anything added after it (a
   * user reply) keeps it: then it is part of the conversation.
   * @returns {object|undefined} the removed message
   */
  errorPop() {
    const removed = popError(this._messages);
    if (removed !== undefined) this._mutate();
    return removed;
  }

  /**
   * Remove the messages at `indexes`.
   * @param {number[]} indexes
   * @returns {object[]} the removed messages
   */
  remove(indexes) {
    const removed = removeMessages(this._messages, indexes);
    this._mutate();
    return removed;
  }

  /**
   * A batch in-place change (a repair pass): `fn` receives the live
   * message array and returns true when it changed anything — the
   * context then logs a full rewrite. Stored messages are replaced,
   * never mutated.
   * @param {(messages: object[]) => boolean} fn
   * @returns {boolean} whether anything changed
   */
  update(fn) {
    const changed = fn(this._messages) === true;
    if (changed) this._mutate();
    return changed;
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
    const started = this._messages.some((m) => m?.type !== MessageType.System);
    if (this._messages.length === 0 || !started) return { kind: "remove" };
    if (!this._fileFinalized) {
      const derived = deriveNameFromContext(this._messages);
      if (derived !== undefined) {
        const previous = this.file;
        this.name = derived;
        this.file = join(this.dir, `${fileStem(this)}.jsonl`);
        this._fileFinalized = true;
        // An earlier flush (content, but nothing to name it by yet) wrote
        // the unnamed file: the next FULL write moves the session, and the
        // old file goes away with it — one session, one file.
        if (previous !== this.file && existsSync(previous)) {
          this._staleFile = previous;
          this._dirty = "full";
          this._flushedCount = -1;
        }
      }
    }
    if (!this._dirty) return { kind: "none" };
    if (this._dirty === "append" && this._flushedCount > 0 && existsSync(this.file)) {
      const body = this._messages.slice(this._flushedCount).map((m) => JSON.stringify(m)).join("\n") + "\n";
      return { kind: "append", file: this.file, body };
    }
    const body = [JSON.stringify(metadataRecord(this.id, this.origin, this.created, this.uuid, this.name, this._settings)),
      ...this._messages.map((m) => JSON.stringify(m))].join("\n") + "\n";
    return { kind: "full", file: this.file, body };
  }

  /**
   * Execute a flush plan synchronously, updating durable bookkeeping and files.
   * Filesystem failures propagate; full writes use a temporary file and rename.
   * @param {{kind:string, file?:string, body?:string}} plan - _planFlush result
   * @returns {void}
   */
  _commitSync(plan) {
    if (plan.kind === "none") return;
    if (plan.kind === "remove") {
      if (existsSync(this.file)) rmSync(this.file, { force: true });
      this._dropStaleFile();
      this._flushedCount = 0;
    } else if (plan.kind === "append") {
      writeFileSync(plan.file, plan.body, { flag: "a" });
      this._flushedCount = this._messages.length;
    } else {
      const tmp = `${plan.file}.tmp-${process.pid}`;
      writeFileSync(tmp, plan.body);
      renameSync(tmp, plan.file);
      this._dropStaleFile();
      this._flushedCount = this._messages.length;
    }
    this._dirty = false;
  }

  /** Remove the file a derived name moved this session away from (see
   *  _planFlush) once the new file holds the full context. */
  _dropStaleFile() {
    if (this._staleFile === undefined) return;
    rmSync(this._staleFile, { force: true });
    this._staleFile = undefined;
  }

  /**
   * Synchronously make the CURRENT context durable (see _planFlush for
   * the remove/none/append/full decision). Idempotent; a no-op when
   * nothing changed since the last flush. Filesystem errors propagate.
   * @returns {void}
   */
  flush() {
    this._commitSync(this._planFlush());
  }

  /**
   * Async counterpart for a live loop (Agent's request/tool turns); the
   * synchronous flush() remains the crash/exit contract.
   * "remove"/"append" plans are tiny and interleave-free, so they commit
   * synchronously; only a "full" rewrite yields, snapshotting one version
   * so a mutation while I/O is pending remains dirty for the following
   * flush rather than being lost. I/O errors reject the returned promise.
   * @returns {Promise<void>}
   */
  async flushAsync() {
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
      this._dropStaleFile();
      this._flushedCount = this._messages.length;
      this._dirty = false;
    } finally {
      // writeFile failures and stale snapshots leave no retry-confusing temp.
      if (existsSync(tmp)) await rm(tmp, { force: true });
    }
  }

  /**
   * Flush and close; subsequent mutations fail. Flush errors propagate and
   * leave the context open.
   * @returns {void}
   */
  close() {
    if (this._closed) return;
    this.flush();
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
    if (this._closed) throw new Error(`Context "${this.id}" is closed`);
    const id = validateSessionId(newId);
    const clash = this.dir === undefined ? undefined : findSessionFile(this.dir, id);
    if (clash !== undefined && clash !== this.file) {
      throw new Error(`a session named "${id}" already exists — pick another name`);
    }
    const oldFile = this.file;
    this.id = id;
    this.name = id;
    this._fileFinalized = true;
    this.file = this.dir === undefined ? undefined : join(this.dir, `${fileStem(this)}.jsonl`);
    if (oldFile !== undefined && oldFile !== this.file) rmSync(oldFile, { force: true }); // the old name's file goes away
    this._mutate(); // the metadata line's id/name rewrite on the next flush
    this.flush();
    return { id: this.id, file: this.file };
  }

  /**
   * The ORIGIN FOLDER recorded in a session file's metadata line (the
   * cwd the session ran in), or undefined (no such session). A
   * session resumes only in an Env of this folder; an explicit
   * --resume <id> makes it the process cwd before the Env is built.
   * @param {Object} options
   * @param {string} options.id
   * @param {string} [options.dir]
   * @returns {string|undefined}
   */
  static originOf({ id, dir } = {}) {
    const folder = requireDir(dir, "sessions");
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
   * @param {boolean} [options.save=true] - whether the resumed context keeps logging
   * @returns {Context} the loaded context
   */
  static resume({ id, dir, save = true } = {}) {
    const folder = requireDir(dir, "sessions");
    const file = findSessionFile(folder, id);
    if (file === undefined) {
      throw new Error(`Context.resume: no session "${id}" in ${folder}`);
    }
    const messages = loadMessages(readFileSync(file, "utf8"));
    const metadata = readSessionMetadata(file);
    const store = new Context({
      id, dir: folder, messages,
      uuid: metadata?.uuid, name: metadata?.name, save,
    });
    if (metadata?.cwd) store.origin = metadata.cwd;
    if (metadata?.created) store.created = metadata.created;
    if (metadata?.agent !== undefined) store._settings = metadata.agent;
    store.file = file; // PIN to the exact file loaded — never recompute/rename it implicitly
    store._fileFinalized = true; // a resumed file keeps its name; only an explicit rename touches it
    store._dirty = false; // the file already holds exactly this context
    store._flushedCount = messages.length; // appends resume the fast-path
    return store;
  }

  /**
   * Every session in the folder, LATEST FIRST (one entry per id), each
   * with a small preview: the first meaningful line of the first user
   * message (see meaningfulLine; whitespace-folded, capped) and `agent`,
   * the stored agent name when it is not a default `agent-N` one. With `cwd`, only sessions whose metadata records THAT
   * origin folder list (the resume contract: a project sees its own
   * sessions; foreign metadata-less files are skipped by
   * the FIRST-LINE scan, never parsed in full). Previews are read
   * only for the newest `limit` files (stats are cheap; parsing is
   * not). Unreadable files list without a preview, never an error.
   * @param {Object} [options]
   * @param {string} [options.dir]
   * @param {string} [options.cwd] - only sessions of THIS origin folder
   * @param {number} [options.limit] - max sessions returned (default 50)
   * @returns {Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>}
   */
  static list({ dir, cwd, limit = 50 } = {}) {
    const folder = requireDir(dir, "sessions");
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
    return newestPerId(found).slice(0, Math.max(1, limit)).map(previewEntrySync);
  }

  /**
   * Nonblocking counterpart of list(). It deliberately has its own async
   * folder identity rather than calling sameFolder(), whose realpathSync
   * would stall the interactive loop.
   * @returns {Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>>}
   */
  static async listAsync({ dir, cwd, limit = 50 } = {}) {
    const folder = requireDir(dir, "sessions");
    let names;
    try { names = await readdir(folder); } catch { sessionListCache.delete(folder); return []; }
    const cached = sessionListCache.get(folder);
    const previous = cached?.entries ?? new Map();
    const generation = (cached?.generation ?? 0) + 1;
    sessionListCache.set(folder, { generation, entries: previous });
    if (sessionListCache.size > 32) sessionListCache.delete(sessionListCache.keys().next().value);
    const current = new Map();
    const files = names.filter((name) => name.endsWith(".jsonl"));
    const entries = await Promise.all(files.map(async (name) => {
      const file = join(folder, name);
      try {
        const info = await stat(file);
        if (!info.isFile()) return null;
        const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const prior = previous.get(name);
        const metadata = prior?.stamp === stamp ? prior.metadata : await readSessionMetadataAsync(file);
        const entry = prior?.stamp === stamp ? { ...prior } : { stamp, metadata, preview: null, file, name, mtime: info.mtimeMs };
        current.set(name, entry);
        return entry;
      } catch { return null; }
    }));
    const identity = async (path) => {
      try { return await realpath(path); } catch { return resolve(path); }
    };
    const cwdIdentity = cwd === undefined ? undefined : await identity(cwd);
    const origins = new Map();
    const matches = await Promise.all(entries.filter((entry) => entry?.metadata).map(async (entry) => {
      const origin = entry.metadata.cwd;
      if (cwdIdentity !== undefined) {
        if (!origin) return null;
        if (!origins.has(origin)) origins.set(origin, identity(origin));
        if (await origins.get(origin) !== cwdIdentity) return null;
      }
      return entry;
    }));
    const selected = newestPerId(matches.filter(Boolean).map((entry) => foundEntry(entry.metadata, entry.name, entry.file, entry.mtime))).slice(0, Math.max(1, limit));
    const result = await Promise.all(selected.map(async (item) => {
      const entry = current.get(item.file.slice(folder.length + 1));
      if (!entry?.preview) {
        const preview = await previewEntry(item);
        if (entry) entry.preview = preview;
        return preview;
      }
      return { ...entry.preview };
    }));
    if (sessionListCache.get(folder)?.generation === generation) sessionListCache.set(folder, { generation, entries: current });
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
    return Context.list({ dir, cwd, limit: 1 })[0]?.id;
  }

  /**
   * Rename a STORED session by id (the sidebar/menu path for a session
   * no store holds open — a live one renames through its store): loads
   * it, renames it (see rename()) and closes it again.
   * @param {Object} options
   * @param {string} options.id
   * @param {string} options.name - the new id/name
   * @param {string} [options.dir]
   * @returns {{id: string, file: string}}
   * @throws {Error} when no such session exists or the name is taken
   */
  static renameById({ id, name, dir } = {}) {
    const store = Context.resume({ id, dir });
    try {
      return store.rename(name);
    } finally {
      store.close();
    }
  }

  /**
   * Permanently delete a STORED session by id: every session file whose
   * metadata carries that id (a leftover duplicate goes with it). A store
   * still holding it open would re-persist it — close it first.
   * @param {Object} options
   * @param {string} options.id
   * @param {string} [options.dir]
   * @returns {{deleted: number}}
   */
  static deleteById({ id, dir } = {}) {
    const folder = requireDir(dir, "sessions");
    if (!existsSync(folder)) return { deleted: 0 };
    let deleted = 0;
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(folder, name);
      if (readSessionMetadata(file)?.id !== id) continue;
      rmSync(file, { force: true });
      deleted++;
    }
    return { deleted };
  }

  /**
   * Delete EVERY session file in the folder (the /sessions-delete-all!
   * contract — the user confirmed; foreign files stay untouched).
   * @param {Object} [options]
   * @param {string} [options.dir]
   * @returns {{deleted: number}}
   */
  static deleteAll({ dir } = {}) {
    const folder = requireDir(dir, "sessions");
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

  /**
   * The session file holding `id` in `dir` (a metadata-line scan), or
   * undefined.
   * @param {{id: string, dir: string}} options
   * @returns {string|undefined}
   */
  static fileOf({ id, dir } = {}) {
    return findSessionFile(requireDir(dir, "fileOf"), id);
  }

  /**
   * Does `id` spell an ANONYMOUS (memory-only, never logged) context:
   * false, "0", "false" or "anon"?
   * @param {*} id
   * @returns {boolean}
   */
  static idAnonymous(id) {
    return isAnonymousId(id);
  }
}
