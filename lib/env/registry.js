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
 * namespaced project folders — see Env.defaultSkillRoots/defaultPromptRoots)
 * and are scanned in that order:
 *   - skills EXTEND: a name repeated in a later root concatenates its body
 *     onto the earlier one (so a project's own `skills/core/SKILL.md`
 *     adds to, never replaces, the package's) — descriptions/meta merge,
 *     later non-empty values win, sources join with "+".
 *   - prompts OVERRIDE: a name repeated in a later root replaces the
 *     earlier one outright (a prompt is a single template, not layered
 *     rules — a project's own copy is meant to supersede the shared one).
 */

import { join } from "node:path";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

/**
 * Parse the YAML-frontmatter subset used by skills and prompts:
 * `key: value`, single/double quoted values, folded (`>`, `>-`, `>+`) and
 * literal (`|`, `|-`, `|+`) block scalars, and plain multiline
 * continuations (indented lines following `key:` with no value).
 * @param {string} text
 * @returns {{meta: Object, body: string}}
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

function readParsed(file) {
  try {
    return parseFrontmatter(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function readParsedAsync(file) {
  try {
    return parseFrontmatter(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function sortedDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Merged skill registry over ACCUMULATED roots, scanned in order —
 * same-named entries EXTEND (concatenate), never replace.
 * @param {string[]} roots
 * @returns {Map<string, {name: string, description: string, source: string, file: string, parsed: {meta: object, body: string}}>}
 */
export function listSkills(roots) {
  const entries = new Map();
  for (const root of roots ?? []) {
    if (!root || !existsSync(root)) continue;
    for (const dirent of sortedDirs(root)) {
      if (!dirent.isDirectory()) continue;
      const file = join(root, dirent.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const parsed = readParsed(file);
      const name = parsed?.meta?.name?.trim() || dirent.name;
      const description = parsed?.meta?.description ?? "";
      const existing = entries.get(name);
      if (!existing) {
        entries.set(name, { name, description, source: root, file, parsed });
        continue;
      }
      const body = [existing.parsed?.body, parsed?.body].filter(Boolean).join("\n\n");
      entries.set(name, {
        name,
        description: description || existing.description,
        source: `${existing.source}+${root}`,
        file,
        parsed: { meta: { ...existing.parsed?.meta, ...parsed?.meta }, body },
      });
    }
  }
  return entries;
}

/**
 * Merged prompt registry over ACCUMULATED roots, scanned in order — a
 * name repeated in a later root OVERRIDES the earlier one.
 * @param {string[]} roots
 * @returns {Map<string, {name: string, description: string, source: string, file: string, parsed: {meta: object, body: string}}>}
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

/** Async counterpart of listPrompts(), preserving root-order overrides. */
export async function listPromptsAsync(roots) {
  const entries = new Map();
  for (const root of roots ?? []) {
    if (!root) continue;
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
      const file = join(root, dirent.name);
      const parsed = await readParsedAsync(file);
      const name = parsed?.meta?.name?.trim() || dirent.name.replace(/\.md$/, "");
      entries.set(name, { name, description: parsed?.meta?.description ?? "", source: root, file, parsed });
    }
  }
  return entries;
}
