/**
 * tools/note.js — the NOTE tool: short-term memory for the agent.
 * ONE tool, `note`, with an `action` discriminator (set / get / list /
 * remove / search) — one schema in the context instead of six.
 *
 * A note is a small JSON object the model shapes freely, keyed by its
 * title (the store's KEY — never a payload field). Three fields are
 * the suggested CONVENTION, never mandatory:
 *   type     todo / active / done / info — drives the badge emoji
 *            on the TUI's sticky display and the list badges (one
 *            recommended name per badge; common aliases like
 *            pending/task, working/focus, finished/complete and note
 *            stay accepted; an unrecognized type displays a fallback)
 *   summary  the one-line gist
 *   content  the full note
 * Any other field the model wants rides along (owners, deadlines,
 * flags) — the note is a JSON store, capped per note.
 *
 * THE CALLS (all INTERACTIVE — they operate on the calling agent's
 * live context through the harness tool context `{agent, env}`,
 * never in the forked sandbox):
 *   note { action: "set", notes: { title: patch, ... } }
 *     merge-patch (RFC 7386) each note: objects merge recursively,
 *     arrays/scalars replace, a null FIELD deletes it, a null PATCH
 *     deletes the note; missing notes are created (upsert)
 *   note { action: "get", notes: [title, ...], only? }
 *     read notes (["*"] reads all); `only` filters the returned
 *     fields (default: every field)
 *   note { action: "list" }
 *     every OPEN note (type badge + title) — DONE notes are hidden
 *     here (a footer counts them) but stay reachable via get/search
 *   note { action: "remove", notes: [title, ...] }
 *     delete notes (["*"] deletes EVERY note)
 *   note { action: "search", pattern, field?, max? }
 *     REGEX search over the title and every field (reaches DONE too)
 *
 * THE STORE IS OWNED BY THE CONTEXT, never by this module: there is
 * no side state. Every call DERIVES the current notes by scanning the
 * agent's context — a `note-store` metadata RECORD (string `type`,
 * never sent to the model — IO filters records from every request)
 * is the BASELINE, and the context's own successful note calls
 * replay ON TOP of it (a set merges its patches, a remove deletes;
 * calls that failed or were never answered apply nothing).
 * Consequences, all intended:
 *   - a context edit/rollback that drops a call drops its effect
 *     (the memory is as honest as the record; deliberate edits win);
 *   - an EMPTY context (no numeric-`type` message — a fresh session
 *     that hasn't even seeded its system prompt yet) RESETS the store:
 *     the backup belongs to the context that was abandoned, so it is
 *     dropped instead of restored;
 *   - COMPACTION can no longer lose the store: every set/remove call
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
 *   - re-asking is always fresh: two identical searches can answer
 *     differently once a later call changed the record;
 *   - the tool itself is read-only over the world — its only
 *     "writes" are its calls and their snapshot records joining the
 *     context like any other entry.
 *
 * THE STICKY DISPLAY: every call also refreshes the agent's sticky
 * tool MESSAGE (Agent.updateToolMessage — agent-owned, the TUI
 * collects it from the viewed agent): every note, one line
 * each, the type's badge emoji heading the bold title with its
 * summary trailing when set — DONE notes trail every open one (still
 * published, just last: the TUI's own per-tool line cap discards
 * overflow — lib/tui-helpers/view-rows.js infoLines — so the most
 * actionable notes are the ones that survive it). A live side effect
 * of note-set, unentangled from the model-facing reply (the
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
const MAX_BATCH = 20; // notes per set/remove call
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

/** Apply one `note` tool call's arguments to the store (new format). */
function applyNoteCall(notes, args) {
  if (!["set", "remove"].includes(args?.action)) return;
  if (Array.isArray(args.notes)) {
    if (args.action !== "remove") return; // set with a selector: no payload to apply
    if (args.notes.includes("*")) notes.clear();
    for (const raw of args.notes) {
      if (typeof raw === "string" && raw !== "*") notes.delete(raw.trim());
    }
    return;
  }
  const map = args.notes;
  if (map === null || typeof map !== "object") return;
  if (args.action === "remove") {
    for (const title of Object.keys(map)) notes.delete(title.trim());
    return;
  }
  for (const [title, patch] of Object.entries(map)) {
    const key = title.trim();
    if (key === "") continue;
    if (patch === null) notes.delete(key);
    else if (patch !== null && typeof patch === "object" && !Array.isArray(patch)) {
      mergeFields(notes.get(key) ?? notes.set(key, {}).get(key), patch);
    }
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
 * call's own set/remove is already on the context but can never
 * count itself), and an EMPTY derivation + non-empty snapshot means
 * the calls were compacted/edited away: the snapshot answers and
 * nothing resurrects. Finally the agent's sticky message refreshes.
 * @param {object} agent
 * @param {object} [storage]
 * @returns {Map<string, object>}
 */
function notesFrom(agent, storage = agent.toolStorage?.("note") ?? {}) {
  const context = agent.context;
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
      if (block.name === "note") applyNoteCall(notes, args);
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
    publish(agent, notes);
    return notes;
  }
  if (snapshot?.owner === context && lastRecord !== null &&
      JSON.stringify(lastRecord.notes) === JSON.stringify(Object.fromEntries(snapshot.notes))) {
    // fresh: the snapshot mirrors the record still heading the context
    // (the comparison is by CONTENT — the session's append can merge
    // or re-create the record object, and a re-load deserializes it
    // fresh; an empty derivation with a NON-empty snapshot keeps the
    // snapshot: the calls were compacted away and nothing resurrects)
    const current = new Map([...snapshot.notes].map(([title, note]) => [title, { ...note }]));
    publish(agent, current);
    return current;
  }
  publish(agent, notes); // the sticky display follows the store
  return notes;
}

/** Persist the post-call SNAPSHOT: a fresh `note-store` record joins
 *  the context (and with it the session file — the JSONL flush carries
 *  records), and the note tool's storage mirrors it ({owner, record,
 *  notes}) so the next derivation can prefer it over the record's own
 *  replay. Only set/remove call this — the mutation actions. */
function persist(agent, storage, notes) {
  const record = { type: RECORD_TYPE, notes: Object.fromEntries(notes) };
  // the Agent's OWN append method (never Array.prototype.push —
  // agent.context IS an array): it routes through the session, so the
  // record joins the context AND the session file
  if (typeof agent.append === "function" && agent.append !== agent.context?.push) agent.append(record);
  else agent.context.push(record); // a bare context (tests): same effect, no session
  if (storage !== undefined) {
    storage.snapshot = {
      owner: agent.context,
      record,
      notes: new Map([...notes].map(([title, note]) => [title, structuredClone(note)])),
    };
  }
  publish(agent, notes); // the sticky display follows the store
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
 * lib/tui-helpers/view-rows.js infoLines — this tool no longer
 * truncates its own message; the display decides how many lines
 * actually fit). An empty result clears the message.
 */
function publish(agent, notes) {
  if (typeof agent.updateToolMessage !== "function") return; // a bare context (tests)
  if (notes.size === 0) {
    agent.updateToolMessage("note", null);
    return;
  }
  const open = [...notes.entries()].filter(([, note]) => note.type !== "done");
  const done = [...notes.entries()].filter(([, note]) => note.type === "done");
  const lines = [...open, ...done].map(([title, note]) => {
    const summary = typeof note.summary === "string" ? note.summary.trim() : "";
    return `${badge(note.type)}**${title}**${summary ? ` — ${clip(summary)}` : ""}`;
  });
  agent.updateToolMessage("note", lines.join("\n"));
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

/** set: validate the patch map and simulate the merge (the store caps
 *  and field bounds are enforced BEFORE this call joins the context —
 *  a failed call applies nothing). */
function setAction(notesMap, agent, storage) {
  if (Array.isArray(notesMap)) {
    throw new Error('note: "set" needs a title → patch map ({notes: {"my title": {content: "…"}}}) — an array of titles selects notes for get/remove only');
  }
  if (notesMap === null || typeof notesMap !== "object") {
    throw new Error('note: "set" requires "notes" — a map of title → patch object (a null patch deletes the note)');
  }
  const entries = Object.entries(notesMap);
  if (entries.length === 0) throw new Error('note: "set" needs at least one note (the map is empty)');
  if (entries.length > MAX_BATCH) throw new Error(`note: ${entries.length} notes in one call — the cap is ${MAX_BATCH}`);
  // apply to a WORKING COPY of the derived store: validate the whole
  // map first (a failed call applies nothing), then persist the
  // post-call snapshot
  const sim = notesFrom(agent, storage);
  for (const [title, patch] of entries) {
    const key = titleField(title);
    if (patch === null) continue; // a deletion (missing notes delete silently)
    if (typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error(`note: the patch for "${key}" must be an object (or null to delete the note)`);
    }
    if (!sim.has(key) && sim.size >= MAX_NOTES) {
      throw new Error(`note: the store is full (${MAX_NOTES}/${MAX_NOTES}) — remove old notes first`);
    }
    const merged = mergeFields({ ...(sim.get(key) ?? {}) }, structuredClone(patch));
    fieldsCheck(merged);
    sim.set(key, merged);
  }
  for (const [title, patch] of entries) {
    if (patch === null) sim.delete(title.trim());
  }
  persist(agent, storage, sim);
  const n = entries.length;
  return n === 1 ? "note saved" : `${n} notes saved`;
}

/** get: read notes; returns a uniform title → note map (missing
 *  titles reported in-line, never an error). */
function getAction(titles, only, agent, storage) {
  const list = selector(titles, agent, storage);
  const notes = notesFrom(agent, storage);
  if (only !== undefined && (!Array.isArray(only) || only.some((f) => typeof f !== "string" || f === ""))) {
    throw new Error('note: "only" must be an array of field names');
  }
  const found = {};
  const missing = [];
  for (const key of list) {
    const note = notes.get(key);
    if (note === undefined) {
      missing.push(key);
      continue;
    }
    found[key] = only === undefined || only.length === 0
      ? note
      : Object.fromEntries(Object.entries(note).filter(([name]) => only.includes(name)));
  }
  const body = JSON.stringify(found, null, 1);
  return missing.length === 0 ? body : `${body}\n(no note: ${missing.join(", ")})`;
}

/** remove: delete notes by selector (["*"] deletes every note). */
function removeAction(titles, agent, storage) {
  const notes = notesFrom(agent, storage);
  if (Array.isArray(titles) && titles.includes("*")) {
    if (notes.size === 0) return "no notes to remove";
    const n = notes.size;
    persist(agent, storage, new Map()); // the empty snapshot: a full clear stays cleared
    return `removed all ${n} note${n === 1 ? "" : "s"}`;
  }
  const list = selector(titles, agent, storage);
  if (list.length > MAX_BATCH) throw new Error(`note: ${list.length} notes in one call — the cap is ${MAX_BATCH}`);
  if (list.length === 0) return "no notes to remove";
  const missing = list.filter((key) => !notes.has(key));
  const n = list.length - missing.length;
  const verb = n === 1 ? "note removed" : `removed ${n} notes`;
  const reply = missing.length === 0 ? verb : `${verb} (no note: ${missing.join(", ")})`;
  if (n > 0) persist(agent, storage, new Map([...notes].filter(([key]) => !list.includes(key))));
  return reply;
}

/** list: every OPEN note (type badge + title) — DONE notes are hidden
 *  here (a footer counts them) but stay reachable via get/search. */
function listAction(agent, storage) {
  const notes = notesFrom(agent, storage);
  const shown = [...notes.entries()].filter(([, note]) => note.type !== "done");
  const done = notes.size - shown.length;
  if (shown.length === 0) {
    return done > 0 ? `No open notes (+${done} done).` : "No notes.";
  }
  const lines = shown.map(([title, note]) => `- ${badge(note.type)}${title}`);
  return `${shown.length} note${shown.length === 1 ? "" : "s"}:\n${lines.join("\n")}${done > 0 ? `\n(+${done} done)` : ""}`;
}

/** search: regex over the title and every field (non-string values
 *  search their JSON). */
function searchAction(pattern, field, max, agent, storage) {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    throw new Error('note: "search" requires "pattern" (a regular expression, case-insensitive)');
  }
  if (field !== undefined && (typeof field !== "string" || field === "")) {
    throw new Error('note: "field" must be a field name ("title" or any stored field)');
  }
  let rx;
  try {
    rx = new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(`note: invalid regular expression — ${err.message}`);
  }
  const cap = Math.max(1, Math.min(MAX_MATCHES, Number(max) || 20));
  const notes = notesFrom(agent, storage);
  const hits = [];
  for (const [title, note] of notes) {
    const candidates = field === "title" || field === undefined ? [["title", title]] : [];
    if (field === undefined) {
      for (const [name, value] of Object.entries(note)) candidates.push([name, value]);
    } else if (field !== "title" && note[field] !== undefined) {
      candidates.push([field, note[field]]);
    }
    const fields = candidates
      .filter(([, value]) => rx.test(typeof value === "string" ? value : JSON.stringify(value) ?? ""))
      .map(([name]) => name);
    if (fields.length > 0) hits.push({ title, fields });
  }
  if (hits.length === 0) {
    return `No notes match /${pattern}/${field !== undefined ? ` in ${field}` : ""}.`;
  }
  const shown = hits.slice(0, cap);
  const body = shown.map(({ title, fields }) => `- ${title} (matched: ${fields.join(", ")})`).join("\n");
  return `${hits.length > cap ? `${cap} of ${hits.length} matches` : `${shown.length} match(es)`} for /${pattern}/:\n${body}`;
}

/** Resolve a get/remove selector: ["*"] expands to every title,
 *  strings trim and validate; the map form's KEYS are the selector
 *  (tolerance — the shapes route by type, so a map here is the model
 *  handing over a patch map for a read/delete). */
function selector(titles, agent, storage) {
  const all = titles === "*" || (Array.isArray(titles) && titles.includes("*"));
  if (all) return [...notesFrom(agent, storage).keys()];
  const list = Array.isArray(titles) ? titles
    : titles !== null && typeof titles === "object" ? Object.keys(titles) // the map form: its keys
    : undefined;
  if (list === undefined) {
    throw new Error('note: "notes" is required — an array of titles (["*"] selects every note)');
  }
  return [...new Set(list.filter((t) => t !== "*").map((t) => titleField(t)))];
}

/**
 * The consolidated NOTE tool: one entry point, the action selects the
 * operation. `notes` is polymorphic by SHAPE: an array of titles is a
 * SELECTOR (get/remove), a title → patch map is a PAYLOAD (set). The
 * two shapes never serve the same action.
 */
function note({ action, notes, pattern, field, max, only } = {}, context) {
  const agent = anchor(context);
  const storage = agent.toolStorage?.("note"); // the note tool's own box (undefined for a bare context)
  switch (action) {
    case "set": return setAction(notes, agent, storage);
    case "get": return getAction(notes, only, agent, storage);
    case "list": return listAction(agent, storage);
    case "remove": return removeAction(notes, agent, storage);
    case "search": return searchAction(pattern, field, max, agent, storage);
    default:
      throw new Error(`note: "action" must be one of set, get, list, remove, search${typeof action === "string" ? ` (got "${action}")` : ""}`);
  }
}

export { note };

const PATCH = {
  description: "Patch for the note whose title is this key: fields you set are merged in (nested objects merge field-by-field, arrays and scalars replace), a null field deletes that field, and a null patch deletes the whole note.",
  type: ["object", "null"],
  properties: {
    content: { type: ["string", "null"], description: "The full note body." },
    summary: { type: ["string", "null"], description: "A one-line gist of the note." },
    type: { type: ["string", "null"], description: "todo / active / done / info — pick the one that fits." },
  },
  additionalProperties: true,
};

export function toolDescription() {
  return {
    note: {
      safe: true,
      // Session startup/resume needs the same context-derived sticky state
      // before any new note call occurs; the detector is harness-only.
      storage: "note",
      detect: ({ agent }) => notesFrom(agent, agent.toolStorage("note")),
      description: "Manage scratchpad notes (short-term memory). Actions: `set` creates or updates notes ({notes: {title: patch}} — missing notes are created; set a patch to null to delete its note), `get` reads notes ({notes: [title, ...]}; use [\"*\"] for every note and `only` to return specific fields), `list` shows open notes (done notes are omitted), `remove` deletes notes ({notes: [title, ...]}; [\"*\"] deletes all), `search` regex-searches titles and fields (case-insensitive; use `field` to search one field and `max` to cap matches). Pass `notes` as an array of titles for get/remove or as a title → patch map for set. Note fields are free JSON — content/summary/type are the convention; add any other fields you need.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["set", "get", "list", "remove", "search"],
            description: "The operation to perform.",
          },
          notes: {
            type: ["array", "object"],
            description: "set: a map of title → patch object. get/remove: an array of titles ([\"*\"] = every note).",
            items: { type: "string", description: "A note title; applies when `notes` is an array." },
            additionalProperties: PATCH,
          },
          only: {
            type: "array",
            items: { type: "string" },
            description: "get: return only these fields (default: every field).",
          },
          pattern: { type: "string", description: "search: a regular expression (case-insensitive)." },
          field: { type: "string", description: "search: limit the search to one field (default: the title and all fields)." },
          max: { type: "number", description: "search: maximum matches to return (default 20, cap 50)." },
        },
        required: ["action"],
      },
    },
  };
}
