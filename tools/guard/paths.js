import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEVICE_PATHS = new Set(["null", "stdin", "stdout", "stderr", "tty", "zero", "full", "random", "urandom"].map((name) => ["", "dev", name].join("/")));
const TEMP_ROOTS = new Set([["", "tmp"], ["", "var", "tmp"], ["", "private", "tmp"], ["", "private", "var", "tmp"]].map((parts) => parts.join("/")));

function isDescriptorPath(target) {
  const parts = target.split("/");
  if (!/^\d+$/.test(parts.at(-1))) return false;
  return parts.slice(0, -1).join("/") === ["", "dev", "fd"].join("/") || parts.slice(0, -1).join("/") === ["", "proc", "self", "fd"].join("/");
}

/** Trip-wire exceptions only; filesystem destination guards and the OS jail still apply. */
function isDevelopmentPath(token, cwd) {
  if (!isAbsolute(token)) return false;
  const target = resolve(token);
  if (DEVICE_PATHS.has(target) || isDescriptorPath(target)) return true;
  // Projects can themselves live under a temporary root. Do not exempt their
  // existing absolute references just because a temp directory is an ancestor.
  const projectRel = relative(resolve(cwd), target);
  if (projectRel !== ".." && !projectRel.startsWith(`..${sep}`) && !isAbsolute(projectRel)) return false;
  return [...TEMP_ROOTS, resolve(tmpdir())].some((root) => target === root || target.startsWith(`${root}${sep}`));
}

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
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || isDevelopmentPath(token, root)) return false;
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("\\\\") || /^~[\\/]/.test(token)) return true;
  const value = token.replace(/\\([nrbtfav0\\'"$?])/g, "$1").replaceAll("\\", "/");
  return /[A-Za-z0-9]/.test(value) && escapesRoot(value, root);
}

function bareToken(raw) {
  return raw.replace(/^[\s"'`([{<]+/, "").replace(/[\s"'`)\]}>.,;:!?&|]+$/, "");
}

function pathTokens(text) {
  // Preserve quoted path arguments with spaces without claiming shell parsing.
  return String(text).match(/(?:[^\s"'`]+|"[^"]*"|'[^']*'|`[^`]*`)+/g) ?? [];
}

export function findTraversal(content, { cwd = process.cwd(), max = 5 } = {}) {
  const root = resolve(cwd);
  const found = [];
  for (const [index, text] of String(content).split("\n").entries()) {
    if (index === 0 && text.startsWith("#!")) continue;
    for (const raw of pathTokens(text)) {
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

function* contentPaths(text) {
  // Keep quoted paths whole: checking a truncated ancestor would reject a
  // nonexistent filename merely because its parent exists (especially spaces).
  const pattern = /(["'`])((?:\.\.\/|~\/|\/)[^"'`\r\n]+)\1|(?<![A-Za-z0-9._~:/-])(?:\.\.\/|~\/|\/)(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)/g;
  for (const match of text.matchAll(pattern)) yield match[2] ?? match[0];
}

async function contentViolation(token, cwd) {
  if (await existingOutsidePath(token, cwd)) return "outside";
  if (!isAbsolute(token)) return null;
  try {
    const info = await stat(token);
    return info.isFile() || info.isDirectory() ? "absolute" : null;
  } catch { return null; }
}

/** Weak content trip-wire: existing outside references or existing absolute project references. */
export async function findWriteTraversal(content, { cwd = process.cwd(), max = 5 } = {}) {
  const found = [];
  for (const [index, text] of String(content).split("\n").entries()) {
    if (index === 0 && text.startsWith("#!")) continue;
    for (const token of contentPaths(text)) {
      if (isDevelopmentPath(token, cwd ?? process.cwd()) || (!isAbsolute(token) && isImportMetaUrlPath(text, token))) continue;
      const kind = await contentViolation(token, cwd);
      if (kind) { found.push({ line: index + 1, token, text, kind }); break; }
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
  const detail = first.kind === "absolute"
    ? "is an absolute reference to an existing project path — use a relative reference"
    : "resolves to an existing path outside the working folder — remove the outside reference, keep every path inside the working folder";
  return `path traversal refused: "${path}" content line ${first.line} ("${first.token}") ${detail}${askable ? ", or call again with ask: true to request the user's permission." : "."}`;
}

export async function enforceContentPolicy({ path, content, ask = false, context, askable = true, cwd, lax = false } = {}) {
  const violations = lax ? await findWriteTraversal(content, { cwd }) : findTraversal(content, { cwd });
  if (violations.length === 0) return;
  const bridge = askable && typeof context?.question?.ask === "function" ? context.question.ask : null;
  if (ask !== true || bridge === null) throw policyError(refusalText(path, violations, askable));
  const preview = violations.map((item) => traversalSnippet(content, item.line)).join("\n\n");
  const reference = violations[0].kind === "absolute" ? "absolute project reference" : "existing outside-tree path";
  const answers = await bridge([{ question: `"${path}" contains an ${reference} (line ${violations[0].line}: "${violations[0].token}"). Write anyway?`, header: "Path guard", options: [
    { label: "Refuse", description: "Do not write the flagged reference.", preview },
    { label: "Allow write", description: `Write "${path}" with the flagged reference.`, preview },
  ] }]);
  if (Array.isArray(answers) && answers[0]?.labels?.includes("Allow write")) return;
  const typed = typeof answers?.[0]?.text === "string" && answers[0].text.trim() ? `\nThe user refused with a custom answer:\n${answers[0].text.trim()}` : "";
  throw policyError(refusalText(path, violations, askable) + typed);
}

async function commandTokenViolation(value, root, boundary = root) {
  if (value === "" || value.includes("*")) return false; // globs carry no single path
  // Development conventions are exempt from the trip-wire, not the kernel jail.
  if (isDevelopmentPath(value, root)) return false;
  const target = resolve(root, value);
  // Visible paths within either tree are permitted for reading. The OS
  // sandbox, not this shell scanner, restricts writes to the Agent folder.
  const inside = (folder) => {
    const rel = relative(folder, target);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (inside(root) || inside(boundary)) return false;
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
 * violates only when it names an EXISTING object outside both the Agent
 * and Env project trees, plans a write under an existing outside folder,
 * or spells an escape with "../" — everything else (regex fragments, printf formats,
 * URL paths, version strings) runs; the OS write sandbox below it
 * denies the obfuscated escape a static check could never see.
 */
export async function findCommandTraversal(command, { cwd = process.cwd(), boundary = cwd, max = 5 } = {}) {
  const root = resolve(cwd);
  const limit = resolve(boundary);
  const found = [];
  for (const raw of pathTokens(command)) {
    const token = bareToken(raw).replace(/^[0-9]*[<>]+[<>]?/, "");
    const candidates = [token];
    const equal = token.indexOf("=");
    if (equal > 0) candidates.push(bareToken(token.slice(equal + 1)));
    for (const value of candidates) {
      if (await commandTokenViolation(value, root, limit)) { found.push({ token: value }); break; }
    }
    if (found.length >= Math.max(1, max)) break;
  }
  return found;
}
