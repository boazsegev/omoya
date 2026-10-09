/** Skill-overlay or permitted project resources; paths and filesystem errors stay logical. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import Env from "../lib/env.js";
import { requireRequest, projectFolder, projectListing } from "./request/common.js";
import { matchesGlob, validateGlob } from "./read/glob.js";
import { resolveCwdPath, rejectSymlinkPath, relativeCwdPath } from "./guard/resolve.js";
import { enforceContentPolicy } from "./guard/paths.js";

const TEXT_LIMIT = 128 * 1024;
const FILE_LIMIT = 16 * 1024 * 1024;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const emptyOption = (value) => value === undefined || value === null || value === "" || typeof value === "boolean" || value === 0 || value === -1 || (Array.isArray(value) && value.length === 0);
const hasTarget = (args) => !emptyOption(args?.target);

/** Normalize optional placeholders once; target selects copying regardless of list. */
function query({ name, path, list, target } = {}) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("Resource name must be a non-empty string");
  if (typeof list !== "boolean" && !emptyOption(list)) throw new TypeError("Resource list must be a boolean");
  if (emptyOption(target)) target = undefined;
  if (target !== undefined && typeof target !== "string") throw new TypeError("Resource target must be a path string");
  return { name: name.trim(), path: sourcePath(emptyOption(path) ? undefined : path, { root: true, glob: true }), list: list === true, target };
}

function sourcePath(path, { root = false, glob = false } = {}) {
  if (root && (path === undefined || path === "" || path === ".")) return "";
  if (root && typeof path === "string" && path.endsWith("/") && path !== "/") path = path.slice(0, -1);
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid resource path: traversal or absolute paths are refused");
  }
  if (glob) validateGlob(path);
  return path;
}
function globPath(path) { return /[*?{]/.test(path); }
function label(path) { return path || "."; }
function missing(error) { return error?.code === "ENOENT" || error?.code === "ENOTDIR"; }

/** Inspect each observed component without following symlinks. Null means absent. */
async function inspect(root, path) {
  let file = root;
  for (const part of ["", ...path.split("/").filter(Boolean)]) {
    if (part) file = join(file, part);
    let info;
    try { info = await lstat(file); }
    catch (error) { if (missing(error)) return null; throw new Error("Resource cannot be inspected"); }
    if (info.isSymbolicLink()) throw new Error("Resource symbolic links are refused");
    if (!info.isFile() && !info.isDirectory()) throw new Error("Resource must be a regular file or folder");
  }
  return { file, info: await lstat(file) };
}

function source(name, folder, directories) {
  const layers = directories ? [...directories].reverse() : [folder];
  const skill = Boolean(directories);
  return {
    title: `${skill ? "skill" : "project"} ${name}`,
    async entry(path) {
      if (skill && path === "SKILL.md") return null;
      for (const root of layers) {
        const item = await inspect(root, path);
        if (item) return item;
      }
      return null;
    },
    async entries(path, strict = false) {
      const names = new Map();
      for (const root of layers) {
        const folder = await inspect(root, path);
        if (!folder) continue;
        if (!folder.info.isDirectory()) throw new Error("Resource folder is not a directory");
        let children;
        try { children = await readdir(folder.file, { withFileTypes: true }); }
        catch { throw new Error("Resource folder cannot be listed"); }
        for (const child of children) {
          if (skill && !path && child.name === "SKILL.md") continue;
          if (names.has(child.name)) continue;
          // A symlink in an overlay masks an earlier entry; do not silently copy it.
          if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) {
            if (strict) throw new Error(child.isSymbolicLink() ? "Resource symbolic links are refused" : "Resource must be a regular file or folder");
            names.set(child.name, { path: path ? `${path}/${child.name}` : child.name, kind: "invalid" });
            continue;
          }
          const childPath = path ? `${path}/${child.name}` : child.name;
          const item = await inspect(root, childPath);
          if (item) names.set(child.name, { path: childPath, kind: item.info.isDirectory() ? "folder" : "file" });
        }
      }
      return [...names.values()].filter((item) => item.kind !== "invalid").sort((a, b) => compare(a.path, b.path));
    },
  };
}

function text(bytes) {
  if (bytes.length > TEXT_LIMIT) throw new Error("Resource text exceeds 128 KiB; specify target to save the complete file");
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (value.includes("\0")) throw new Error("binary");
    return value;
  } catch { throw new Error("Resource is binary; specify target to save its exact bytes"); }
}

async function bytes(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Resource must be a regular file");
    if (info.size > FILE_LIMIT) throw new Error("Resource exceeds the 16 MiB limit");
    const chunks = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > FILE_LIMIT) throw new Error("Resource exceeds the 16 MiB limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error.code) throw new Error("Resource cannot be read");
    throw error;
  } finally { await handle?.close(); }
}

async function pathsForGlob(sourceRoot, pattern) {
  const found = [];
  async function walk(path) {
    for (const child of await sourceRoot.entries(path, true)) {
      if (matchesGlob(child.path, pattern)) found.push(child.path);
      if (child.kind === "folder") await walk(child.path);
    }
  }
  await walk("");
  const selected = found.filter((path) => !found.some((parent) => parent !== path && path.startsWith(`${parent}/`)));
  if (!selected.length) throw new Error(`No resources match: ${pattern}`);
  return selected;
}

function copyName(path, index, folder) {
  const extension = folder ? "" : extname(path);
  return `${path.slice(0, path.length - extension.length)} ${String(index).padStart(3, "0")}${extension}`;
}
async function targetInfo(path, cwd) {
  await rejectSymlinkPath(path, { cwd });
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Resource target symbolic links are refused");
    if (!info.isFile() && !info.isDirectory()) throw new Error("Resource target must be a regular file or folder");
    return info;
  } catch (error) { if (missing(error)) return null; if (error.code) throw new Error("Resource target cannot be inspected"); throw error; }
}
async function freeName(path, cwd, sourceIsFolder) {
  if (!await targetInfo(path, cwd)) return { path };
  for (let n = 2; ; n++) {
    const copy = copyName(path, n, sourceIsFolder);
    if (!await targetInfo(copy, cwd)) return { path: copy, existing: path };
  }
}
async function createFolder(path, cwd) {
  await rejectSymlinkPath(path, { cwd });
  await mkdir(dirname(path), { recursive: true });
  await rejectSymlinkPath(path, { cwd });
  await mkdir(path);
}
/** Snapshot selected paths before writes so a project copy cannot traverse its own output. */
async function sourceTree(sourceRoot, path) {
  const item = await sourceRoot.entry(path);
  if (!item) throw new Error(`Resource not found: ${label(path)}`);
  const tree = { path, folder: item.info.isDirectory(), children: [] };
  if (tree.folder) {
    for (const child of await sourceRoot.entries(path, true)) tree.children.push(await sourceTree(sourceRoot, child.path));
  }
  return tree;
}
async function copyEntry(tree, destination, options) {
  const { sourceRoot, cwd, context, reports } = options;
  const item = await sourceRoot.entry(tree.path);
  if (!item || item.info.isDirectory() !== tree.folder) throw new Error("Resource changed during copying");
  const { path, existing } = await freeName(destination, cwd, tree.folder);
  const shown = relativeCwdPath(path, { cwd });
  if (existing) reports.push(`${relativeCwdPath(existing, { cwd })} existed; saved as ${shown}`);
  if (tree.folder) {
    await createFolder(path, cwd);
    for (const child of tree.children) await copyEntry(child, join(path, basename(child.path)), options);
  } else {
    const content = await bytes(item.file);
    await enforceContentPolicy({ path: shown, content: content.toString("utf8"), context, cwd, lax: true });
    await mkdir(dirname(path), { recursive: true });
    await rejectSymlinkPath(path, { cwd });
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      await handle.writeFile(content);
    } catch (error) {
      if (handle) await unlink(path).catch(() => {});
      throw error.code ? new Error("Resource target could not be written") : error;
    } finally { await handle?.close(); }
  }
  return shown;
}

/**
 * Read/list a skill overlay, falling back per path to a permitted named project.
 * @param {{name: string, path?: string, list?: boolean, target?: string}} args
 * Relative path or glob; omission selects the root. Without target, folders/globs
 * list automatically; list also lists a file's name. A target copies the selected
 * resources regardless of list, never overwriting existing entries (numbered copies).
 * Inputs are not mutated or retained. Reads are idempotent; repeated copies create
 * new numbered entries. Source files are limited to 16 MiB (text reads: 128 KiB).
 * @param {object} context Borrowed Env/Agent and permission capabilities.
 * @returns {Promise<string>} Source-labelled text, listing or copy destinations.
 * @throws {Error} Invalid/unsafe paths, missing sources, denied permissions or I/O
 * failure. Correct the input/permission before retrying; a failed folder copy may
 * leave partial output. Owned fallback Envs are closed before settling.
 */
export async function resource(args = {}, context = {}) {
  const { name, path: wanted, list, target } = query(args);
  if (target !== undefined && (context.safe === true || context.agent?.can?.write === false)) throw new Error("resource: saving is unavailable in safe mode or without write permission");
  const isGlob = globPath(wanted);
  const env = context.env ?? await Env.open(context.agent?.folder ?? process.cwd(), { init: { providers: false, tools: false, detect: false, models: false } });
  const owned = !context.env;
  try {
    const folders = env.skills().get(name)?.directories;
    let chosen = folders && source(name, null, folders);
    // Only absent paths fall back; unsafe or unreadable skill entries fail closed.
    if (chosen) {
      if (isGlob) {
        const matches = await pathsForGlob(chosen, wanted).catch((error) => {
          if (error.message.startsWith("No resources match:")) return [];
          throw error;
        });
        if (!matches.length) chosen = null;
      } else if (!await chosen.entry(wanted)) chosen = null;
    }
    if (!chosen) {
      const folder = projectFolder(env, name);
      await requireRequest(context.agent, context, `Read or copy resources from project ${name}?`);
      chosen = source(name, folder);
    }
    const selections = isGlob ? await pathsForGlob(chosen, wanted) : [wanted];
    if (target === undefined) {
      if (isGlob) {
        const names = [];
        for (const selected of selections) {
          const entry = await chosen.entry(selected);
          names.push(selected + (entry.info.isDirectory() ? "/" : ""));
        }
        return `${chosen.title}: ${names.join(", ")}`;
      }
      const entry = await chosen.entry(wanted);
      if (!entry) throw new Error(`Resource not found: ${label(wanted)}`);
      if (entry.info.isDirectory()) return `${chosen.title}: ${(await chosen.entries(wanted)).map((item) => basename(item.path) + (item.kind === "folder" ? "/" : "")).join(", ")}`;
      if (list) return `${chosen.title}: ${basename(wanted)}`;
      return `${chosen.title}:\n${text(await bytes(entry.file))}`;
    }
    const cwd = context.agent?.folder ?? env.folder;
    let destination;
    try { destination = resolveCwdPath(target, { cwd }); }
    catch { throw new Error("Resource target traversal is refused"); }
    const trees = [];
    for (const selected of selections) trees.push(await sourceTree(chosen, selected));
    const info = await targetInfo(destination, cwd);
    const reports = [];
    if (selections.length > 1 && !info?.isDirectory()) {
      const available = await freeName(destination, cwd, true);
      if (available.existing) reports.push(`${relativeCwdPath(destination, { cwd })} existed; saved as ${relativeCwdPath(available.path, { cwd })}`);
      destination = available.path;
      await createFolder(destination, cwd);
    }
    const container = selections.length > 1 || info?.isDirectory();
    const saved = [];
    for (const tree of trees) saved.push(await copyEntry(tree, container ? join(destination, basename(tree.path || name)) : destination, { sourceRoot: chosen, cwd, context, reports }));
    return `Copied ${chosen.title} to ${saved.join(", ")}${reports.length ? `; ${reports.join("; ")}` : ""}`;
  } catch (error) {
    // Native filesystem failures include installation paths: do not expose them.
    if (error.code) throw new Error("Resource filesystem operation failed");
    throw error;
  } finally { if (owned) await env.close(); }
}

export function toolDescription(env) {
  const projects = env?.projects ? projectListing(env).join("; ") : "this (your own project)";
  return { resource: {
    fn: resource, safe: true, readOnly: (args) => !hasTarget(args), trusted: true,
    description: `List, read or copy files of a skill or a project. A path missing from a skill is looked up in the project of the same name. Copies never overwrite: an existing destination is saved as "<name> 002.<ext>". Projects: ${projects}.`,
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Skill or project name." },
      path: { type: "string", description: "File, folder or glob relative to the skill or project root. Omit for the root. Folders and glob matches list automatically without target." },
      list: { type: "boolean", default: false, description: "List names instead of reading file content. With target, copy the selected resources." },
      target: { type: "string", description: "Copy selected resources to this file or folder in your folder, with or without list; an existing folder receives the copy. Multiple matches use a folder, numbered if a file occupies target." },
    }, required: ["name"] },
  } };
}
