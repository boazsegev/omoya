/**
 * lib/env/registry.js — skill/prompt discovery (private to Env).
 *
 * Conventions (mirrors the sibling `core` package's registry so existing
 * skill/prompt files need no changes):
 *   skills:  <root>/<name>/SKILL.md
 *   prompts: <root>/<name>.md
 * Both are Markdown with a YAML-frontmatter subset (name/description plus
 * whatever else a file wants) over a body. Roots ACCUMULATE (the package
 * folder's own `skills`/`prompts`, configured/environment roots, and
 * namespaced project folders — see Env.skillRoots/defaultPromptRoots)
 * and are scanned in that order:
 *   - skills OVERRIDE: later same-name bodies replace earlier bodies.
 *     {{name}} / {{name[L1-L2]}} explicitly include effective bodies;
 *     a self reference includes the previous definition. Resource files
 *     overlay independently: the last existing match wins.
 *   - prompts OVERRIDE: a name repeated in a later root replaces the
 *     earlier one outright (a prompt is a single template, not layered
 *     rules — a project's own copy is meant to supersede the shared one).
 */

import { join } from "node:path";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { composeSkills } from "./skill-references.js";

/**
 * Parse the YAML-frontmatter subset used by skills and prompts:
 * `key: value`, single/double quoted values, folded (`>`, `>-`, `>+`) and
 * literal (`|`, `|-`, `|+`) block scalars, and plain multiline
 * continuations (indented lines following `key:` with no value).
 * @param {string} text Frontmatter-wrapped or plain Markdown text to parse.
 * @returns {{meta: Object, body: string}} Parsed metadata and trimmed body;
 *   absent/invalid frontmatter yields empty metadata and the trimmed input.
 */
export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { meta: {}, body: text.trim() };
  const lines = match[1].split(/\r?\n/);
  const meta = {};
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    if (!kv) {
      i++;
      continue;
    }
    const [, key, raw = ""] = kv;
    if (/^[>|][-+]?$/.test(raw)) {
      const block = [];
      i++;
      while (i < lines.length && (/^\s+\S/.test(lines[i]) || lines[i].trim() === "")) {
        block.push(lines[i].replace(/^\s+/, ""));
        i++;
      }
      while (block.length && block[block.length - 1] === "") block.pop();
      if (raw[0] === "|") {
        meta[key] = block.join("\n");
      } else {
        let out = "";
        for (const line of block) {
          if (line === "") out += "\n";
          else out += out && !out.endsWith("\n") ? ` ${line}` : line;
        }
        meta[key] = out;
      }
      continue;
    }
    if (raw === "") {
      const cont = [];
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        cont.push(lines[j].trim());
        j++;
      }
      meta[key] = cont.join(" ");
      i = j;
      continue;
    }
    meta[key] = raw.replace(/^"(?:[^"\\]|\\.)*"$/, (s) => s.slice(1, -1)).replace(/^'.*'$/, (s) => s.slice(1, -1));
    i++;
  }
  return { meta, body: match[2].trim() };
}

/**
 * Read a UTF-8 file and parse its frontmatter.
 * @param {string} file Path to the Markdown file.
 * @returns {{meta: Object, body: string}|null} Parsed content, or `null` if
 *   reading or parsing throws. Filesystem errors are suppressed.
 */
function readParsed(file) {
  try {
    return parseFrontmatter(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * List directory entries sorted by name.
 * @param {string} dir Directory path to read.
 * @returns {import('node:fs').Dirent[]} Sorted entries, or an empty array if
 *   reading the directory throws. Filesystem errors are suppressed.
 */
function sortedDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Discover private definition chains and resource directories in layer order. */
export function discoverSkills(roots) {
  const entries = new Map();
  for (const root of roots ?? []) {
    if (!root || !existsSync(root)) continue;
    for (const dirent of sortedDirs(root)) {
      if (!dirent.isDirectory()) continue;
      const file = join(root, dirent.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const parsed = readParsed(file);
      if (!parsed) continue;
      const name = parsed.meta.name?.trim() || dirent.name;
      const existing = entries.get(name);
      entries.set(name, {
        name,
        description: parsed.meta.description || existing?.description || "",
        source: root,
        file,
        parsed,
        previous: existing,
        directories: [...(existing?.directories ?? []), join(root, dirent.name)],
      });
    }
  }
  return entries;
}

/** Discover and compose last-wins skills with explicit body references. */
export function listSkills(roots) {
  return composeSkills(discoverSkills(roots));
}

/**
 * Merged prompt registry over ACCUMULATED roots, scanned in order — a
 * name repeated in a later root OVERRIDES the earlier one.
 * @param {string[]} [roots=[]] Roots to scan in order; nullish input is
 *   treated as an empty list. Falsy and nonexistent roots are skipped.
 * @returns {Map<string, {name: string, description: string, source: string, file: string, parsed: {meta: object, body: string}}>} Prompts keyed by name, with later same-name entries replacing earlier ones.
 */
export function listPrompts(roots) {
  const entries = new Map();
  for (const root of roots ?? []) {
    if (!root || !existsSync(root)) continue;
    for (const dirent of sortedDirs(root)) {
      if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
      const file = join(root, dirent.name);
      const parsed = readParsed(file);
      const name = parsed?.meta?.name?.trim() || dirent.name.replace(/\.md$/, "");
      entries.set(name, { name, description: parsed?.meta?.description ?? "", source: root, file, parsed });
    }
  }
  return entries;
}
