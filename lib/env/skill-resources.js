/** Private, bounded resource overlay reads. Filesystem paths never enter errors. */
import { lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { discoverSkills } from "./registry.js";

const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

function resourcePath(path) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new TypeError("Invalid skill resource path: use a skill-relative file path");
  }
  if (path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid skill resource path: traversal is refused");
  }
  return path;
}

async function existingResource(directory, path) {
  let current = directory;
  for (const part of ["", ...path.split("/")]) {
    if (part) current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Resource symbolic links are refused");
  }
  return current;
}

async function boundedBytes(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Resource must be a regular file");
    if (info.size > MAX_RESOURCE_BYTES) throw new Error("Resource exceeds the 16 MiB limit");
    return await streamBytes(handle);
  } finally { await handle.close(); }
}

async function streamBytes(handle) {
  const chunks = [];
  let size = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    size += chunk.length;
    if (size > MAX_RESOURCE_BYTES) throw new Error("Resource exceeds the 16 MiB limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** List readable resource identifiers across all layers, without reading file contents. */
export async function listSkillResources(roots, name) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("Skill name must be a non-empty string");
  name = name.trim();
  const skill = discoverSkills(roots).get(name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  const candidates = new Set();
  for (const directory of skill.directories) await collectResources(directory, "", candidates);
  const available = [];
  for (const path of candidates) {
    for (const directory of [...skill.directories].reverse()) {
      try {
        const file = await existingResource(directory, path);
        if ((await lstat(file)).isFile()) available.push(path);
        break;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        break;
      }
    }
  }
  return available.sort((a, b) => a.localeCompare(b));
}

async function collectResources(directory, prefix, candidates) {
  let entries;
  try { entries = await readdir(join(directory, prefix), { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === "SKILL.md") continue;
    if (entry.isDirectory()) await collectResources(directory, path, candidates);
    else if (entry.isFile()) candidates.add(path);
  }
}

/** Read the last existing registered resource; invalid later files do not fall back. */
export async function readSkillResource(roots, name, path) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("Skill name must be a non-empty string");
  path = resourcePath(path);
  name = name.trim();
  const skill = discoverSkills(roots).get(name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  for (const directory of [...skill.directories].reverse()) {
    try { return await boundedBytes(await existingResource(directory, path)); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      const reason = error.code ? "Resource cannot be read" : error.message;
      throw new Error(`Skill resource ${name}/${path}: ${reason}`);
    }
  }
  throw new Error(`Skill resource not found: ${name}/${path}`);
}
