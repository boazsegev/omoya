/**
 * lib/env/load.js — settings scan-and-merge (private to Env).
 *
 * The LAYERS, in order (see lib/env/paths.js for the conventions):
 *   1. the PACKAGE folder — every top-level JSON file, plus its
 *      `themes/` subfolder (scope "package"; treated as read-only at
 *      runtime);
 *   2. the namespace USER SETTINGS folder — every top-level JSON file,
 *      plus its `themes/` subfolder (also scope "package": this is
 *      where dynamic settings are SAVED — drop a theme file in
 *      `$<NS>_SETTINGS/themes` and it merges like any other settings
 *      JSON);
 *   3. the PROJECT folder (cwd) — ONLY namespace settings/auth files
 *      (scope "local" — the re-authorization flow
 *      re-saves where the endpoint already lives); never a full
 *      folder scan, never a `themes/` scan (agent-accessible files:
 *      theme discovery belongs to the trusted layers).
 * A folder already scanned under an earlier layer is skipped
 * (resolved-path dedup). Each layer's files merge into one settings
 * tree (see lib/env/settings.js for the merge rules); a package or
 * project settings-file parse failure crashes the load (fail fast);
 * any other file's parse failure is ignored. Every file is parsed as
 * JSONC (lib/env/jsonc.js): `//` and `/* *\/` comments are allowed
 * outside string literals — `ai init` ships a fully commented-out
 * template this way. Explicit constructor settings merge LAST (override).
 *
 * AUTH FILE PROVENANCE: package/user and namespaced project auth files
 * are recorded per
 * top-level section name with their scope — an auth file is an
 * endpoint's SELF-CONTAINED record (provider, url, tokens, model
 * cache), so the endpoint auto-catalogs WITHOUT a settings.providers
 * entry (those are for MANUAL endpoint configuration — see the Env
 * constructor's union).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deepMerge, isPlainObject, scanJsonFiles, scanSettingsFiles, scanThemeFiles } from "./settings.js";
import { folderIdentity } from "./paths.js";
import { parseJsonc } from "./jsonc.js";
import { NAMES } from "../namespace.js";
import { TOOL_SETTINGS_DEFAULTS } from "../tool-runtime.js";
import { projectRefusedKeys } from "./settings-schema.js";

/** The settings-file name of a layer (fail-fast on a parse failure). */
const SETTINGS_FILE = { package: "settings.json", local: NAMES.projectSettings };

/** Package/user and namespaced project auth-file name shapes. */
const AUTH_FILE = new RegExp(`^(?:${NAMES.projectAuthPrefix}|auth-).+\\.json`);

/**
 * Filter project-supplied settings to retain policy while excluding
 * executable roots and trusted-only keys. The `tools` object is kept only
 * when plain, and then only its allowlisted policy keys are retained.
 *
 * @param {Object} parsed - parsed project settings object
 * @returns {Object} settings safe to merge from the project layer
 */
function projectSettings(parsed) {
  const refused = new Set(projectRefusedKeys());
  const { tools, ...kept } = parsed;
  const rest = Object.fromEntries(Object.entries(kept).filter(([key]) => !refused.has(key)));
  // Non-objects must not replace the trusted tools object during deepMerge.
  if (isPlainObject(tools)) {
    rest.tools = Object.fromEntries(Object.entries(tools).filter(([key]) =>
      key !== "folders" && Object.hasOwn(TOOL_SETTINGS_DEFAULTS, key)));
    // Allowlisted policy also blocks magic keys from creating inherited folders.
  }
  return rest;
}

/**
 * Scan package, extension, optional user, and project settings layers and
 * merge their JSONC contents in order, followed by explicit settings. Folder
 * identities are deduplicated. Project settings are filtered to exclude
 * trusted executable configuration; auth-file section provenance is recorded
 * in `authSections`, and project provider/auth entries are marked local.
 *
 * @param {Object} [options={}] - scan inputs and merge options
 * @param {string} options.dir - package folder (scope "package")
 * @param {string} options.cwd - project folder (scope "local")
 * @param {string|null} [options.settingsDir=null] - user settings folder
 *   (scope "package"); `null` disables this layer
 * @param {Object} [options.settings] - explicit settings merged last
 * @param {string[]} [options.extensionRoots=[]] - additional trusted package
 *   roots, scanned after the package folder and before user settings
 * @param {boolean} [options.loadThemes=false] - include theme files from
 *   trusted package and user roots
 * @returns {{merged: Object, scopes: Map<string, "package"|"local">,
 *   authSections: Map<string, "package"|"local">, sessionsBase: string|undefined}} merged settings, provider
 *   scopes, auth-file section scopes, and base for a project session path
 * @throws {SyntaxError} when a layer's designated settings file is malformed
 *   JSONC; parse failures in other files are ignored
 * @throws {Error} when a selected file cannot be read
 */
export function scanAndMergeSettings({ dir, cwd, settingsDir = null, settings, extensionRoots = [], loadThemes = false } = {}) {
  let merged = {};
  const scopes = new Map();
  let sessionsBase;
  const authSections = new Map(); // endpoint name -> scope, from auth FILE names (provenance)
  const layers = [
    { root: dir, files: [...scanSettingsFiles(dir), ...(loadThemes ? scanThemeFiles(dir) : [])], scope: "package" },
    ...extensionRoots.map((root) => ({ root, files: [...scanSettingsFiles(root), ...(loadThemes ? scanThemeFiles(root) : [])], scope: "package", extension: true })),
    ...(settingsDir === null
      ? []
      : [{ root: settingsDir, files: [...scanSettingsFiles(settingsDir), ...(loadThemes ? scanThemeFiles(settingsDir) : [])], scope: "package" }]),
    {
      root: cwd,
      files: scanJsonFiles(cwd).filter((file) => file === NAMES.projectSettings || file.startsWith(NAMES.projectAuthPrefix)),
      scope: "local",
    },
  ];
  // a folder already scanned under an earlier layer is skipped
  // (resolved-path dedup — e.g. cwd === the package folder)
  const seen = new Set();
  for (const source of layers) {
    const id = folderIdentity(source.root);
    if (seen.has(id)) continue;
    seen.add(id);
    for (const file of source.files) {
      const text = readFileSync(join(source.root, file), "utf8");
      let parsed;
      try {
        parsed = parseJsonc(text); // // and /* */ comments allowed, outside strings
      } catch (cause) {
        if (file === SETTINGS_FILE[source.scope]) {
          throw new SyntaxError(
            `Env: ${join(source.root, file)} parse failure (fail fast): ${cause.message}`,
          );
        }
        continue;
      }
      if (!isPlainObject(parsed)) continue;
      // An extension cannot select additional executable extension packages.
      if (source.extension) {
        const { extensions: _e, ...content } = parsed;
        parsed = content;
      }
      // EXECUTABLE TRUST stays out of the PROJECT scope: `tools.folders`,
      // `mcp` and `providerPaths` in the project's settings
      // file would name tool roots, unsandboxed server commands and
      // provider classes an agent could write to — executable
      // configuration comes from the package and the settings folder
      // only (defaultToolRoots / defaultProviderRoots / lib/env/mcp-tools.js)
      if (source.scope === "local") {
        // Every project-scanned file is agent-accessible. An auth
        // record is allowed to declare its endpoint's `provider`, but
        // it must not smuggle global executable configuration alongside
        // it. In particular MCP `command` values spawn host processes.
        parsed = projectSettings(parsed);
        // Only the project's settings file may opt its session store into
        // that folder; auth records are endpoint records, not log policy.
        if (file !== NAMES.projectSettings) {
          const { sessions: _sessions, ...rest } = parsed;
          parsed = rest;
        }
      }
      merged = deepMerge(merged, parsed);
      if (Object.hasOwn(parsed, "sessions")) sessionsBase = source.scope === "local" ? cwd : undefined;
      if (source.scope === "local" && isPlainObject(parsed.providers)) {
        for (const name of Object.keys(parsed.providers)) scopes.set(name, "local");
      }
      // an auth FILE's top-level sections are endpoint records; the
      // file's layer fixes their scope (a project auth file is "local"
      // — re-authorization re-saves where the endpoint lives)
      if (AUTH_FILE.test(file)) {
        for (const name of Object.keys(parsed)) {
          authSections.set(name, source.scope);
          if (source.scope === "local") scopes.set(name, "local");
        }
      }
    }
  }
  if (settings !== undefined) {
    merged = deepMerge(merged, settings);
    if (Object.hasOwn(settings, "sessions")) sessionsBase = undefined;
  }
  return { merged, scopes, authSections, sessionsBase };
}
