/**
 * tools/edit.js — the `edit` tool: exact-text replacement in one file
 * (pi edit semantics): edits[] are matched against the ORIGINAL file
 * content, never incrementally; every edits[].oldText must match
 * exactly ONE location (or every occurrence, when that edit's `matchAll` is set),
 * and matched regions must not overlap. Matching
 * runs on LF-normalized text (a BOM is stripped and restored, the
 * file's dominant line ending is preserved), so oldText never needs
 * to guess invisible bytes.
 *
 * Hardened by the GLOBAL path-traversal policy: the path argument
 * passes the DETERMINISTIC resolver (tools/guard/resolve.js —
 * normalized against the Agent folder; paths escaping that folder
 * are refused, while contained absolute paths work), and every edits[].newText — the material the
 * edit INTRODUCES — passes the fast-path content trip-wire
 * (tools/guard/paths.js): strings that look like a path and resolve
 * outside the working folder are flagged (a first-line `#!` shebang
 * is exempt). A violation refuses the edit unless the call passed
 * `ask: true` AND the harness wired a question bridge: then the user
 * is asked for permission with a 5-line preview of the offending
 * line(s).
 *
 * DIFF + UNDO: every applied edit is RECORDED under its tool
 * call's id in the CALLING AGENT's session store (tools/edit/diff.js
 * — context.storage; one agent can never roll back
 * another's edit) and returned as a git-style unified patch in the
 * result's DISPLAY payload — shown to the user, never appended to the
 * conversation (the {result, display} contract,
 * lib/agent/tool-exec.js). `edit-undo { path, editId: "<toolCallID>" }`
 * reverses a recorded edit: the given path must MATCH the record —
 * a rollback is intentional, never a random id — and the record
 * keeps each match's exact
 * offset and the file's dominant line ending, so the restore is
 * precise (drift that duplicated the replacement text elsewhere never
 * blocks it) and never rewrites the file's line-ending style. A
 * rollback records ITSELF (a redo), and consumes the record only
 * after the rewrite succeeded — a failed rollback can be retried
 * after the file is reconciled.
 *
 * NOT read-only: safe-mode Agents never see this tool.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { toolRevision } from "../lib/tool-runtime.js"; // the tool-runtime leaf: one instance across cache-busted imports — no whole-library load for a timestamp

const timestamp = toolRevision(); // shared tool-registry revision
const { resolveCwdPath, relativeCwdPath } = await import(`./guard/resolve.js?now=${timestamp}`);
const { rejectSymlinkPath } = await import(`./guard/symlinks.js?now=${timestamp}`);
const { enforceContentPolicy } = await import(`./guard/paths.js?now=${timestamp}`);
const { unifiedPatch, recordEdit, peekEdit, removeEdit } = await import(`./edit/diff.js?now=${timestamp}`);
const { queueEdit } = await import(`./edit/queue.js?now=${timestamp}`);

function contentHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Split a leading BOM from the text. */
function splitBom(text) {
  return text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

/** The file's dominant line ending ("\r\n" only when it dominates). */
function detectLineEnding(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Apply the edits against the ORIGINAL content (pi semantics):
 * unique, non-overlapping exact matches; all replacements computed
 * first, then applied from the end backwards so positions stay true.
 * @param {string} content - LF-normalized original
 * @param {Array<{oldText: string, newText: string, matchAll?: boolean}>} edits
 * @param {string} path - for error messages
 * @returns {{out: string, matches: Array<{start: number, end: number, i: number}>}}
 */
function applyEdits(content, edits, path) {
  const matches = [];
  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText, matchAll } = edits[i] ?? {};
    if (typeof oldText !== "string" || oldText === "" || typeof newText !== "string") {
      throw new TypeError("Give every edit a non-empty oldText string and a newText string.");
    }
    if (matchAll !== undefined && typeof matchAll !== "boolean") {
      throw new TypeError("Each edit's matchAll must be a boolean.");
    }
    const hits = [];
    // at most TWO hits matter in unique mode: zero = not found, one =
    // unique, two = already a duplicate — stop scanning there (a
    // repeated oldText in a long file would otherwise scan every
    // remaining occurrence)
    const cap = matchAll ? Infinity : 2;
    for (let from = 0; hits.length < cap; ) {
      const at = content.indexOf(oldText, from);
      if (at === -1) break;
      hits.push(at);
      from = at + 1;
    }
    if (hits.length === 0) {
      throw new Error("oldText was not found in the file. Read the file and copy its exact current text into oldText.");
    }
    if (hits.length > 1 && !matchAll) {
      throw new Error("oldText matches more than once. Add surrounding context to make it unique, or set matchAll: true on this edit to replace every occurrence.");
    }
    for (const at of hits) matches.push({ start: at, end: at + oldText.length, newText, i });
  }
  matches.sort((a, b) => a.start - b.start);
  for (let k = 1; k < matches.length; k++) {
    if (matches[k].start < matches[k - 1].end) {
      throw new Error(`Edits ${matches[k - 1].i + 1} and ${matches[k].i + 1} overlap. Merge them into one edit.`);
    }
  }
  let out = content;
  for (let k = matches.length - 1; k >= 0; k--) {
    const m = matches[k];
    out = out.slice(0, m.start) + m.newText + out.slice(m.end);
  }
  return { out, matches };
}

/** The SWAPPED form of a recorded edit list: each block becomes
 * {oldText: newText, newText: oldText, at} — the rollback's redo
 * record. `at` is carried through: after a restore, the region sits
 * at the SAME offset it was recorded at. */
function reverseEdits(edits, restored) {
  return edits.map(({ oldText, newText, at }) => ({
    oldText: newText, newText: oldText, at,
    ...(oldText === "" ? { postHash: contentHash(restored) } : {}),
  }));
}

/**
 * Restore a recorded edit in place: every block's replacement must
 * appear EXACTLY at its recorded offset in the current text — the
 * same exact-match semantics as the forward edit, scoped to the
 * recorded region, so drift that merely duplicated the replacement
 * text elsewhere never blocks the restore (a genuine drift at the
 * region refuses honestly). All regions are verified BEFORE anything
 * is written: a failed rollback leaves the file untouched.
 * @param {string} normalized - LF-normalized current file text
 * @param {{path: string, edits: Array<{oldText: string, newText: string, at?: number}>}} entry
 * @returns {string} the restored text
 */
function restoreEdit(normalized, entry) {
  const regions = entry.edits.map(({ oldText, newText, at, postHash }) => {
    if (!Number.isInteger(at) || (newText === "" && (!postHash || postHash !== contentHash(normalized))) || normalized.slice(at, at + newText.length) !== newText) {
      throw new Error("The file changed since this edit. Read it and make a new targeted edit instead.");
    }
    return { start: at, end: at + newText.length, oldText };
  });
  let out = normalized;
  for (let k = regions.length - 1; k >= 0; k--) {
    const r = regions[k];
    out = out.slice(0, r.start) + r.oldText + out.slice(r.end);
  }
  return out;
}

/** Write the outcome back, restoring the BOM and the dominant line ending. */
async function writeOutcome(resolved, bom, ending, out) {
  await writeFile(resolved, bom + (ending === "\r\n" ? out.replace(/\n/g, "\r\n") : out), "utf8");
}

/**
 * Reverse a recorded edit (the `edit-undo { path, editId }` form):
 * the record keeps each match's exact offset in the post-edit text,
 * so the restore replaces exactly the regions the original edit wrote
 * — the same exact-match semantics as the forward edit, scoped to the
 * recorded position, so drift that merely DUPLICATED the replacement
 * text elsewhere never blocks the rollback. The recorded dominant
 * line ending is reused: a rollback never rewrites the file's
 * line-ending style. The rollback records itself under its own call
 * id, so IT can be rolled back in turn (a redo), and consumes the
 * record only after the rewrite succeeded. The reverse patch rides
 * the display payload.
 * @param {{path: string, editId: string}} args - the recorded edit's call id and matching file path
 * @param {Object} [context] - harness tool context ({agent, call}); the undo mutates the file and consumes its record only after success
 * @returns {Promise<{result: string, display: string}>}
 */
export async function editUndo({ path, editId } = {}, context) {
  if (typeof editId !== "string" || editId === "") {
    throw new TypeError("Give the edit id to roll back.");
  }
  if (typeof path !== "string" || path === "") {
    throw new TypeError("Give the file path the edit id belongs to.");
  }
  const entry = peekEdit(editId, context);
  if (!entry) {
    throw new Error("Use an edit id returned by a recent successful edit, or make a new targeted edit.");
  }
  const writeCwd = context?.agent?.folder ?? context?.env?.folder ?? context?.agent?.env?.folder ?? process.cwd();
  const requested = resolveCwdPath(path, { cwd: writeCwd });
  if (resolveCwdPath(entry.path, { cwd: writeCwd }) !== requested) {
    throw new Error("Use the `path` matching the `editId` you want to undo, or make a targeted edit.");
  }
  // Rollback obeys the same agent-local write boundary as forward edits.
  const resolved = await rejectSymlinkPath(resolveCwdPath(entry.path, { cwd: writeCwd }), { cwd: writeCwd });
  return queueEdit(resolved, async () => {
    const raw = await readFile(resolved, "utf8");
    const { bom, text } = splitBom(raw);
    const normalized = text.replace(/\r\n/g, "\n");
    const out = restoreEdit(normalized, entry);
    // The file's ORIGINAL dominant ending (recorded with the edit),
    // never a re-detection: line-ending style is not the rollback's
    // business.
    await writeOutcome(resolved, bom, entry.ending ?? "\n", out);
    removeEdit(editId, context); // consume only after success — a failed undo stays retryable
    const callId = context?.call?.callId;
    const redo = reverseEdits(entry.edits, out);
    if (callId) recordEdit(callId, { path: entry.path, edits: redo, ending: entry.ending }, context); // the redo
    const suffix = callId ? ` Edit id: ${callId} (reverses again).` : "";
    return {
      result: `Undid edit: restored ${entry.edits.length} block(s) in ${entry.path}.${suffix}`,
      display: unifiedPatch(entry.path, normalized, out),
    };
  });
}

/**
 * Edit a single file using exact text replacement.
 * @param {Object} args
 * @param {string} args.path - file path, inside the working folder
 * @param {Array<{oldText: string, newText: string, matchAll?: boolean}>} args.edits
 * @param {boolean} [args.ask] - on a content-policy violation, ask the
 *   user for permission (5-line preview) instead of refusing outright
 * @param {Object} [context] - harness tool context ({question, call})
 * @returns {Promise<{result: string, display: string}>}
 */
export async function edit({ path, edits, ask } = {}, context) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new TypeError("Give one or more edits, each with oldText and newText.");
  }
  // Mutations stay in the agent folder even when Env.folder is elsewhere.
  const writeCwd = context?.agent?.folder ?? context?.env?.folder ?? context?.agent?.env?.folder ?? process.cwd();
  const contentCwd = writeCwd;
  const resolved = await rejectSymlinkPath(resolveCwdPath(path, { cwd: writeCwd }), { cwd: writeCwd }); // filename guard
  path = relativeCwdPath(path, { cwd: writeCwd });
  // Permission can await user input. Do it before entering the queue, then
  // read the newest file contents inside it so no pre-prompt snapshot wins.
  for (const e of edits) {
    await enforceContentPolicy({
      path, content: String(e?.newText ?? ""), ask, context,
      cwd: contentCwd, lax: true,
    });
  }
  return queueEdit(resolved, async () => {
    const raw = await readFile(resolved, "utf8"); // ENOENT surfaces as an ordinary error
    const { bom, text } = splitBom(raw);
    const ending = detectLineEnding(text);
    const normalized = text.replace(/\r\n/g, "\n");
    const { out, matches } = applyEdits(normalized, edits, path);
    await writeOutcome(resolved, bom, ending, out);
    // Record under the call id for a later edit-undo.
    const callId = context?.call?.callId;
    if (callId) {
      // One record per MATCH (a matchAll edit writes several regions).
      // The offset is the match's position in the POST-edit text:
      // replacements before it shifted it by their length deltas.
      const recorded = matches.map((m, k) => ({
        oldText: edits[m.i].oldText,
        newText: m.newText,
        at: m.start + matches.slice(0, k).reduce((delta, p) => delta + p.newText.length - (p.end - p.start), 0),
        ...(m.newText === "" ? { postHash: contentHash(out) } : {}),
      }));
      recordEdit(callId, { path, edits: recorded, ending }, context);
    }
    const suffix = callId ? ` Edit id: ${callId}` : "";
    return {
      result: `Replaced ${edits.length} block(s) in ${path}.${suffix}`,
      display: unifiedPatch(path, normalized, out), // shown to the user, never sent to the model
    };
  });
}

export function toolDescription() {
  return {
    edit: {
      trusted: true,
      description: "Replace exact text in one file. Read the file first, then send oldText/newText pairs from its current content. Merge nearby or overlapping changes into one edit. Set matchAll on an item to replace every occurrence of that item's oldText. Use edit-undo with the returned edit id to reverse it.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File inside the Agent folder; use a relative or contained absolute path." },
          edits: {
            type: "array",
            description:
              "The replacements to make. Match each oldText against the file " +
              "as it is now, not against earlier edits in the same call. Never " +
              "send overlapping or nested edits; merge them into one edit.",
            items: {
              type: "object",
              properties: {
                oldText: {
                  type: "string",
                  description: "The exact text to replace. Make it unique unless matchAll is true; never overlap another edit\u2019s oldText.",
                },
                newText: { type: "string", description: "The replacement text." },
                matchAll: { type: "boolean", description: "Replace every occurrence of this oldText. Omit to require a unique match." },
              },
              required: ["oldText", "newText"],
            },
          },
          ask: {
            type: "boolean",
            description:
              "Ask the user for permission, showing the offending lines, when a " +
              "newText names an existing outside path or an existing absolute project path. Omit it to refuse " +
              "such edits outright.",
          },
        },
        required: ["path", "edits"]
      },
    },
    "edit-undo": {
      fn: editUndo,
      trusted: true,
      storage: "edit",
      description: "Reverse a recent edit using its returned edit id and the same file path. The file must still hold the replacement text at the edited positions; otherwise read the file and make a new targeted edit. Undo itself returns an edit id for redo.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path used for the original edit, inside the Agent folder." },
          editId: { type: "string", description: "The edit id returned by a recent successful edit or edit-undo." },
        },
        required: ["path", "editId"],
      },
    },
  };
}
