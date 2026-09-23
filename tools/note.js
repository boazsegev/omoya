/**
 * tools/note.js — the NOTE tool: short-term memory for the agent.
 * A note is a small JSON object the model shapes freely, keyed by its
 * `title` (the store's KEY — the only required field). Three fields
 * are the suggested CONVENTION, never mandatory:
 *   type     todo / active / done / info / secret — drives the
 *            badge emoji on the TUI's sticky display (secret notes
 *            never display) and the note-list badges (the recommended
 *            convention — one name per badge; common aliases like
 *            pending/task, working/focus, finished/complete and note
 *            stay accepted; an unrecognized type displays a fallback)
 *   summary  the one-line gist (note-get {only:["summary"]} reads it
 *            back cheaply)
 *   content  the full note (note-get's default field)
 * Any other field the model wants rides along (owners, deadlines,
 * flags) — the note is a JSON store, capped per note.
 *
 * The calls (all INTERACTIVE — they operate on the calling agent's
 * live context through the harness tool context `{agent, env}`,
 * never in the forked sandbox):
 *   note-set       merge fields into a note ({title, ...fields}, or
 *                  several at once as {notes: [{title, ...fields}]});
 *                  a null value DELETES that field — `type` merges
 *                  like any other field, so changing a note's type
 *                  never touches its content)
 *   note-done      shortcut: {notes: [title, ...]} sets each note's
 *                  type to "done" (replays as a targeted type-set —
 *                  content untouched)
 *   note-remove    delete a note by title ("*" deletes EVERY note)
 *   note-get       read a note: {title, only?, keys?} — `only` is the
 *                  field list (default ["content"], ["*"] every field),
 *                  `keys:true` returns just the selected field names
 *                  that exist; one field returns its raw value,
 *                  several a JSON object
 *   note-list      list every OPEN note (type badge + title) — DONE
 *                  notes are hidden here (a footer counts them) but
 *                  stay reachable via note-get/note-search
 *   note-search    REGEX search over the title and every field
 *                  (reaches DONE notes too)
 *
 * THE STORE IS OWNED BY THE CONTEXT, never by this module: there is
 * no side state. Every call DERIVES the current notes by scanning the
 * agent's context — a `note-store` metadata RECORD (string `type`,
 * never sent to the model — IO filters records from every request)
 * is the BASELINE, and the context's own successful note calls
 * replay ON TOP of it (a set merges its fields — one note or several
 * — a done marks type "done", a LEGACY type-set re-types, a remove
 * deletes; calls that failed or were never answered apply nothing).
 * Consequences, all intended:
 *   - a context edit/rollback that drops a call drops its effect
 *     (the memory is as honest as the record; deliberate edits win);
 *   - an EMPTY context (no numeric-`type` message — a fresh session
 *     that hasn't even seeded its system prompt yet) RESETS the store:
 *     the backup belongs to the context that was abandoned, so it is
 *     dropped instead of restored;
 *   - COMPACTION can no longer lose the store: every call also
 *     replaces the note tool's `context.storage.backup` ({owner, notes} — the rebuilt
 *     object). When a rebuild comes back EMPTY while the backup
 *     (same context — the owner guard keeps notes from leaking into
 *     a new/resumed session) holds notes, the calls were compacted
 *     away: the tool RESTORES by appending a fresh `note-store`
 *     record holding the backup, and the store becomes the new
 *     baseline. The record persists in the session file (the JSONL
 *     flush carries records; the tolerant loader re-loads them) but
 *     is never provider-bound. The backup trails the record by at
 *     most the in-flight call (a call can't count itself); the next
 *     note call refreshes it;
 *   - re-asking is always fresh: two identical searches can answer
 *     differently once a later call changed the record;
 *   - the tool itself is read-only over the world — its only
 *     "writes" are its calls and the restore record joining the
 *     context like any other entry.
 *
 * THE STICKY DISPLAY: every call also refreshes the agent's sticky
 * tool MESSAGE (Agent.updateToolMessage — agent-owned, the TUI
 * collects it from the viewed agent): every non-secret note, one line
 * each, the type's badge emoji heading the bold title with its
 * summary trailing when set — DONE notes trail every open one (still
 * published, just last: the TUI's own per-tool line cap discards
 * overflow — lib/tui-helpers/view-rows.js infoLines — so the most
 * actionable notes are the ones that survive it). A live side effect
 * of note-set/note-done, unentangled from the model-facing reply (the
 * same pattern as a newly created session appearing in the TUI).
 */

import Context from "../lib/context.js";
const { MessageType, ContentType } = Context;

const MAX_TITLE = 160;
const MAX_FIELD = 64; // a field name
const MAX_FIELDS = 32; // fields per note
const MAX_NOTE = 4096; // one note's JSON, serialized
const MAX_NOTES = 100;
const MAX_MATCHES = 50;
const MAX_BATCH = 20; // notes per note-set/note-done call
const MAX_EXTRA = 48; // a sticky line's trailing summary snippet

/** The note types and their badge emojis (secret never displays on
 *  the sticky area). The RECOMMENDED set is the ONE name per badge the
 *  schema publishes as the convention; the aliases stay accepted so
 *  existing notes keep working. An unrecognized type displays the
 *  📂 fallback. */
const TYPES = {
  done: "✅", finished: "✅", complete: "✅",
  info: "📂", note: "📂",
  todo: "🔵", pending: "🔵", task: "🔵",
  active: "🟠", working: "🟠", "in-flight": "🟠", focus: "🟠", "in-focus": "🟠",
  secret: "🔒",
};
const TYPE_NAMES = Object.keys(TYPES); // every ACCEPTED type (recommended + aliases)
const RECOMMENDED_TYPES = ["todo", "active", "done", "info", "secret"]; // one name per badge — the published convention
const TYPE_FALLBACK = "📂"; // an unrecognized type's badge

/** The metadata RECORD type holding the compaction-surviving baseline. */
const RECORD_TYPE = "note-store";

/** The calling agent from the harness tool context. */
function anchor(context) {
  const agent = context?.agent;
  if (!agent) throw new Error("note: no calling agent in this binding");
  return agent;
}

/** A tool call's arguments as an object (arguments may arrive as JSON text). */
function parseArgs(raw) {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Merge one call's fields into a note: null deletes, the rest set. */
function mergeFields(note, fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (value === null) delete note[name];
    else note[name] = value;
  }
  return note;
}

/**
 * Derive the CURRENT note store: the `note-store` record(s) form the
 * BASELINE (compaction survivors), the context's successful
 * note-set/note-done/note-type-set/note-remove calls replay ON TOP in
 * record order (unanswered and failed calls apply nothing — the
 * in-flight call itself is always excluded; note-set/note-done each
 * carry ONE OR MANY titles). Then the BACKUP contract: the rebuilt
 * object always replaces `context.storage.backup` ({owner, notes}); an
 * EMPTY rebuild with a non-empty same-context backup means the calls
 * were compacted/edited away — RESTORE by appending a fresh record
 * holding the backup (it persists with the session, never reaches the
 * model) and resolving to it. Finally the agent's sticky message
 * refreshes (non-secret, non-done titles).
 * @param {object} agent
 * @returns {Map<string, object>}
 */
function notesFrom(agent, storage = agent.toolStorage?.("note") ?? {}) {
  const context = agent.context;
  const notes = new Map();
  // the BASELINE: metadata records (later ones override — at most one
  // exists by construction: a restore fires only when the rebuild is
  // empty, which a non-empty baseline prevents)
  for (const entry of context) {
    if (entry?.type !== RECORD_TYPE) continue;
    const data = entry.notes;
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    for (const [title, note] of Object.entries(data)) {
      if (note === null || typeof note !== "object" || Array.isArray(note)) continue;
      notes.set(title, { ...note });
    }
  }
  const failed = new Set();
  const answered = new Set();
  for (const message of context) {
    if (message?.type === MessageType.ToolResult && message.callId !== undefined) {
      answered.add(message.callId);
      if (message.error === true) failed.add(message.callId);
    }
  }
  for (const message of context) {
    for (const block of message?.content ?? []) {
      if (block?.type !== ContentType.ToolCall) continue;
      if (!["note-set", "note-done", "note-type-set", "note-remove"].includes(block.name)) continue;
      if (!answered.has(block.callId) || failed.has(block.callId)) continue;
      const args = parseArgs(block.arguments);
      if (args === null) continue;
      if (block.name === "note-remove") {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (title === "") continue;
        if (title === "*") notes.clear(); // the all-notes removal
        else notes.delete(title);
      } else if (block.name === "note-type-set") {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const note = notes.get(title);
        if (note && typeof args.type === "string") note.type = args.type;
      } else if (block.name === "note-done") {
        for (const raw of Array.isArray(args.notes) ? args.notes : []) {
          const title = typeof raw === "string" ? raw.trim() : "";
          const note = notes.get(title);
          if (note) note.type = "done";
        }
      } else {
        // note-set: one note ({title, ...fields}) or several ({notes: [{title, ...fields}]})
        for (const item of Array.isArray(args.notes) ? args.notes : [args]) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
          const title = typeof item.title === "string" ? item.title.trim() : "";
          if (title === "") continue;
          const { title: _key, ...fields } = item;
          mergeFields(notes.get(title) ?? notes.set(title, {}).get(title), fields);
        }
      }
    }
  }
  // the BACKUP: the rebuilt object always replaces the note tool storage;
  // restore fires only for the SAME context (the owner guard — a
  // new/resumed/forked session gets a fresh array and starts clean)
  const box = storage;
  const backup = box.backup;
  // the EMPTY-CONTEXT reset: a context without a single numeric-type
  // message is a NEW session's (or a fully rolled-back one) — the old
  // backup belongs to the abandoned context, so it DROPS instead of
  // restoring (notes never leak across a /session-new)
  if (!context.some((entry) => typeof entry?.type === "number")) {
    notes.clear();
    box.backup = { owner: context, notes };
    publish(agent, notes);
    return notes;
  }
  if (notes.size === 0 && backup?.owner === context && backup.notes?.size > 0) {
    const record = { type: RECORD_TYPE, notes: Object.fromEntries(backup.notes) };
    if (typeof agent.append === "function") agent.append(record); // joins the context, persists with the session
    else context.push(record); // a bare context (tests): same effect, no session
    for (const [title, note] of backup.notes) notes.set(title, note);
  }
  box.backup = { owner: context, notes };
  publish(agent, notes); // the sticky display follows the store
  return notes;
}

/** The type's badge prefix ("" when untyped; the 📂 fallback for an
 *  unrecognized type). */
function badge(type) {
  if (typeof type !== "string" || type === "") return "";
  return `${TYPES[type] ?? TYPE_FALLBACK} `;
}

/** Trim a snippet for a single display line. */
function clip(text, max = MAX_EXTRA) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Refresh the agent's sticky tool message: every note but SECRET ones
 * (never shown), one line each — the type badge heading the bold
 * title, the summary trailing when present (the TUI renders the
 * information area's markdown). DONE notes trail every open one (the
 * most actionable notes stay first when the TUI's own per-tool line
 * cap discards overflow — lib/tui-helpers/view-rows.js infoLines —
 * this tool no longer truncates its own message; the display decides
 * how many lines actually fit). An empty result clears the message.
 */
function publish(agent, notes) {
  if (typeof agent.updateToolMessage !== "function") return; // a bare context (tests)
  const visible = [...notes.entries()].filter(([, note]) => note.type !== "secret");
  if (visible.length === 0) {
    agent.updateToolMessage("note", null);
    return;
  }
  const open = visible.filter(([, note]) => note.type !== "done");
  const done = visible.filter(([, note]) => note.type === "done");
  const lines = [...open, ...done].map(([title, note]) => {
    const summary = typeof note.summary === "string" ? note.summary.trim() : "";
    return `${badge(note.type)}**${title}**${summary ? ` — ${clip(summary)}` : ""}`;
  });
  agent.updateToolMessage("note", lines.join("\n"));
}

/** Validate the title; returns the trimmed key. */
function titleField(value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`note: "title" is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`note: "title" must be a string`);
  const v = value.trim();
  if (required && v === "") throw new Error(`note: "title" must not be empty`);
  if (v.length > MAX_TITLE) throw new Error(`note: "title" is ${v.length} chars — the cap is ${MAX_TITLE}`);
  return v;
}

/** Validate a note type (accepted: the recommended names + their
 *  aliases; the error lists only the recommended convention). */
function typeField(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`note: "type" is required (${RECOMMENDED_TYPES.join(", ")})`);
    return undefined;
  }
  if (!TYPE_NAMES.includes(value)) throw new Error(`note: "type" must be one of ${RECOMMENDED_TYPES.join(", ")}`);
  return value;
}

/** Validate a note-set's extra fields (any JSON, bounded). */
function fieldsCheck(note) {
  const names = Object.keys(note);
  if (names.length > MAX_FIELDS) throw new Error(`note: ${names.length} fields — the cap is ${MAX_FIELDS} per note`);
  for (const name of names) {
    if (name.length > MAX_FIELD) throw new Error(`note: a field name is ${name.length} chars — the cap is ${MAX_FIELD}`);
  }
  const size = JSON.stringify(note).length;
  if (size > MAX_NOTE) throw new Error(`note: the note is ${size} chars serialized — the cap is ${MAX_NOTE} (short memory; keep it brief)`);
}

/** The known titles, capped (error messages). */
function known(notes) {
  if (notes.size === 0) return " — the store is empty";
  const titles = [...notes.keys()];
  const head = titles.slice(0, 5).join(", ");
  return ` (notes: ${head}${titles.length > 5 ? `, … +${titles.length - 5} more` : ""})`;
}

/** Look a note up by title or throw. */
function lookup(agent, title, storage) {
  const key = titleField(title);
  const notes = notesFrom(agent, storage);
  const note = notes.get(key);
  if (note === undefined) throw new Error(`note: no note "${key}"${known(notes)}`);
  return { key, note };
}

/**
 * Merge fields into one note (create when absent) or several at once.
 * One note: {title, ...fields}. Several: {notes: [{title, ...fields}]}.
 * Every other argument is a stored field — a null value DELETES the
 * field. `type` validates against the five known types. Nothing here
 * mutates the store directly — this call joining the context is the
 * write; the return is a validated preview of it.
 */
function set(args = {}, context) {
  const agent = anchor(context);
  const items = Array.isArray(args.notes) ? args.notes : [args];
  if (items.length === 0) throw new Error('note-set: at least one note is required ("title", or "notes" for several)');
  if (items.length > MAX_BATCH) throw new Error(`note-set: ${items.length} notes in one call — the cap is ${MAX_BATCH}`);
  const sim = new Map(notesFrom(agent, context.storage)); // a working copy for validation only
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("note-set: each note must be an object with a title");
    }
    const { title, type, ...fields } = item;
    const key = titleField(title);
    if (type !== undefined && type !== null) typeField(type);
    if (!sim.has(key) && sim.size >= MAX_NOTES) {
      throw new Error(`note-set: the store is full (${MAX_NOTES}/${MAX_NOTES}) — note-remove old notes first`);
    }
    const merged = mergeFields({ ...(sim.get(key) ?? {}) }, { ...(type !== undefined ? { type } : {}), ...fields });
    fieldsCheck(merged);
    sim.set(key, merged);
  }
  return items.length === 1 ? "saved to temporary short memory" : `saved ${items.length} notes to temporary short memory`;
}

/**
 * Shortcut: set type "done" on one or more existing notes ({notes:
 * [title, ...]}) — the rest of each note is untouched. Every title
 * must already exist (this call validates before it can join the
 * context; a partial batch never applies).
 */
function done({ notes: titles } = {}, context) {
  const agent = anchor(context);
  if (!Array.isArray(titles) || titles.length === 0) {
    throw new Error('note-done: "notes" is required — an array of titles to mark done');
  }
  if (titles.length > MAX_BATCH) throw new Error(`note-done: ${titles.length} titles — the cap is ${MAX_BATCH}`);
  const notes = notesFrom(agent, context.storage);
  const keys = titles.map((t) => titleField(t));
  for (const key of keys) {
    if (!notes.has(key)) throw new Error(`note-done: no note "${key}"${known(notes)}`);
  }
  return keys.length === 1 ? "marked done" : `marked ${keys.length} notes done`;
}

/** Delete a note by title — "*" deletes EVERY note. The deletion
 *  itself is this call joining the context (the derive replays it). */
function remove({ title } = {}, context) {
  const agent = anchor(context);
  const key = titleField(title);
  if (key === "*") {
    const count = notesFrom(agent, context.storage).size;
    return count === 0
      ? "no notes to remove"
      : `removed all ${count} note${count === 1 ? "" : "s"} from temporary short memory`;
  }
  lookup(agent, key, context.storage); // throws when absent
  return "removed from temporary short memory";
}

/** One field's display value: strings raw, anything else JSON. */
function raw(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Read a note: the field selector is `only` (a field list — default
 * ["content"], ["*"] every field); `keys: true` returns just the
 * field NAMES of the selection that actually exist (an existence
 * test — `only` + `keys` filters the returned names to the select
 * group). One field returns its raw value; several return a compact
 * JSON object (absent fields omit).
 */
function get({ title, only, keys } = {}, context) {
  const { key, note } = lookup(anchor(context), title, context.storage);
  if (only !== undefined && (!Array.isArray(only) || only.some((f) => typeof f !== "string" || f === ""))) {
    throw new Error('note-get: "only" must be an array of field names (["*"] reads every field)');
  }
  const fields = only === undefined || only.length === 0 ? (keys === true ? Object.keys(note) : ["content"])
    : only.includes("*") ? Object.keys(note)
    : only;
  if (keys === true) return JSON.stringify(fields.filter((f) => f === "title" || note[f] !== undefined));
  if (fields.length === 1) {
    const [name] = fields;
    if (name === "title") return key;
    return note[name] === undefined ? `(no ${name})` : raw(note[name]);
  }
  const out = {};
  for (const name of fields) {
    if (name === "title") out.title = key;
    else if (note[name] !== undefined) out[name] = note[name];
  }
  return `# ${key}\n${JSON.stringify(out)}`;
}

/** List every OPEN note (type badge + title) — DONE notes are hidden
 *  here (a footer counts them) but stay reachable via note-get/note-search. */
function list(_args = {}, context) {
  const agent = anchor(context);
  const notes = notesFrom(agent, context.storage);
  const shown = [...notes.entries()].filter(([, note]) => note.type !== "done");
  const done = notes.size - shown.length;
  if (shown.length === 0) {
    return done > 0 ? `No open notes (+${done} done).` : "No notes.";
  }
  const lines = shown.map(([title, note]) => `- ${badge(note.type)}${title}`);
  return `${shown.length} note${shown.length === 1 ? "" : "s"}:\n${lines.join("\n")}${done > 0 ? `\n(+${done} done)` : ""}`;
}

/** Regex-search the title and every field (non-string values search their JSON). */
function search({ pattern, field: only, max = 20 } = {}, context) {
  const agent = anchor(context);
  if (typeof pattern !== "string" || pattern.trim() === "") {
    throw new Error('note-search: "pattern" is required (a regular expression, case-insensitive)');
  }
  if (only !== undefined && (typeof only !== "string" || only === "")) {
    throw new Error('note-search: "field" must be a field name ("title" or any stored field)');
  }
  let rx;
  try {
    rx = new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(`note-search: invalid regular expression — ${err.message}`);
  }
  const cap = Math.max(1, Math.min(MAX_MATCHES, Number(max) || 20));
  const notes = notesFrom(agent, context.storage);
  const hits = [];
  for (const [title, note] of notes) {
    const candidates = only === "title" || only === undefined ? [["title", title]] : [];
    if (only === undefined) {
      for (const [name, value] of Object.entries(note)) candidates.push([name, value]);
    } else if (only !== "title" && note[only] !== undefined) {
      candidates.push([only, note[only]]);
    }
    const fields = candidates
      .filter(([, value]) => rx.test(typeof value === "string" ? value : JSON.stringify(value) ?? ""))
      .map(([name]) => name);
    if (fields.length > 0) hits.push({ title, note, fields });
  }
  if (hits.length === 0) {
    return `No notes match /${pattern}/${only !== undefined ? ` in ${only}` : ""}.`;
  }
  const shown = hits.slice(0, cap);
  const body = shown.map(({ title, fields }) => `- ${title} (matched: ${fields.join(", ")})`).join("\n");
  return `${hits.length > cap ? `${cap} of ${hits.length} matches` : `${shown.length} match(es)`} for /${pattern}/:\n${body}`;
}

export {
  set as "note-set",
  done as "note-done",
  remove as "note-remove",
  get as "note-get",
  list as "note-list",
  search as "note-search",
};

const TITLE = { type: "string", description: "The note's title (its key)." };
const TYPE = { type: "string", enum: RECOMMENDED_TYPES, description: "todo / active / done / info / secret (secret is hidden from the on-screen display)." };
const NOTE_ITEM = {
  type: "object",
  properties: { title: TITLE, type: TYPE, summary: { type: "string" }, content: { type: "string" } },
  additionalProperties: true,
  required: ["title"],
};

export function toolDescription() {
  return {
    "note-set": {
      safe: true,
      // Session startup/resume needs the same context-derived sticky state
      // before any new note call occurs; the detector is harness-only.
      storage: "note",
      detect: ({ agent }) => notesFrom(agent, agent.toolStorage("note")),
      description: "Create or update scratchpad notes; set one note or a batch.",
      inputSchema: {
        type: "object",
        properties: {
          ...NOTE_ITEM.properties,
          notes: { type: "array", items: NOTE_ITEM, description: "Set several notes in one call instead of the top-level fields." },
        },
        additionalProperties: true,
      },
    },
    "note-done": {
      safe: true, storage: "note",
      description: "Mark notes done without changing their content.",
      inputSchema: {
        type: "object",
        properties: { notes: { type: "array", items: { type: "string" }, description: "Titles to mark done." } },
        required: ["notes"],
      },
    },
    "note-remove": {
      safe: true, storage: "note",
      description: "Delete a note by title — \"*\" deletes every note.",
      inputSchema: { type: "object", properties: { title: { ...TITLE, description: "The note's title — \"*\" removes every note." } }, required: ["title"] },
    },
    "note-get": {
      safe: true, storage: "note",
      description: "Read selected note fields; request keys only when needed.",
      inputSchema: {
        type: "object",
        properties: {
          title: TITLE,
          only: {
            type: "array", items: { type: "string" },
            description: "The fields to read (default [\"content\"]; [\"*\"] reads every field).",
          },
          keys: { type: "boolean", description: "Return just the selected field names that exist." },
        },
        required: ["title"],
      },
    },
    "note-list": {
      safe: true, storage: "note",
      description: "List open note titles and types.",
      inputSchema: { type: "object", properties: {} },
    },
    "note-search": {
      safe: true, storage: "note",
      description: "Case-insensitively regex-search note titles and fields.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "A regular expression (case-insensitive)." },
          field: { type: "string", description: "Limit the search to one field (default: the title and all fields)." },
          max: { type: "number", description: "Maximum matches to return (default 20, cap 50)." },
        },
        required: ["pattern"],
      },
    },
  };
}
