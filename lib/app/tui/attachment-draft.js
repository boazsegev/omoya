/** TUI-only draft attachment syntax. Source paths are resolved by the local
 * terminal user, never through Agent's tool/workspace path boundary. */
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import Context from "../../context.js";

// The one canonical draft form. The path is deliberately raw/unescaped:
// {{@/path/to/file}}.
const TOKEN = /\{\{@([^\}\r\n]+)\}\}/g;

/** Convert a whole terminal-pasted absolute path into draft attachment syntax.
 * Accepts shell-quoted/escaped paths and file: URLs; leaves ordinary prose,
 * multiline input, and non-absolute paths unchanged. An absolute directory
 * inside `cwd` is returned as a quoted project-relative path instead.
 *
 * @param {*} text Pasted value; nullish values are tested as an empty string.
 * @param {object} [options={}] Paste context options.
 * @param {string} [options.cwd] Current working directory, used to recognize
 *   project-internal directory drops.
 * @returns {*} Original input when it is not a convertible path; otherwise a
 *   `{{@path}}` attachment token or a backtick-quoted project-relative path.
 * @throws May propagate path/stat-related errors not caught by the directory
 *   checks, or URL construction errors outside the guarded file URL parsing.
 */
export function attachmentPaste(text, { cwd } = {}) {
  let path = String(text ?? "").trim();
  if (path === "" || /[\r\n]/.test(path)) return text;
  if (path.startsWith("file://")) {
    try { path = decodeURIComponent(new URL(path).pathname); } catch { return text; }
  } else if ((path.startsWith("'") && path.endsWith("'")) || (path.startsWith('"') && path.endsWith('"'))) {
    path = path.slice(1, -1);
  } else {
    // Ghostty/Kitty paste a shell-escaped path, e.g. /a/my\ file — and a
    // terminal drag can escape far more than spaces (\#, \;, \&, ...). A
    // whitelist can never be complete, and a backslash is never legitimate in
    // a dropped path: unescape EVERY \x → x.
    path = path.replace(/\\(.)/g, "$1");
  }
  if (!isAbsolute(path)) return text;
  // A directory dropped from inside the project is usually navigation/prose,
  // not a model attachment. Keep it editable and project-relative.
  if (typeof cwd === "string" && cwd !== "" && isFolder(path) && isInside(path, cwd)) {
    const projectPath = relative(resolve(cwd), resolve(path)).split(sep).join("/");
    return `\`${projectPath === "" ? "." : `./${projectPath}`}\``;
  }
  return `{{@${path}}}`;
}

/** Split a draft left-to-right into text and attachment parts. Recognized
 * tokens are emitted as file parts with trimmed paths; all intervening text,
 * including malformed markers, remains literal text.
 *
 * @param {string} text Draft string to parse.
 * @returns {Array<{type: "text", text: string} | {type: "file", path: string}>}
 *   Ordered parts; an empty draft produces one empty text part.
 */
export function attachmentParts(text) {
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > cursor) parts.push({ type: "text", text: text.slice(cursor, match.index) });
    parts.push({ type: "file", path: match[1].trim() });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length || parts.length === 0) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
}

/** Read each attachment in a draft and construct one ordered user message.
 * Absolute paths are allowed for this explicit local UI action; Context receives
 * each file's basename and bytes, interleaved with draft text.
 *
 * @param {string} text Draft containing text and optional attachment tokens.
 * @returns {Promise<*>} Promise for the Context user message.
 * @throws Rejects if any selected file cannot be read; no message is returned.
 */
export async function attachmentMessage(text) {
  const content = [];
  for (const part of attachmentParts(text)) {
    if (part.type === "text") { if (part.text) content.push(Context.contentText(part.text)); continue; }
    const bytes = await readFile(part.path);
    const name = basename(part.path);
    content.push(Context.contentBinary(name, bytes));
  }
  return Context.messageUser(content);
}

/** Get attachment chip metadata for a draft, memoized by exact draft text.
 * Each chip contains a basename and either file size or `missing: true`; the
 * filesystem is stat'ed only on a cache miss.
 *
 * @param {string} text Draft to inspect.
 * @returns {Array<{name: string, size: number} | {name: string, missing: true}>}
 *   Cached chip list (the same array reference is returned for repeated text).
 * @effects Updates the module-level one-entry memo and may synchronously stat
 *   attachment paths; missing/non-file paths are represented, not thrown.
 */
let chipsMemo = { text: null, chips: [] };
export function attachmentChips(text) {
  if (chipsMemo.text === text) return chipsMemo.chips;
  const chips = hasAttachment(text) ? attachmentParts(text).filter((part) => part.type === "file").map((part) => {
    try {
      const info = statSync(part.path);
      return info.isFile() ? { name: basename(part.path), size: info.size } : { name: basename(part.path), missing: true };
    } catch { return { name: basename(part.path), missing: true }; }
  }) : [];
  chipsMemo = { text, chips };
  return chips;
}

/** Test whether a draft contains at least one syntactically recognized token.
 *
 * @param {string} text Draft string to test.
 * @returns {boolean} True when an attachment token is present.
 */
export function hasAttachment(text) { return /\{\{@[^\}\r\n]+\}\}/.test(text); }

/** Check synchronously whether a path currently names a directory.
 *
 * @param {string} path Filesystem path to inspect.
 * @returns {boolean} True for a directory; false when stat fails or it is not one.
 * @effects Performs a synchronous filesystem stat; filesystem errors are caught.
 */
function isFolder(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Determine whether a resolved path is equal to or beneath a working directory.
 *
 * @param {string} path Candidate path.
 * @param {string} cwd Directory used as the containment root.
 * @returns {boolean} True when the resolved path is inside or equal to `cwd`.
 */
function isInside(path, cwd) {
  const rel = relative(resolve(cwd), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
