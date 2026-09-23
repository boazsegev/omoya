import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEVICE_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

function policyError(message) { return new Error(message); }

function escapesRoot(token, root) {
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("\\\\")) return true;
  if (/^~[\\/]/.test(token)) return true;
  const absolute = token.startsWith("/");
  const target = absolute ? resolve(token) : resolve(root, token);
  return target !== root && !target.startsWith(root + sep);
}

function isTraversalToken(token, root) {
  if (!token.includes("/") && !token.includes("\\")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || DEVICE_PATHS.has(token)) return false;
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("\\\\") || /^~[\\/]/.test(token)) return true;
  const value = token.replace(/\\([nrbtfav0\\'"$?])/g, "$1").replaceAll("\\", "/");
  return /[A-Za-z0-9]/.test(value) && escapesRoot(value, root);
}

function bareToken(raw) {
  return raw.replace(/^[\s"'`([{<]+/, "").replace(/[\s"'`)\]}>.,;:!?&|]+$/, "");
}

export function findTraversal(content, { cwd = process.cwd(), max = 5 } = {}) {
  const root = resolve(cwd);
  const found = [];
  for (const [index, text] of String(content).split("\n").entries()) {
    if (index === 0 && text.startsWith("#!")) continue;
    for (const raw of text.split(/\s+/)) {
      const token = bareToken(raw);
      if (token && isTraversalToken(token, root)) { found.push({ line: index + 1, token, text }); break; }
    }
    if (found.length >= Math.max(1, max)) break;
  }
  return found;
}

async function existingOutsidePath(token, cwd) {
  const root = resolve(cwd);
  const target = token.startsWith("~/") ? resolve(homedir(), token.slice(2)) : resolve(root, token);
  let actual;
  try { actual = await realpath(target); } catch { return false; }
  const rel = relative(root, actual);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

// A relative URL resolved against import.meta.url is source-file-relative,
// unlike a path in shell text. Its target cannot be determined from cwd, so
// the cwd-based content trip-wire must not classify it as an outside path.
function isImportMetaUrlPath(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`new\\s+URL\\(\\s*(["'])${escaped}\\1\\s*,\\s*import\\.meta\\.url\\s*\\)`).test(text);
}

/** Find only path-like content that resolves to an existing object outside cwd. */
export async function findWriteTraversal(content, { cwd = process.cwd(), max = 5 } = {}) {
  const found = [];
  for (const [index, text] of String(content).split("\n").entries()) {
    if (index === 0 && text.startsWith("#!")) continue;
    // A root marker starts a candidate only when it is not immediately
    // preceded by a path-segment character. Match the complete ~/ path;
    // never truncate it to the slash-prefixed suffix.
    for (const match of text.matchAll(/(?<![A-Za-z0-9._~-])(?:\.\.\/|~\/|\/)(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)/g)) {
      if (!isImportMetaUrlPath(text, match[0]) && await existingOutsidePath(match[0], cwd)) {
        found.push({ line: index + 1, token: match[0], text });
        break;
      }
    }
    if (found.length >= Math.max(1, max)) break;
  }
  return found;
}

export function traversalSnippet(content, line) {
  const lines = String(content).split("\n");
  return lines.slice(Math.max(0, line - 3), Math.min(lines.length, line + 2))
    .map((text, index) => `${index + Math.max(0, line - 3) + 1 === line ? ">" : " "} ${index + Math.max(0, line - 3) + 1}: ${text}`).join("\n");
}

function refusalText(path, violations, askable) {
  const first = violations[0];
  return `path traversal refused: "${path}" content line ${first.line} ("${first.token}") resolves to an existing path outside the working folder — remove the outside reference, keep every path inside the working folder${askable ? ", or call again with ask: true to request the user's permission." : "."}`;
}

export async function enforceContentPolicy({ path, content, ask = false, context, askable = true, cwd, lax = false } = {}) {
  const violations = lax ? await findWriteTraversal(content, { cwd }) : findTraversal(content, { cwd });
  if (violations.length === 0) return;
  const bridge = askable && typeof context?.question?.ask === "function" ? context.question.ask : null;
  if (ask !== true || bridge === null) throw policyError(refusalText(path, violations, askable));
  const preview = violations.map((item) => traversalSnippet(content, item.line)).join("\n\n");
  const answers = await bridge([{ question: `"${path}" contains an existing outside-tree path (line ${violations[0].line}: "${violations[0].token}"). Write anyway?`, header: "Path guard", options: [
    { label: "Refuse", description: "Do not write the outside reference.", preview },
    { label: "Allow write", description: `Write "${path}" with the outside reference.`, preview },
  ] }]);
  if (Array.isArray(answers) && answers[0]?.labels?.includes("Allow write")) return;
  const typed = typeof answers?.[0]?.text === "string" && answers[0].text.trim() ? `\nThe user refused with a custom answer:\n${answers[0].text.trim()}` : "";
  throw policyError(refusalText(path, violations, askable) + typed);
}

async function commandTokenViolation(value, root, boundary = root) {
  if (value === "" || value.includes("*")) return false; // globs carry no single path
  // Device files are not paths INTO the filesystem tree the guard
  // protects: the null/tty/std* devices name a kernel device, never an
  // outside working-folder object (mirrors isTraversalToken's carve-out).
  if (DEVICE_PATHS.has(value)) return false;
  const target = resolve(root, value);
  // Paths within the project boundary are permitted. This lets a command
  // started in an agent subfolder inspect and mutate project siblings with
  // ../; the OS sandbox enforces that same project-wide write boundary.
  const projectRel = relative(boundary, target);
  if (projectRel === "" || (!projectRel.startsWith("..") && !isAbsolute(projectRel))) return false;
  // OUTSIDE-root: only an EXISTING target violates ("../" tokens are
  // refused below by the walk, which always finds a real anchor).
  if (await existingOutsidePath(value, root)) return true;
  // Non-existent outside target: violate only when the token provably
  // names a REAL outside location. A "../" escape's anchor is the
  // working folder's own ancestry, which plainly exists — refuse it.
  // An absolute token's first segment names a well-known top-level
  // folder: an existing one (a system config or temp root) is a real
  // place — a write there is the planned outside mutation the guard
  // exists for; a non-existent first segment (a version or API-route
  // fragment) is the static guard's old false positive.
  if (value.includes("../")) return true;
  const segments = value.split("/").filter(Boolean);
  if (value.startsWith("/") && segments.length >= 2) {
    try { await stat(resolve("/", segments[0])); return true; } catch { /* fragment */ }
  }
  return false;
}

/**
 * The COMMAND traversal guard — the existence-based counterpart of the
 * write tool's content scan (findWriteTraversal). A candidate path
 * violates only when it names an EXISTING object outside the working
 * folder, plans a write under an existing outside folder, or spells an
 * escape with "../" — everything else (regex fragments, printf formats,
 * URL paths, version strings) runs; the OS write sandbox below it
 * denies the obfuscated escape a static check could never see.
 */
export async function findCommandTraversal(command, { cwd = process.cwd(), boundary = cwd, max = 5 } = {}) {
  const root = resolve(cwd);
  const limit = resolve(boundary);
  const found = [];
  for (const raw of String(command).split(/\s+/)) {
    const token = bareToken(raw).replace(/^[0-9]*[<>]+[<>]?/, "");
    const candidates = [token];
    const equal = token.indexOf("=");
    if (equal > 0) candidates.push(token.slice(equal + 1));
    for (const value of candidates) {
      if (await commandTokenViolation(value, root, limit)) { found.push({ token: value }); break; }
    }
    if (found.length >= Math.max(1, max)) break;
  }
  return found;
}
