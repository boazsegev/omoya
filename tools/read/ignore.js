/** Opt-in discovery filtering. Git publication exclusions are not relevance/access policy.
 * At each directory .gitignore precedes .ignore; deeper rules refine ancestors.
 * Direct files never load these rules. Ignored directories are pruned, like Git.
 * Auxiliary files use guarded no-follow regular-file opens and finite reads.
 */

import { toolRevision } from "../../lib/tool-runtime.js";
const revision = toolRevision();
import { join, relative, sep } from "node:path";
const { matchesGlob } = await import(`./glob.js?revision=${revision}`);
const { createReadState, openReadFile, readChunk, checkReadState } = await import(`./fs.js?revision=${revision}`);

/**
 * Well-known system / junk names — never listed, never searched (a
 * direct read still answers). `.git` sits here too: repository
 * internals are not project content (a `.ignore` could not even
 * express "any .git folder, anywhere" without a `**` pattern).
 */
export const SYSTEM_FILES = new Set([
  ".git", // repository internals — as if the folder never existed
  ".DS_Store", // macOS Finder
  ".AppleDouble", ".LSOverride", ".Spotlight-V100", ".Trashes",
  "Thumbs.db", "ehthumbs.db", "Desktop.ini", // Windows
  "$RECYCLE.BIN",
]);

/**
 * One parsed `.ignore` file: its rules are anchored at `base`, the
 * folder (relative to the read root, "" for the root itself) the
 * `.ignore` lives in.
 * @typedef {{base: string, rules: Array<{negated: boolean, dirOnly: boolean, anchored: boolean, pattern: string}>}} IgnoreFile
 */

/** Parse `.ignore` content into rules (later rules override earlier). */
export function parseIgnore(content, base) {
  const rules = [];
  for (const raw of content.split("\n")) {
    if (rules.length >= 4096) throw new Error("Ignore rules exceed 4096 per directory");
    if (raw.length > 4096) throw new Error("Ignore pattern exceeds 4096 characters");
    let line = raw.replace(/\r$/, "");
    while (line.endsWith(" ") && !line.endsWith("\\ ")) line = line.slice(0, -1);
    if (line === "" || line.startsWith("#")) continue;
    const escapedPrefix = line.startsWith("\\#") || line.startsWith("\\!");
    if (escapedPrefix) line = line.slice(1);
    let negated = false;
    if (!escapedPrefix && line.startsWith("!")) { negated = true; line = line.slice(1); }
    if (line === "") continue;
    let dirOnly = false;
    if (line.endsWith("/")) { dirOnly = true; line = line.slice(0, -1); }
    let anchored = false;
    if (line.startsWith("/")) { anchored = true; line = line.slice(1); }
    else if (line.includes("/")) anchored = true; // git: any slash anchors
    if (line === "") continue;
    rules.push({ negated, dirOnly, anchored, pattern: line.replace(/\\ /g, " ") });
  }
  return { base, rules };
}

/**
 * Does ONE rule match `rel` (a path relative to the read root)? A
 * rule naming a DIRECTORY covers everything under it: ignoring
 * `build/` hides `build/x/y.js` too, for both dirOnly and anchored
 * patterns and for bare basenames (the parts scan already sees every
 * ancestor segment of `sub`).
 */
function ruleMatches(rule, base, rel, isDir) {
  if (!rel.startsWith(base)) return false;
  const sub = rel.slice(base.length); // base is "" or "a/b/" — folder-relative
  const parts = sub.split("/");
  // every proper prefix of sub ("a", "a/b" for "a/b/c") — the path's
  // ancestor FOLDERS, which a directory pattern also excludes
  const ancestors = [];
  for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join("/"));
  if (rule.anchored) {
    // a slash-free anchored pattern is root-BASENAME semantics
    // (git's leading "/"), not a whole-path match: "/deep-root.txt"
    // names only the root file, never "sub/deep-root.txt"
    if (!rule.pattern.includes("/")) {
      const first = sub.split("/")[0];
      return matchesGlob(first, rule.pattern) && (!rule.dirOnly || isDir || sub.includes("/"));
    }
    if (matchesGlob(sub, rule.pattern)) return !rule.dirOnly || isDir;
    // A matched ancestor is a directory even without a trailing slash in the pattern.
    return ancestors.some((folder) => matchesGlob(folder, rule.pattern));
  }
  // no slash: the pattern matches any BASENAME below the .ignore
  // folder; for dirOnly, only ancestor segments (folders) count
  return parts.some((part, i) => matchesGlob(part, rule.pattern) && (!rule.dirOnly || i < parts.length - 1 || isDir));
}

/**
 * The ignore verdict of a stack of `.ignore` files (outer first) for
 * `rel`: true to ignore. Later files and later rules override earlier
 * ones — the LAST matching rule decides, `!` rules re-include.
 * @param {Array<IgnoreFile>} stack
 * @param {string} rel - path relative to the read root (files; folders end with "/")
 */
export function isIgnored(stack, rel, state) {
  const isDir = rel.endsWith("/");
  const path = isDir ? rel.slice(0, -1) : rel;
  let ignored = false;
  for (const file of stack) {
    const base = file.base === "" ? "" : `${file.base}/`;
    for (const rule of file.rules) {
      if (state) checkReadState(state);
      if (ruleMatches(rule, base, path, isDir)) ignored = !rule.negated;
    }
  }
  return ignored;
}

/**
 * A known system name in ANY segment of `rel`? (".DS_Store" matches
 * itself; ".git" also matches "sub/.git/config" — the whole folder is
 * treated as absent.)
 */
export function isSystemFile(rel) {
  return rel.split("/").some((part) => SYSTEM_FILES.has(part));
}

/** Opt-in ignore files: Git publication rules first, tool rules second. All auxiliary opens guarded. */
export async function loadIgnore(absFolder, relBase, state = createReadState()) {
  const rules = [];
  for (const name of [".gitignore", ".ignore"]) {
    let opened;
    try {
      opened = await openReadFile(join(absFolder, name), state);
      if (opened.metadata.size > 256 * 1024) throw new Error("Ignore file exceeds 256 KiB limit");
      const buffer = await readChunk(opened.handle, 0, opened.metadata.size, state);
      rules.push(...parseIgnore(buffer.toString("utf8"), relBase).rules);
      if (rules.length > 4096) throw new Error("Ignore rules exceed 4096 per directory");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally { await opened?.handle.close(); }
  }
  return rules.length ? { base: relBase, rules } : null;
}

/** Ancestor rules up to, but excluding, the explicitly selected directory. */
export async function ancestorIgnores(boundary, directory, state = createReadState()) {
  const rel = relative(boundary, directory);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Ignore ancestry escapes project boundary");
  const stack = [];
  let abs = boundary;
  let base = "";
  for (const part of rel.split(sep).filter(Boolean)) {
    const found = await loadIgnore(abs, base, state);
    if (found) stack.push(found);
    abs = join(abs, part);
    base = base ? `${base}/${part}` : part;
  }
  return stack;
}
