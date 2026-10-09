/* Env-owned settings sources: which folders and files form an Env's settings,
 * how project and auth policy filters them, and endpoint queries over them.
 * SettingsStore aggregates; it knows nothing of these roles.
 *
 * Global store (one per package/user folder selection, shared by every Env
 * using it), lowest first:
 *   package *.json and themes, installed extensions        (read-only)
 *   (every themes/*.json file is mounted at ["themes"], never the root)
 *   runtime   — memory: detected endpoints and endpoint data with no file
 *   user      — <settings>/settings.json, the catch-all
 *   projects  — <settings>/projects.json
 *   last-model — <settings>/last-model.json, catch-all at ["last-model"]
 *   auth      — <settings>/auth-*.json at ["providers"]
 *   the user folder's other *.json files and themes
 * Project store (one per Env; its parent is the global store):
 *   <cwd>/ai-themes/*.json at ["themes"], <cwd>/ai-auth-*.json at ["providers"],
 *   <cwd>/ai-settings.json (filtered),
 *   then the constructor's explicit settings (memory).
 */
import { basename, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { NAMES } from "../namespace.js";
import { SettingsStore } from "./settings-store.js";
import { folderIdentityAsync } from "./paths.js";
import { isPlainObject } from "./settings.js";
import { projectRefusedKeys } from "./settings-schema.js";
import { TOOL_SETTINGS_DEFAULTS } from "../tool-runtime.js";

const refused = new Set([...projectRefusedKeys(), "providerPaths"]);
const MAP_PATHS = [["skills"], ["prompts"], ["tools", "folders"], ["extensions"],
  ["providers"], ["mcp"], ["projects"], ["env"], ["themes"], ["tui", "keys"]];
function validateMaps(data) {
  for (const path of MAP_PATHS) {
    let value = data;
    for (const key of path) value = isPlainObject(value) ? value[key] : undefined;
    if (Array.isArray(value)) throw new TypeError(`Env settings: ${path.join(".")} must be a map; back up this settings file and replace the array with a key-to-value map`);
  }
  return data;
}
function trustedFiltered(data) {
  const { providerPaths: _obsolete, ...rest } = data;
  return validateMaps(rest);
}
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const validName = (name) => typeof name === "string" && SAFE_NAME.test(name) && !UNSAFE_NAMES.has(name);
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Names that are never settings: conflict copies ("auth-x 2.json") and other odd names. */
const ODD_NAME = /[^\w.-]/;
/** Project-owned files never load as package layers, even when the package folder is a project. */
const PROJECT_FILES = new RegExp(`^(?:${escaped(NAMES.projectSettings)}|${escaped(NAMES.projectAuthPrefix)}.*\\.json)$`);
export const LAST_MODEL = "last-model";

/** Project files never configure trust: refused keys and non-runtime tool keys are dropped. */
function projectFiltered(data) {
  const result = Object.fromEntries(Object.entries(data).filter(([name]) => !refused.has(name)));
  if (isPlainObject(result.tools)) {
    result.tools = Object.fromEntries(Object.entries(result.tools).filter(([name]) =>
      name !== "folders" && Object.hasOwn(TOOL_SETTINGS_DEFAULTS, name)));
  } else delete result.tools;
  return validateMaps(result);
}

function authStripped(value) {
  if (Array.isArray(value)) return value.map(authStripped);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "auth").map(([key, item]) => [key, authStripped(item)]));
}

// Stable filter functions, one per role.
const FILTERS = {
  trusted: trustedFiltered,
  extension: ({ extensions: _extensions, providerPaths: _obsolete, ...rest }) => validateMaps(rest),
  project: projectFiltered,
};
const FILTERS_NO_AUTH = Object.fromEntries(Object.entries(FILTERS).map(([kind, filter]) =>
  [kind, (data) => authStripped(filter ? filter(data) : data)]));
const filterFor = (kind, auth) => auth ? FILTERS[kind] : FILTERS_NO_AUTH[kind];

function identity(dir) {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

/** Older builds kept last-model.json as an array; this version keeps a map. An array file is discarded. */
async function lastModelDiscard(file) {
  try {
    if (Array.isArray(JSON.parse(await readFile(file, "utf8")))) await unlink(file);
  } catch { /* missing or malformed: the store reports malformed files */ }
}

const globals = new Map();

/** The shared global store for a package/user selection, created on first use. */
function globalAcquire({ system, user, themes, auth, extensionRoots, explicitExtensions }) {
  // The same trusted folders and explicit selection resolve to the same roots.
  // Keep distinct selections apart without allocating a whole copy of global
  // files for each Env that supplies an identical constructor override.
  const key = explicitExtensions === undefined ? JSON.stringify([system, user, themes, auth, null])
    : explicitExtensions === null ? Symbol("invalid extension selection")
    : JSON.stringify([system, user, themes, auth, Object.entries(explicitExtensions)]);
  let entry = globals.get(key);
  if (!entry) {
    const trusted = filterFor("trusted", auth);
    const store = new SettingsStore();
    // A user folder that is also the package folder is the user's, writable.
    const packageFiles = system === user ? undefined
      : store.attach({ source: join(system, "*.json"), exclude: PROJECT_FILES, filter: trusted, writable: false });
    if (packageFiles && themes) store.attach({ source: join(system, "themes", "*.json"), at: ["themes"], filter: trusted, writable: false });
    const runtime = store.attach({ writable: false }); // set only by Env; user edits land in user files
    const userNode = store.attach(user ? { source: join(user, "settings.json"), filter: trusted, catchAll: true } : { catchAll: true });
    const projects = store.attach(user ? { source: join(user, "projects.json"), filter: trusted } : {});
    const lastModel = store.attach({ ...(user ? { source: join(user, `${LAST_MODEL}.json`) } : {}), at: [LAST_MODEL], catchAll: true });
    const authFiles = user ? store.attach({ source: join(user, "auth-*.json"), at: ["providers"], exclude: ODD_NAME, filter: filterFor("trusted", auth) }) : undefined;
    if (user) {
      store.attach({ source: join(user, "*.json"), exclude: ODD_NAME, filter: trusted });
      if (themes) store.attach({ source: join(user, "themes", "*.json"), at: ["themes"], exclude: ODD_NAME, filter: trusted });
    }
    const seen = new Set([system, user].filter(Boolean));
    // Files that must parse for startup to succeed; ancillary ones are retried by polling.
    const required = () => [userNode, projects, ...(packageFiles?.nodes.filter((node) => basename(node.source) === "settings.json") ?? [])];
    const attached = (async () => {
      if (user) await lastModelDiscard(join(user, `${LAST_MODEL}.json`));
      // Installed extensions resolve asynchronously; their layers sit above the package folder.
      for (const root of await extensionRoots) {
        const id = await folderIdentityAsync(root);
        if (seen.has(id)) continue;
        seen.add(id);
        store.attach({ source: join(id, "*.json"), filter: filterFor("extension", auth), writable: false }, { before: runtime });
        if (themes) store.attach({ source: join(id, "themes", "*.json"), at: ["themes"], filter: trusted, writable: false }, { before: runtime });
      }
    })();
    void attached.catch(() => {});
    entry = { key, store, runtime, user: userNode, projects, lastModel, authFiles, attached, required, refs: 0 };
    globals.set(key, entry);
  }
  entry.refs++;
  return entry;
}

function globalRelease(entry) {
  if (--entry.refs > 0) return Promise.resolve();
  globals.delete(entry.key);
  return entry.store.close();
}

/**
 * Declare an Env's settings: the shared global store and this project's store.
 * Reads are immediate (possibly partial until ready()); writes are immediate and saved asynchronously.
 * @param {{dir: string, settingsDir?: string|null, cwd: string, extensionRoots?: string[]|Promise<string[]>, settings?: object, themes?: boolean, auth?: boolean, globalOnly?: boolean}} options
 * @returns {object} the Env's source handle; the caller owns close().
 */
export function sourceGraphCreate({ dir, settingsDir = null, cwd, extensionRoots = [], settings = {}, themes = true, auth = true, globalOnly = false }) {
  if (typeof dir !== "string" || typeof cwd !== "string" || (settingsDir !== null && typeof settingsDir !== "string") ||
      !isPlainObject(settings)) throw new TypeError("Env source graph: invalid source options");
  const user = settingsDir === null ? null : identity(settingsDir);
  const projectId = identity(cwd);
  const project = globalOnly || projectId === user ? null : projectId; // global access never loads a project layer
  const explicitExtensions = Object.hasOwn(settings, "extensions") ? settings.extensions : undefined;
  const validExtensions = isPlainObject(explicitExtensions) && Object.values(explicitExtensions).every((value) => typeof value === "boolean");
  const global = globalAcquire({ system: identity(dir), user, themes: themes === true, auth: auth === true,
    explicitExtensions: Object.hasOwn(settings, "extensions") ? validExtensions ? explicitExtensions : null : undefined,
    extensionRoots: Promise.resolve(extensionRoots).then((roots) => {
      if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) throw new TypeError("Env source graph: invalid extension roots");
      return roots;
    }) });
  const store = new SettingsStore({ parent: global.store });
  if (project && themes) store.attach({ source: join(project, NAMES.projectThemesDir, "*.json"), at: ["themes"], exclude: ODD_NAME, filter: filterFor("trusted", auth) });
  const projectFiles = project ? store.attach({ source: join(project, `${NAMES.projectAuthPrefix}*.json`), at: ["providers"],
    exclude: ODD_NAME, filter: filterFor("trusted", auth) }) : undefined;
  const projectNode = project ? store.attach({ source: join(project, NAMES.projectSettings), filter: filterFor("project", auth) }) : undefined;
  // Constructor overrides are the final, per-Env memory layer. The settings
  // adapter routes edits of their owned keys back here rather than to files.
  const settingsNode = store.attach({ data: trustedFiltered(auth ? settings : authStripped(settings)) });
  const runtime = global.runtime;
  let closed = false;
  let closePromise = null;

  // One poll loads the global and project files together and announces them once.
  const readyPromise = (async () => {
    await global.attached;
    try { await store.poll(); } catch (error) {
      const failed = [...global.required(), ...(projectNode ? [projectNode] : [])].find((node) => node.error);
      if (failed) throw failed.error;
      // A required node's filter can reject a legacy map before the store records node.error.
      if (error?.message?.startsWith("Env settings:")) throw error;
    }
  })();
  void readyPromise.catch(() => {});

  const authFileName = (name, scope) => scope === "project" ? `${NAMES.projectAuthPrefix}${name}.json` : `auth-${name}.json`;
  const authFolder = (scope) => scope === "project" ? project : user;

  return {
    store,
    global: global.store,
    runtime,
    user: global.user,
    projects: global.projects,
    lastModel: global.lastModel,
    project: projectNode,
    settings: settingsNode,
    ready: () => readyPromise,
    /** Durability barrier: save this project's and the global store's pending changes. */
    async flush() { if (!closed) await store.save(); },
    /** Detected facts (`provider`, `url`, `auth`, `models`) held in memory for `name`. */
    detectionGet(name) {
      if (!validName(name)) throw new TypeError("Env source graph: invalid detected endpoint");
      return runtime.own(["providers", name]);
    },
    /** Replace an endpoint's in-memory facts; returns whether they changed. */
    detectionSet(name, facts) {
      if (!validName(name) || !isPlainObject(facts)) throw new TypeError("Env source graph: invalid detected endpoint");
      const next = auth ? facts : authStripped(facts);
      if (isDeepStrictEqual(runtime.own(["providers", name]), next)) return false;
      runtime.assign(["providers", name], next);
      return true;
    },
    detectionRemove(name) {
      if (!runtime.has(["providers", name])) return false;
      runtime.assign(["providers", name], undefined);
      return true;
    },
    /** `providers.<name>` from every file and explicit setting, excluding in-memory facts. */
    configuredEndpoint(name) {
      if (typeof name !== "string") throw new TypeError("Env source graph: invalid endpoint query");
      const value = store.read(["providers", name], { skip: runtime });
      return isPlainObject(value) && Object.keys(value).length ? value : undefined;
    },
    /** Which source owns `sessions`: the project settings file ("local") or otherwise "user". */
    sessionsScope() {
      if (settingsNode.has(["sessions"])) return "user";
      return projectNode?.has(["sessions"]) ? "local" : "user";
    },
    /** Write scope of an endpoint: "local" when a project file defines it, else "package". */
    endpointScope(name) {
      if (!validName(name)) throw new TypeError("Env source graph: invalid endpoint scope");
      if (projectFiles?.nodes.some((node) => node.has([name]))) return "local";
      return projectNode?.has(["providers", name]) ? "local" : "package";
    },
    /** Configured and detected endpoint names. */
    endpointNames() {
      return Object.keys(store.read(["providers"]) ?? {}).filter(validName);
    },
    /** The existing auth-file node for an endpoint, without creating one. */
    authFile(name, { scope = "user" } = {}) {
      if (!validName(name)) throw new TypeError("Env source graph: invalid auth lookup");
      const folder = authFolder(scope);
      return folder ? store.attached(join(folder, authFileName(name, scope))) : undefined;
    },
    /** Login only: the auth-file node for an endpoint, attached and loaded (a write to it saves). */
    async authFileCreate(name, { scope = "user" } = {}) {
      if (!auth || !validName(name) || !["user", "project"].includes(scope)) throw new TypeError("Env source graph: invalid auth source");
      const folder = authFolder(scope);
      if (!folder) return undefined; // no folder to hold the file: callers keep credentials in memory
      const source = join(folder, authFileName(name, scope));
      const target = scope === "project" ? store : global.store;
      const node = target.attached(source) ?? target.attach({ source, at: ["providers"], filter: filterFor("trusted", auth) },
        { before: scope === "project" ? projectFiles : global.authFiles });
      if (node.version === undefined) await target.poll({ parent: false }).catch(() => {});
      return node;
    },
    /** Reread changed files, then return the endpoint's merged settings. */
    async endpointReload(name) {
      if (!validName(name)) throw new TypeError("Env source graph: invalid endpoint reload");
      try { await store.poll(); } catch { /* a failing file keeps its last good data */ }
      return store.read(["providers", name]);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([readyPromise]);
        const results = await Promise.allSettled([store.close(), globalRelease(global)]);
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Env source graph failed to close");
      })();
      return closePromise;
    },
  };
}
