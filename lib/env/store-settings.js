/* Private authorization/defaults adapter over an Env's SettingsStore.
 * Reads return the current state with schema defaults and derived values;
 * writes validate, then route to the store (or to the node a key belongs to). */
import { isDeepStrictEqual } from "node:util";
import { TOOL_SETTINGS_DEFAULTS } from "../tool-runtime.js";
import { isPlainObject } from "./settings.js";
import { defaultsSchema } from "./settings-schema.js";
import { SettingsStore } from "./settings-store.js";
import { pathNames } from "../util.js";

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
const MAP_PATHS = [["skills"], ["prompts"], ["tools", "folders"], ["extensions"],
  ["providers"], ["mcp"], ["projects"], ["env"], ["themes"], ["tui", "keys"]];
function rejectMapArrays(path, value) {
  for (const mapPath of MAP_PATHS) {
    if (path.length > mapPath.length || !path.every((key, index) => mapPath[index] === key)) continue;
    let candidate = value;
    for (const key of mapPath.slice(path.length)) candidate = isPlainObject(candidate) ? candidate[key] : undefined;
    if (Array.isArray(candidate)) throw new TypeError(`Env settings: ${mapPath.join(".")} must be a map`);
  }
}
function checkPath(path, nonempty = false) {
  if (!Array.isArray(path) || nonempty && !path.length || path.some((key) => typeof key !== "string" || !key || UNSAFE.has(key))) throw new TypeError("Env settings: invalid key path");
}
function at(value, path) {
  for (const key of path) { if (!isPlainObject(value) || !Object.hasOwn(value, key)) return undefined; value = value[key]; }
  return value;
}
/** Pin records with derived display name and absolute folder (neither is stored). */
function projectsNamed(raw) {
  if (!isPlainObject(raw)) return raw;
  const result = structuredClone(raw);
  const folders = Object.keys(result).filter((folder) => isPlainObject(result[folder]));
  for (const [folder, segments] of pathNames(folders)) {
    result[folder].name = segments.join("/");
    result[folder].folder = folder;
  }
  for (const folder of folders) {
    const name = result[folder].name;
    if (name !== folder && !Object.hasOwn(result, name)) result[name] = result[folder];
  }
  return result;
}
/** A projects write without derived name/folder fields (never stored). */
function projectsUnnamed(path, value) {
  const strip = (record) => {
    if (!isPlainObject(record)) return record;
    const { name: _name, folder: _folder, ...rest } = record;
    return rest;
  };
  if (path.length === 1 && isPlainObject(value)) {
    const records = Object.create(null);
    for (const [key, record] of Object.entries(value)) {
      const folder = isPlainObject(record) && typeof record.folder === "string" ? record.folder : key;
      if (folder === key || !Object.hasOwn(records, folder)) records[folder] = strip(record);
    }
    return records;
  }
  if (path.length === 1) return value;
  return path.length === 2 ? strip(value) : value;
}
/** Defaults below, settings above: objects merge by key, other values replace. */
function withDefaults(fallback, value) {
  if (!isPlainObject(fallback) || !isPlainObject(value)) return value === undefined ? structuredClone(fallback) : value;
  const result = structuredClone(fallback);
  for (const [key, item] of Object.entries(value)) result[key] = withDefaults(result[key], item);
  return result;
}
function validateValue(path, value, env) {
  rejectMapArrays(path, value);
  if (path.includes("auth") && (path[0] === "providers" || env._endpointScopes?.has(path[0]) || env._dynamicEndpoints?.has(path[0]))) throw new TypeError("Env settings: endpoint auth requires the auth API");
  if (path[0] === "providers" && env._dynamicEndpoints?.has(path[1])) {
    const modelPolicy = path[2] === "models" && path.length >= 5 && ["maxActive", "context", "tools", "thinkingDefault"].includes(path[4]);
    if (path.length === 2 || path[2] === "url" || path[2] === "auth" || path[2] === "models" && !modelPolicy) throw new TypeError("Env settings: detected endpoint facts are read-only");
  }
  if (Array.isArray(value)) { for (const item of value) validateValue(path, item, env); }
  else if (isPlainObject(value)) for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (UNSAFE.has(key)) throw new TypeError("Env settings: unsafe value key");
    validateValue([...path, key], value[key], env);
  }
}

/** Authorized synchronous reads/edits; reads may be partial until the store's first poll completes.
 * `user` (the catch-all) and `projects` are the nodes that user-only keys are written to. */
export function storeSettingsCreate(env, store, { user, projects, settings, globalOnly = false } = {}) {
  if (!env || !(store instanceof SettingsStore)) throw new TypeError("Env settings: expected env and store");
  const cache = new Map();
  // Constructor overrides stay owned by their memory source even after deletion;
  // adjacent keys with no override continue to use normal file routing.
  const overridden = [];
  function collect(value, path = []) {
    if (isPlainObject(value) && Object.keys(value).length) {
      for (const [key, item] of Object.entries(value)) collect(item, [...path, key]);
    } else if (path.length) overridden.push(path);
  }
  if (settings) collect(settings.own());
  function overrideOwns(path) {
    return settings && overridden.some((leaf) =>
      path.every((key, index) => leaf[index] === key) || leaf.every((key, index) => path[index] === key));
  }
  let version = -1;
  let schema;
  // `tui.theme`/`web.theme` fall back to the global `theme`.
  function themed(path, raw) {
    const app = path[0];
    if (!["tui", "web"].includes(app) || path.length > 2 || store.read([app, "theme"]) !== undefined) return raw;
    const theme = store.read(["theme"]);
    if (theme === undefined) return raw;
    if (path.length === 2) return path[1] === "theme" ? theme : raw;
    return { ...(isPlainObject(raw) ? raw : {}), theme };
  }
  function pinsRead() {
    return withDefaults(defaultsSchema(env).projects?.default, projectsNamed(store.read(["projects"])));
  }
  function reachableProjects() {
    const pins = env.constructor.settings.projects.toJSON();
    const groupsOf = (pin) => Object.keys(pin?.groups ?? {}).filter((group) => pin.groups[group] === true);
    const own = new Set(groupsOf(pins[env.folder]));
    const ownPin = pins[env.folder] ?? { name: "this", folder: env.folder };
    const result = { [env.folder]: ownPin, this: ownPin };
    if (ownPin.name !== "this") result[ownPin.name] = ownPin;
    const peers = [];
    for (const [folder, pin] of Object.entries(pins)) {
      if (folder !== pin?.folder) continue;
      if (!own.size || folder === env.folder || typeof pin?.name !== "string") continue;
      if (groupsOf(pin).some((group) => own.has(group))) peers.push([folder, pin]);
    }
    for (const [folder, pin] of peers.sort(([, a], [, b]) => a.name.localeCompare(b.name))) {
      result[folder] = pin;
      if (pin.name !== "this" && !Object.hasOwn(result, pin.name)) result[pin.name] = pin;
    }
    return result;
  }
  function projectsRead() { return globalOnly ? pinsRead() : reachableProjects(); }
  function compute(path, entries) {
    const key = path[0];
    if (key !== undefined && typeof entries[key]?.derive === "function") return at({ [key]: entries[key].derive(env, store.read([key])) }, path);
    if (key === "projects") return at({ projects: projectsRead() }, path);
    if (key === undefined) {
      const result = withDefaults(Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.default])), store.read([]) ?? {});
      result.projects = projectsRead();
      for (const [name, entry] of Object.entries(entries)) if (typeof entry.derive === "function") result[name] = entry.derive(env, store.read([name]));
      for (const app of ["tui", "web"]) result[app] = themed([app], result[app]);
      return result;
    }
    return withDefaults(at(entries[key]?.default, path.slice(1)), themed(path, store.read(path)));
  }
  function read(path = []) {
    checkPath(path);
    const entries = defaultsSchema(env);
    if (version !== store.version || schema !== entries) { cache.clear(); version = store.version; schema = entries; }
    // The global pin registry may change through Env.settings without changing
    // an isolated project's store version. Derive reachability on each read.
    const derived = !globalOnly && (path.length === 0 || path[0] === "projects");
    const id = path.join("\0");
    if (derived || !cache.has(id)) cache.set(id, compute(path, entries));
    const value = cache.get(id);
    return value !== null && typeof value === "object" ? structuredClone(value) : value;
  }
  // Keys that only the user may set go straight to the user catch-all (or projects.json).
  function directNode(path) {
    const entry = defaultsSchema(env)[path[0]];
    if (entry?.file === "projects.json") {
      if (!projects?.writable) throw new TypeError("Env settings: named projects source unavailable");
      return projects;
    }
    if (entry?.layers && !entry.layers.includes("project") ||
        path[0] === "tools" && (path[1] === "folders" || path.length > 1 && !Object.hasOwn(TOOL_SETTINGS_DEFAULTS, path[1]))) return user;
    return undefined;
  }
  function projectEdit(node, path, value) {
    const fields = path.slice(1);
    const records = node.own(["projects"]) ?? {};
    const assign = (object, [key, ...rest]) => {
      if (!key) return value;
      const result = { ...(isPlainObject(object) ? object : {}) };
      const next = rest.length ? assign(result[key], rest) : value;
      if (next === undefined || rest.length && isPlainObject(next) && !Object.keys(next).length) delete result[key];
      else result[key] = next;
      return result;
    };
    const next = assign(records, fields);
    if (!isPlainObject(next)) { node.assign(["projects"], next); return; }
    node.assign(["projects"], Object.keys(next).length
      ? Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))) : undefined);
  }
  function update(path, value) {
    checkPath(path, true);
    if (path[0] === "projects" && !globalOnly) {
      const global = env.constructor.settings;
      const target = path.slice(1);
      if (target.length === 1 && value !== undefined && isPlainObject(value) && target[0] !== "this") {
        const current = global.projects[target[0]];
        if (current?.groups !== undefined && value.groups === undefined) value = { ...value, groups: current.groups.toJSON() };
        if (current === undefined) {
          const ownGroups = global.projects[env.folder]?.groups?.toJSON?.() ?? {};
          const groups = Object.fromEntries(Object.entries(ownGroups).filter(([, enabled]) => enabled === true));
          if (Object.keys(groups).length) value = { ...value, groups: { ...value.groups, ...groups } };
        }
      }
      if (!target.length) {
        if (value === undefined) delete global.projects;
        else global.projects = value;
        return;
      }
      if (target[0] === "this") target[0] = env.folder;
      let view = global.projects;
      for (const key of target.slice(0, -1)) {
        view = view[key];
        if (view === undefined) throw new TypeError("Env settings: project record does not exist");
      }
      const key = target.at(-1);
      if (value === undefined) delete view[key];
      else view[key] = value;
      return;
    }
    if (path[0] === "projects") {
      if (path.length > 1) path = ["projects", pinsRead()[path[1]]?.folder ?? path[1], ...path.slice(2)];
      if (path[2] === "name" || path[2] === "folder") return undefined; // derived fields; never stored
      value = projectsUnnamed(path, value);
    }
    if (defaultsSchema(env)[path[0]]?.derive) throw new TypeError("Env settings: derived setting is read-only");
    validateValue(path, value, env);
    if (path.length === 1 && path[0] === "tools") {
      if (value !== undefined && !isPlainObject(value)) throw new TypeError("Env settings: tools must be an object");
      const current = store.read(["tools"]);
      for (const key of new Set([...Object.keys(current ?? {}), ...Object.keys(value ?? {})])) update(["tools", key], value?.[key]);
      return;
    }
    // A value equal to the effective one (defaults included) changes nothing.
    const effective = path[0] === "projects" ? projectsUnnamed(path, pinsReadAt(path)) : read(path);
    if (value !== undefined && isDeepStrictEqual(effective, value)) return;
    const node = overrideOwns(path) ? settings : directNode(path);
    if (node) {
      const existed = node.has(path);
      if (path[0] === "projects") projectEdit(node, path, value);
      else node.assign(path, value);
      return value === undefined ? existed : undefined;
    }
    const taken = store.write(path, value);
    return value === undefined ? taken : undefined;
  }
  function pinsReadAt(path) { return at({ projects: pinsRead() }, path); }
  function canonicalPath(path) {
    if (path[0] !== "projects" || path.length < 2) return path;
    const record = (globalOnly ? pinsRead() : reachableProjects())[path[1]];
    return record && path[1] !== record.folder ? ["projects", record.folder, ...path.slice(2)] : path;
  }
  return { read, write: update, delete(path) { return update(path, undefined); }, canonicalPath, close() {} };
}
