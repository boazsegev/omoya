/** TUI-only draft attachment syntax. Source paths are resolved by the local
 * terminal user, never through Agent's tool/workspace path boundary. */
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import Context from "../context.js";

// The one canonical draft form. The path is deliberately raw/unescaped:
// {{@/path/to/file}}.
const TOKEN = /\{\{@([^\}\r\n]+)\}\}/g;

/** A conservative terminal-drop heuristic. Bracketed paste cannot identify a
 * drag drop, so only a whole, single absolute pathname is converted. Accept
 * common shell quoting/escaping and file: URLs; ordinary prose is untouched. */
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

/** Split a draft left-to-right, retaining literal malformed markers as text. */
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

/** Read every selected local file before creating/enqueueing one ordered turn.
 * Absolute paths are allowed here because this is an explicit local UI action;
 * only bytes and a basename enter Context. */
export async function attachmentMessage(text) {
  const content = [];
  for (const part of attachmentParts(text)) {
    if (part.type === "text") { if (part.text) content.push(Context.textContent(part.text)); continue; }
    const bytes = await readFile(part.path);
    const name = basename(part.path);
    content.push(Context.binaryContent(name, bytes));
  }
  return Context.userMessage(content);
}

export function hasAttachment(text) { return /\{\{@[^\}\r\n]+\}\}/.test(text); }

function isFolder(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isInside(path, cwd) {
  const rel = relative(resolve(cwd), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
