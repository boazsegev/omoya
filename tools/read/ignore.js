/**
 * tools/read/ignore.js — INTERNAL helper of the `read` tool (never a
 * tool itself: the scan is not recursive). Decides which files the
 * read tool treats as NOT EXISTING at all (they are skipped in folder
 * listings and searches, and a direct read reports ENOENT):
 *
 *   1. well-known system / junk names (an exact basname set, matched
 *      against EVERY path segment — a `.git` folder anywhere hides
 *      everything under it);
 *   2. files matched by a `.ignore` file — same rule syntax as
 *      `.gitignore`, but ONLY `.ignore` is consulted (`.gitignore`
 *      stays a git concern: the tool must not hide a tracked file).
 *
 * `.ignore` rules are collected from every visited folder while a
 * listing walks down (nested `.ignore` files refine deeper paths,
 * a `!` rule re-includes what an outer rule excluded) and, for a
 * direct file read, from every folder from the read boundary down to
 * the file. Matching is gitignore-like: blank lines and `#` comments
 * are skipped, `dir/` matches folders only, a pattern without `/`
 * matches any basename, a leading `/` anchors the pattern to the
 * `.ignore` file's own folder, and `*`, `?`, `**`, `{a,b}` globs
 * apply. A pattern may match a DIRECTORY anywhere above the path —
 * excluding `build/` hides `build/x/y.js` too.
 */

import { readFile } from "node:fs/promises";
import { matchesGlob } from "./glob.js";

/**
 * Well-known system / junk names — never shown, never searched, never
 * directly readable. `.git` sits here too: repository internals are
 * not project content (a `.ignore` could not even express "any .git
 * folder, anywhere" without a `**` pattern).
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
    let line = raw.trimEnd(); // trailing spaces/CR are never meaningful
    if (line === "" || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) { negated = true; line = line.slice(1); }
    if (line === "") continue;
    let dirOnly = false;
    if (line.endsWith("/")) { dirOnly = true; line = line.slice(0, -1); }
    let anchored = false;
    if (line.startsWith("/")) { anchored = true; line = line.slice(1); }
    else if (line.includes("/")) anchored = true; // git: any slash anchors
    if (line === "") continue;
    rules.push({ negated, dirOnly, anchored, pattern: line });
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
      if (sub.includes("/")) return false;
      return matchesGlob(sub, rule.pattern) && (!rule.dirOnly || isDir);
    }
    if (matchesGlob(sub, rule.pattern)) return !rule.dirOnly || isDir;
    // only a directory pattern also covers everything UNDER it
    return rule.dirOnly && ancestors.some((folder) => matchesGlob(folder, rule.pattern));
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
export function isIgnored(stack, rel) {
  const isDir = rel.endsWith("/");
  const path = isDir ? rel.slice(0, -1) : rel;
  let ignored = false;
  for (const file of stack) {
    const base = file.base === "" ? "" : `${file.base}/`;
    for (const rule of file.rules) {
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

/** Load the `.ignore` of ONE folder, if it exists. */
export async function loadIgnore(absFolder, relBase) {
  try {
    const content = await readFile(`${absFolder}/.ignore`, "utf8");
    return parseIgnore(content, relBase);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * The `.ignore` stack of every folder from the read boundary down to
 * `rel`'s folder — the ancestors a DIRECT file read must consult even
 * though no listing walked through them.
 * @param {string} boundary - absolute read boundary (env cwd)
 * @param {string} absFile - absolute path of the file being read
 */
export async function ancestorIgnores(boundary, absFile) {
  if (!absFile.startsWith(boundary)) return [];
  const chain = absFile.slice(boundary.length).split("/").filter(Boolean).slice(0, -1);
  const stack = [];
  let abs = boundary;
  let rel = "";
  for (const folder of chain) {
    const found = await loadIgnore(abs, rel);
    if (found) stack.push(found);
    abs = `${abs}/${folder}`;
    rel = rel === "" ? folder : `${rel}/${folder}`;
  }
  return stack.concat((await loadIgnore(abs, rel)) ?? []);
}
