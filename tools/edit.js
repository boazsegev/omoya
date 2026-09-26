/**
 * tools/edit.js — the `edit` tool: exact-text replacement in one file
 * (pi edit semantics): edits[] are matched against the ORIGINAL file
 * content, never incrementally; every edits[].oldText must match
 * exactly ONE location, and matched regions must not overlap. Matching
 * runs on LF-normalized text (a BOM is stripped and restored, the
 * file's dominant line ending is preserved), so oldText never needs
 * to guess invisible bytes.
 *
 * Hardened by the GLOBAL path-traversal policy: the path argument
 * passes the DETERMINISTIC resolver (tools/guard/resolve.js —
 * normalized against the working folder, refused on a leading `..`
 * or an absolute form), and every edits[].newText — the material the
 * edit INTRODUCES — passes the fast-path content trip-wire
 * (tools/guard/paths.js): strings that look like a path and resolve
 * outside the working folder are flagged (a first-line `#!` shebang
 * is exempt). A violation refuses the edit unless the call passed
 * `ask: true` AND the harness wired a question bridge: then the user
 * is asked for permission with a 5-line preview of the offending
 * line(s).
 *
 * DIFF + ROLLBACK: every applied edit is RECORDED under its tool
 * call's id in the CALLING AGENT's session store (tools/edit/diff.js
 * — context.agent.toolStorage("edit"); one agent can never roll back
 * another's edit) and returned as a git-style unified patch in the
 * result's DISPLAY payload — shown to the user, never appended to the
 * conversation (the {result, display} contract,
 * lib/agent/tool-exec.js). `edit { path, rollback: "<toolCallID>" }`
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
import { toolRevision } from "../lib/tool-runtime.js"; // the tool-runtime leaf: one instance across cache-busted imports — no whole-library load for a timestamp

const timestamp = toolRevision(); // shared tool-registry revision
const { resolveCwdPath } = await import(`./guard/resolve.js?now=${timestamp}`);
const { rejectSymlinkPath } = await import(`./guard/symlinks.js?now=${timestamp}`);
const { enforceContentPolicy } = await import(`./guard/paths.js?now=${timestamp}`);
const { unifiedPatch, recordEdit, peekEdit, removeEdit } = await import(`./edit/diff.js?now=${timestamp}`);

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
 * @param {Array<{oldText: string, newText: string}>} edits
 * @param {string} path - for error messages
 * @param {boolean} [matchAll] - replace every occurrence of each oldText
 * @returns {{out: string, matches: Array<{start: number, end: number, i: number}>}}
 */
function applyEdits(content, edits, path, matchAll = false) {
  const matches = [];
  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText } = edits[i] ?? {};
    if (typeof oldText !== "string" || oldText === "" || typeof newText !== "string") {
      throw new TypeError("Give every edit a non-empty oldText string and a newText string.");
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
      throw new Error("oldText matches more than once. Add surrounding context to make it unique, or pass matchAll: true to replace every occurrence.");
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
function reverseEdits(edits) {
  return edits.map(({ oldText, newText, at }) => ({ oldText: newText, newText: oldText, at }));
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
  const regions = entry.edits.map(({ oldText, newText, at }, k) => {
    if (!Number.isInteger(at) || normalized.slice(at, at + newText.length) !== newText) {
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

// Each file has a private promise tail.  The queue encloses read, exact-match
// validation, and write so independent edits never overwrite each other.
const editQueues = new Map();
async function queueEdit(resolved, task) {
  const previous = editQueues.get(resolved);
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  editQueues.set(resolved, current);
  if (previous) await previous;
  try {
    return await task();
  } finally {
    release();
    if (editQueues.get(resolved) === current) editQueues.delete(resolved);
  }
}

/**
 * Reverse a recorded edit (the `rollback: "<toolCallID>"` form):
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
 * @param {string} rollback - the recorded edit's tool call id
 * @param {string} path - the file the recorded edit belongs to (must
 *   match the record: a rollback is intentional, never a random id)
 * @param {Object} [context] - harness tool context ({agent, call})
 * @returns {Promise<{result: string, display: string}>}
 */
async function rollbackEdit(rollback, path, context) {
  if (typeof rollback !== "string" || rollback === "") {
    throw new TypeError("Give the edit id to roll back.");
  }
  if (typeof path !== "string" || path === "") {
    throw new TypeError("Give the file path the rollback id belongs to.");
  }
  const entry = peekEdit(rollback, context);
  if (!entry) {
    throw new Error("Use an edit id returned by a recent successful edit, or make a new targeted edit.");
  }
  if (entry.path !== path) {
    throw new Error("Use the `path` matching the `rollback` id you want to roll back, or make a targeted edit.");
  }
  // Same project-bounded resolution as the forward edit: the agent's
  // folder is cwd, and a rollback may target a project sibling recorded
  // through ../, but must never follow a planted link.
  const writeCwd = context?.agent?.folder ?? context?.env?.cwd ?? context?.agent?.env?.cwd ?? process.cwd();
  const projectCwd = context?.env?.cwd ?? context?.agent?.env?.cwd ?? writeCwd;
  const resolved = await rejectSymlinkPath(resolveCwdPath(entry.path, { cwd: writeCwd, boundary: projectCwd }), { cwd: projectCwd });
  return queueEdit(resolved, async () => {
    const raw = await readFile(resolved, "utf8");
    const { bom, text } = splitBom(raw);
    const normalized = text.replace(/\r\n/g, "\n");
    const out = restoreEdit(normalized, entry);
    // The file's ORIGINAL dominant ending (recorded with the edit),
    // never a re-detection: line-ending style is not the rollback's
    // business.
    await writeOutcome(resolved, bom, entry.ending ?? "\n", out);
    removeEdit(rollback, context); // consume only after success — a failed rollback stays retryable
    const callId = context?.call?.callId;
    const redo = reverseEdits(entry.edits);
    if (callId) recordEdit(callId, { path: entry.path, edits: redo, ending: entry.ending }, context); // the redo
    const suffix = callId ? ` Rollback id: ${callId} (reverses again).` : "";
    return {
      result: `Rolled back: restored ${entry.edits.length} block(s) in ${entry.path}.${suffix}`,
      display: unifiedPatch(entry.path, normalized, out),
    };
  });
}

/**
 * Edit a single file using exact text replacement.
 * @param {Object} args
 * @param {string} args.path - file path, inside the working folder
 * @param {Array<{oldText: string, newText: string}>} args.edits
 * @param {boolean} [args.ask] - on a content-policy violation, ask the
 *   user for permission (5-line preview) instead of refusing outright
 * @param {string} [args.rollback] - reverse a RECORDED edit by its
 *   tool call id (the path must match the record; edits are not needed)
 * @param {Object} [context] - harness tool context ({question, call})
 * @returns {Promise<{result: string, display: string}>}
 */
export async function edit({ path, edits, ask, rollback, matchAll } = {}, context) {
  // a FALSEY rollback ("" / null / false — a model that fills every
  // schema field with "no value") is ABSENT: a non-empty edits array
  // alongside an empty rollback string clearly means "nothing to roll
  // back", never an error
  if (rollback && rollback != ""&& rollback != "false") return rollbackEdit(rollback, path, context);
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new TypeError("Give one or more edits, each with oldText and newText.");
  }
  // The agent folder is cwd and Env.cwd is the enclosing project boundary.
  // A relative ../ may edit a project sibling, never a path outside Env.cwd.
  const writeCwd = context?.agent?.folder ?? context?.env?.cwd ?? context?.agent?.env?.cwd ?? process.cwd();
  const projectCwd = context?.env?.cwd ?? context?.agent?.env?.cwd ?? writeCwd;
  const contentCwd = projectCwd;
  // The same symbolic-link refusal write.js applies across the project.
  const resolved = await rejectSymlinkPath(resolveCwdPath(path, { cwd: writeCwd, boundary: projectCwd }), { cwd: projectCwd }); // filename guard
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
    const { out, matches } = applyEdits(normalized, edits, path, matchAll === true);
    await writeOutcome(resolved, bom, ending, out);
    // record under the tool call's id: `edit { path, rollback: "<id>" }`
    // reverses
    const callId = context?.call?.callId;
    if (callId) {
      // One record per MATCH (a matchAll edit writes several regions).
      // The offset is the match's position in the POST-edit text:
      // replacements before it shifted it by their length deltas.
      const recorded = matches.map((m, k) => ({
        oldText: edits[m.i].oldText,
        newText: m.newText,
        at: m.start + matches.slice(0, k).reduce((delta, p) => delta + p.newText.length - (p.end - p.start), 0),
      }));
      recordEdit(callId, { path, edits: recorded, ending }, context);
    }
    const suffix = callId ? ` Edit id: ${callId} (rollback with edit {path: "${path}", rollback: "${callId}"}).` : "";
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
      description: "Replace exact text in one file. Read the file first, then send oldText/newText pairs from its current content. Merge nearby or overlapping changes into one edit. Set matchAll: true to replace every occurrence of each oldText. To reverse an edit, pass the edit id returned after it as rollback.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit (relative to the working folder)" },
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
                  description: "The exact text to replace. Make it unique in the file and never overlap another edit\u2019s oldText.",
                },
                newText: { type: "string", description: "The replacement text." },
              },
              required: ["oldText", "newText"],
            },
          },
          ask: {
            type: "boolean",
            description:
              "Ask the user for permission, showing the offending lines, when a " +
              "newText names a path outside the working folder. Omit it to refuse " +
              "such edits outright.",
          },
          matchAll: {
            type: "boolean",
            description: "Replace every occurrence of each oldText. Omit it to require a unique match.",
          },
          rollback: {
            type: "string",
            description:
              "Reverse a recent edit by passing the edit id returned after it " +
              "succeeded. Pass the same path the edit targeted. The file " +
              "must still hold the replacement text at the edited positions; " +
              "if it does not, read the file and make a new targeted edit " +
              "instead.",
          },
        },
        anyOf: [
          { required: ["path", "edits"] },
          { required: ["path", "rollback"] }
        ]
      },
    },
  };
}
