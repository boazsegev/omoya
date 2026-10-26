/**
 * tools/note.js — the NOTE tools: short-term memory for the agent.
 * Three tools share `storage: "note"` (one storage box, one published
 * sticky message):
 *   note-list  {}                       every title with its type badge
 *   note-read  { titles? }              full notes (omit titles for all)
 *   note-write { notes: {title: patch} } merge-patch (RFC 7386) upsert;
 *              a null field deletes it, a null patch deletes the note
 *
 * A note is a small JSON object the model shapes freely, keyed by its
 * title (the store's KEY — never a payload field). Suggested fields:
 *   type     todo / active / done / info — drives the badge emoji
 *            (common aliases accepted; unknown types get a fallback)
 *   summary  the one-line gist
 *   content  the full note
 *
 * THE STORE IS OWNED BY THE CONTEXT, never by this module: there is
 * no side state. Every call DERIVES the current notes by scanning the
 * agent's context — a `note-store` metadata RECORD (string `type`,
 * never sent to the model — IO filters records from every request)
 * is the BASELINE, and the context's own successful note calls
 * replay ON TOP of it (each note-write merges its patches;
 * calls that failed or were never answered apply nothing).
 * Consequences, all intended:
 *   - a context edit/rollback that drops a call drops its effect
 *     (the memory is as honest as the record; deliberate edits win);
 *   - an EMPTY context (no numeric-`type` message — a fresh session
 *     that hasn't even seeded its system prompt yet) RESETS the store:
 *     the backup belongs to the context that was abandoned, so it is
 *     dropped instead of restored;
 *   - COMPACTION can no longer lose the store: every note-write call
 *     also PERSISTS the post-call snapshot as a `note-store` record
 *     (the note tool's storage carries the LAST one this process
 *     wrote — same context only — and the derivation PREFERS a fresh
 *     snapshot over the record's own replay; a resumed process's
 *     derivation can only equal the snapshot or roll calls BACK, so
 *     the preference is always safe). The records persist in the
 *     session file (the JSONL flush carries records; the tolerant
 *     loader re-loads them) but are never provider-bound — the LAST
 *     one wins. No restore machinery, no resurrection: a delete of
 *     the last note persists as an empty snapshot and stays deleted;
 *   - re-asking is always fresh: two identical reads can answer
 *     differently once a later call changed the record;
 *   - the tool itself is read-only over the world — its only
 *     "writes" are its calls and their snapshot records joining the
 *     context like any other entry.
 *
 * THE STICKY DISPLAY: every call also refreshes the agent's sticky
 * tool MESSAGE (context.messageSet — agent-local, the TUI
 * collects it from the viewed agent): every note, one line
 * each, the type's badge emoji heading the bold title with its
 * summary trailing when set — DONE notes trail every open one (still
 * published, just last: the TUI's own per-tool line cap discards
 * overflow — lib/app/tui/information-data.js's MAX_TOOL_ROWS cap —
 * so the most actionable notes are the ones that survive it). A live
 * side effect of note-write, unentangled from the model-facing reply
 * (the same pattern as a newly created session appearing in the TUI).
 */

import Context from "../lib/context.js";
const { MessageType, ContentType } = Context;

const MAX_TITLE = 160;
const MAX_FIELD = 64; // a field name
const MAX_FIELDS = 32; // fields per note
const MAX_NOTE = 4096; // one note's JSON, serialized
const MAX_NOTES = 100;
const MAX_BATCH = 20; // notes per note-write call
const MAX_EXTRA = 48; // a sticky line's trailing summary snippet

/** The note types and their badge emojis. The RECOMMENDED set is the
 *  ONE name per badge the schema publishes as the convention; the
 *  aliases stay accepted so existing notes keep working. An
 *  unrecognized type displays the 📂 fallback. */
const TYPES = {
  done: "✅", finished: "✅", complete: "✅",
  info: "📂", note: "📂",
  todo: "🔵", pending: "🔵", task: "🔵",
  active: "🟠", working: "🟠", "in-flight": "🟠", focus: "🟠", "in-focus": "🟠",
};
const TYPE_FALLBACK = "📂"; // an unrecognized type's badge

/** The metadata RECORD type holding the compaction-surviving baseline. */
const RECORD_TYPE = "note-store";

/** The calling agent from the harness tool context. */
function anchor(context) {
  const agent = context?.agent;
  if (!agent) throw new Error("note: unavailable without a calling agent");
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

/** Merge-patch (RFC 7386): objects merge recursively, arrays/scalars
 *  replace wholesale, a null value deletes the field. */
function mergeFields(note, patch) {
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete note[name];
    else if (
      typeof value === "object" && !Array.isArray(value) &&
      typeof note[name] === "object" && note[name] !== null && !Array.isArray(note[name])
    ) {
      mergeFields(note[name], value);
    } else note[name] = value;
  }
  return note;
}

/** Apply one successful `note-write` call's arguments to the store. */
function applyNoteCall(notes, args) {
  const map = notesArg(args.notes);
  if (map === null || typeof map !== "object" || Array.isArray(map)) return;
  for (const [title, patch] of Object.entries(map)) {
    const key = title.trim();
    if (key === "") continue;
    if (patch === null) notes.delete(key);
    else if (typeof patch === "object" && !Array.isArray(patch)) {
      mergeFields(notes.get(key) ?? notes.set(key, {}).get(key), patch);
    }
  }
}

/** An argument that arrived as JSON text parses to its value. */
function notesArg(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Derive the CURRENT note store: the latest `note-store` SNAPSHOT is
 * the baseline (later ones override), the context's successful note
 * calls replay ON TOP in record order (unanswered and failed calls
 * apply nothing — the in-flight call itself is always excluded). The
 * note tool's storage carries the LAST snapshot this process wrote
 * ({owner, notes} — the owner guard keeps notes from leaking into a
 * new/resumed/forked session): when the snapshot record it mirrors
 * still heads the context, the snapshot answers DIRECTLY (it leads
 * the replay by exactly the in-flight call — the record of THIS
 * call's own note-write is already on the context but can never
 * count itself), and an EMPTY derivation + non-empty snapshot means
 * the calls were compacted/edited away: the snapshot answers and
 * nothing resurrects. Finally the agent's sticky message refreshes.
 * @param {object} agent
 * @param {object} [storage] Tool-owned cache (ephemeral).
 * @param {(text: string|null) => *} [messageSet] Tool-owned display setter.
 * @returns {Map<string, object>}
 */
function notesFrom(agent, storage = {}, messageSet) {
  const context = agent.context.messages();
  const owner = agent.context; // the snapshot mirror is keyed by the live Context
  const notes = new Map();
  let lastRecord = null; // the snapshot the tool storage mirrors
  // the BASELINE: snapshot records (later ones override)
  for (const entry of context) {
    if (entry?.type !== RECORD_TYPE) continue;
    const data = entry.notes;
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    notes.clear(); // a snapshot REPLACES, never merges
    for (const [title, note] of Object.entries(data)) {
      if (note === null || typeof note !== "object" || Array.isArray(note)) continue;
      notes.set(title, { ...note });
    }
    lastRecord = entry;
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
      if (!answered.has(block.callId) || failed.has(block.callId)) continue;
      const args = parseArgs(block.arguments);
      if (args === null) continue;
      if (block.name === "note-write") applyNoteCall(notes, args);
    }
  }
  // the SNAPSHOT: the derivation replaced the note tool storage;
  // a fresh same-context snapshot answers DIRECTLY (it mirrors the
  // snapshot record still heading the context — a resumed process's
  // derivation can only equal it or roll calls BACK)
  const box = storage;
  const snapshot = box.snapshot;
  // the EMPTY-CONTEXT reset: a context without a single numeric-type
  // message is a NEW session's (or a fully rolled-back one) — the old
  // snapshot belongs to the abandoned context, so it DROPS
  if (!context.some((entry) => typeof entry?.type === "number")) {
    notes.clear();
    box.snapshot = undefined;
    publish(messageSet, notes);
    return notes;
  }
  if (snapshot?.owner === owner && lastRecord !== null &&
      JSON.stringify(lastRecord.notes) === JSON.stringify(Object.fromEntries(snapshot.notes))) {
    // fresh: the snapshot mirrors the record still heading the context
    // (the comparison is by CONTENT — the session's append can merge
    // or re-create the record object, and a re-load deserializes it
    // fresh; an empty derivation with a NON-empty snapshot keeps the
    // snapshot: the calls were compacted away and nothing resurrects)
    const current = new Map([...snapshot.notes].map(([title, note]) => [title, { ...note }]));
    publish(messageSet, current);
    return current;
  }
  publish(messageSet, notes); // the sticky display follows the store
  return notes;
}

/** Persist the post-call SNAPSHOT: a fresh `note-store` record joins
 *  the context (and with it the session file — the JSONL flush carries
 *  records), and the note tool's storage mirrors it ({owner, record,
 *  notes}) so the next derivation can prefer it over the record's own
 *  replay. Only note-write calls this. */
function persist(agent, storage, notes, messageSet) {
  const record = { type: RECORD_TYPE, notes: Object.fromEntries(notes) };
  // the Context append: the record joins the context AND its session file
  agent.context.append(record);
  if (storage !== undefined) {
    storage.snapshot = {
      owner: agent.context,
      record,
      notes: new Map([...notes].map(([title, note]) => [title, structuredClone(note)])),
    };
  }
  publish(messageSet, notes); // the sticky display follows the store
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
 * Refresh the agent's sticky tool message: every note, one line each
 * — the type badge heading the bold title, the summary trailing when
 * present (the TUI renders the information area's markdown). DONE
 * notes trail every open one (the most actionable notes stay first
 * when the TUI's own per-tool line cap discards overflow —
 * lib/app/tui/information-data.js's MAX_TOOL_ROWS cap — this tool no
 * longer truncates its own message; the display decides how many
 * lines actually fit). An empty result clears the message.
 */
function publish(messageSet, notes) {
  if (typeof messageSet !== "function") return; // a bare context (tests)
  if (notes.size === 0) {
    messageSet(null);
    return;
  }
  const lines = ordered(notes).map(([title, note]) => {
    const summary = typeof note.summary === "string" ? note.summary.trim() : "";
    return `${badge(note.type)}**${title}**${summary ? ` — ${clip(summary)}` : ""}`;
  });
  messageSet(lines.join("\n"));
}

/** Notes as [title, note] pairs, open notes before done ones. */
function ordered(notes) {
  const all = [...notes];
  return [...all.filter(([, note]) => note.type !== "done"), ...all.filter(([, note]) => note.type === "done")];
}

/** Validate a title; returns the trimmed key. */
function titleField(value) {
  if (typeof value !== "string") throw new Error(`note: a note title must be a string`);
  const v = value.trim();
  if (v === "") throw new Error(`note: give the note a non-empty title`);
  if (v.length > MAX_TITLE) throw new Error(`note: the title "${v.slice(0, 20)}…" is ${v.length} chars — shorten it to ${MAX_TITLE} or fewer`);
  return v;
}

/** Validate a note's fields (any JSON, bounded). */
function fieldsCheck(note) {
  const names = Object.keys(note);
  if (names.length > MAX_FIELDS) throw new Error(`note: ${names.length} fields exceed the ${MAX_FIELDS}-field cap per note — split it into several notes`);
  for (const name of names) {
    if (name.length > MAX_FIELD) throw new Error(`note: the field name "${name.slice(0, 20)}…" is ${name.length} chars — shorten it to ${MAX_FIELD} or fewer`);
  }
  const size = JSON.stringify(note).length;
  if (size > MAX_NOTE) throw new Error(`note: this note is ${size} chars — shorten it to ${MAX_NOTE} or fewer`);
}

/** note-write: validate the whole patch map against a working copy
 *  (a failed call applies nothing), then persist the snapshot. */
function noteWrite(args = {}, context) {
  const agent = anchor(context);
  const { storage = {}, messageSet } = context;
  const notesMap = notesArg(args.notes);
  if (notesMap === null || typeof notesMap !== "object" || Array.isArray(notesMap)) {
    throw new Error('note-write: "notes" must map each title to a patch object, e.g. {"notes": {"plan": {"content": "…"}}}; a null patch deletes the note');
  }
  const entries = Object.entries(notesMap);
  if (entries.length === 0) throw new Error('note-write: "notes" is empty; add at least one title → patch');
  if (entries.length > MAX_BATCH) throw new Error(`note-write: ${entries.length} notes in one call; send at most ${MAX_BATCH}`);
  const sim = notesFrom(agent, storage, messageSet);
  for (const [title, patch] of entries) {
    const key = titleField(title);
    if (patch === null) continue; // a deletion (missing notes delete silently)
    if (typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error(`note-write: the patch for "${key}" must be an object (or null to delete the note)`);
    }
    if (!sim.has(key) && sim.size >= MAX_NOTES) {
      throw new Error(`note-write: the store is full (${MAX_NOTES}/${MAX_NOTES}); delete old notes with a null patch first`);
    }
    const merged = mergeFields({ ...(sim.get(key) ?? {}) }, structuredClone(patch));
    fieldsCheck(merged);
    sim.set(key, merged);
  }
  for (const [title, patch] of entries) {
    if (patch === null) sim.delete(title.trim());
  }
  persist(agent, storage, sim, messageSet);
  const n = entries.length;
  return n === 1 ? "note saved" : `${n} notes saved`;
}

/** note-read: a uniform title → note map; missing titles report in-line.
 *  Omitted titles, "*" or ["*"] read every note; a lone string is one
 *  title; a map's keys are its titles. */
function noteRead(args = {}, context) {
  const agent = anchor(context);
  const { storage = {}, messageSet } = context;
  const notes = notesFrom(agent, storage, messageSet);
  let titles = notesArg(args.titles);
  if (typeof titles === "string") titles = [titles];
  else if (titles !== null && typeof titles === "object" && !Array.isArray(titles)) titles = Object.keys(titles);
  const all = titles === undefined || titles === null || titles.length === 0 || titles.includes("*");
  if (all && notes.size === 0) return "No notes.";
  const list = all ? [...notes.keys()] : [...new Set(titles.map((t) => titleField(t)))];
  const found = {};
  const missing = [];
  for (const key of list) {
    if (notes.has(key)) found[key] = notes.get(key);
    else missing.push(key);
  }
  const body = JSON.stringify(found, null, 1);
  return missing.length === 0 ? body : `${body}\n(no note: ${missing.join(", ")})`;
}

/** note-list: every title with its type badge, open notes before done. */
function noteList(_args, context) {
  const agent = anchor(context);
  const { storage = {}, messageSet } = context;
  const notes = notesFrom(agent, storage, messageSet);
  if (notes.size === 0) return "No notes.";
  const lines = ordered(notes).map(([title, note]) => `- ${badge(note.type)}${title}`);
  return `${notes.size} note${notes.size === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

export { noteList as note_list, noteRead as note_read, noteWrite as note_write };

const PATCH = {
  description: "Patch for this title: set fields merge in (nested objects merge, arrays and scalars replace); a null field deletes it; a null patch deletes the note.",
  properties: {
    content: { description: "The full note body." },
    summary: { description: "A one-line gist." },
    type: { description: "todo, active, done or info." },
  },
  additionalProperties: true,
};

export function toolDescription() {
  return {
    "note-list": {
      fn: noteList,
      safe: true,
      storage: "note",
      // Session startup/resume needs the context-derived sticky display
      // before any new note call; the detector is harness-only.
      detect: ({ agent, storage, messageSet }) => notesFrom(agent, storage, messageSet),
      description: "List scratchpad notes for the current context: each title with its type badge. Use note-read for contents.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    "note-read": {
      fn: noteRead,
      safe: true,
      storage: "note",
      description: "Read scratchpad notes by title; omit titles to read every note.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { titles: { type: "array", items: { type: "string" }, description: "Note titles from note-list." } },
      },
    },
    "note-write": {
      fn: noteWrite,
      safe: true,
      storage: "note",
      description: "Create, update or delete scratchpad notes in one call. Prefer content, summary and type fields; add other JSON fields as needed. Notes live only in the current context; store durable data in files.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["notes"],
        properties: {
          notes: { type: "object", description: "Title → patch map; a null patch deletes that note.", additionalProperties: PATCH },
        },
      },
    },
  };
}
