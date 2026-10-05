/**
 * lib/env/tool-registry.js — the tool registry (private to Env):
 * scan-load and refresh of tool roots, the flattened callable lookup,
 * the catalog (env.tools(safe, selector) — ToolInfo values, never the
 * callable), live status, and dispatch (env.toolCall): safe mode is the
 * CALLER's (context.safe), and a pair's provider tools shadow the
 * same-named global tool (context.selector).
 */

import { mcpRegister } from "./mcp-tools.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanToolRoots, bumpRevision } from "./tools.js";
import { dedupeFolders } from "./paths.js";
import { NAMES } from "../namespace.js";
import { DEFAULT_PROVIDER, endpoint as endpointConfig } from "./endpoints.js";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Register a tool into the flattened callable lookup (the scan-load
 * calls this; programmatic tools may too). Duplicate flattened names
 * are diagnosed, never resolved arbitrarily. A schema with `safe:
 * true` publishes the tool for read-only safe mode. A tool with optional
 * mutating arguments MUST reject those arguments in safe mode and publish
 * a synchronous `readOnly(args)` classifier for sequential scheduling.
 * Otherwise safe tools are read-only for every invocation.
 * Safe-mode Agents publish and execute ONLY safe tools. A missing
 * `safe` key means false. Every tool receives the same harness context;
 * interaction is not execution policy. A schema with `trusted: true` requests unrestricted host
 * execution. It is honored only for tools loaded from the package
 * root; other roots cannot grant themselves trust. A package-root
 * `inProcess(args)` classifier can also opt individual calls out of the
 * forked worker; it is never honored for tools from other roots or programmatic registrations.
 * Trusted tools may still request the OS sandbox. A schema with `sandbox:
 * true` marks an ordinary tool for the OS-LEVEL write sandbox (lib/sandbox/os.js — the seatbelt/
 * bwrap kernel jail): the Agent runs its forked worker under the
 * wrapper, so the tool cannot WRITE outside the working folder no
 * matter what its code does. The jail needs a process boundary:
 * only file-scanned tools get it. `sandbox: false` is invalid policy input
 * and ignored: an unsafe, untrusted tool is always sandboxed.
 * `secret:
 * true` hides the tool from the published (model-facing) catalog while
 * it stays directly callable (bin/scripts/tool, the TUI's `/<tool>` input
 * and Tools menu) — for tools meant for the human operator, not the
 * model. `onTimeout` may be an Agent-facing callback for bounded
 * cleanup or a final result; it is never sent to the provider. All
 * harness keys are metadata, stripped from the published catalog
 * (toolSchemas).
 * @param {object} env
 * @param {string} name - flattened tool name
 * @param {Function} fn - the callable
 * @param {object} schema - MCP-like {description, inputSchema, safe?, trusted?, sandbox?, secret?, onTimeout?, readOnly?}; readOnly(args) must synchronously identify non-mutating calls. Only scanned package-root tools may use inProcess(args).
 * @param {{builtin?: boolean, file?: string, allowTrusted?: boolean}} [options]
 * @returns {Function} fn
 */
export function registerTool(env, name, fn, schema, { builtin = false, file, allowTrusted = builtin } = {}) {
  if (typeof fn !== "function") {
    throw new TypeError(`Env.toolAdd: "${name}" is not callable`);
  }
  if (env._tools.has(name)) {
    throw new Error(`Env: duplicate tool name "${name}"`);
  }
  if (schema?.onTimeout !== undefined && typeof schema.onTimeout !== "function") {
    throw new TypeError(`Env.toolAdd: "${name}" onTimeout must be a function`);
  }
  if (schema?.detect !== undefined && typeof schema.detect !== "function") {
    throw new TypeError(`Env.toolAdd: "${name}" detect must be a function`);
  }
  if (schema?.available !== undefined && typeof schema.available !== "function") {
    throw new TypeError(`Env.toolAdd: "${name}" available must be a function`);
  }
  if (schema?.readOnly !== undefined && typeof schema.readOnly !== "function") {
    throw new TypeError(`Env.toolAdd: "${name}" readOnly must be a function`);
  }
  env._tools.set(name, {
    fn, schema,
    ...(typeof schema?.available === "function" ? { available: schema.available, eligible: false } : {}),
    ...(builtin ? { builtin: true } : {}),
    ...(file ? { file } : {}),
    ...(schema?.safe === true ? { safe: true } : {}),
    ...(allowTrusted && schema?.trusted === true ? { trusted: true } : {}),
    ...(schema?.sandbox === true ? { sandbox: true } : {}),
    ...(schema?.secret === true ? { secret: true } : {}),
    ...(typeof schema?.storage === "string" ? { storage: schema.storage } : {}),
    ...(typeof schema?.readOnly === "function" ? { readOnly: schema.readOnly } : {}),
    ...(typeof schema?.onTimeout === "function" ? { onTimeout: schema.onTimeout } : {}),
    ...(typeof schema?.detect === "function" ? { detect: schema.detect } : {}),
  });
  return fn;
}

/**
 * Merge a live-status object into a tool's registry entry — tools
 * report their GLOBAL, environment-shared state here (an MCP tool
 * lists its connected servers). Accessible as the entry's `status`;
 * /status prints it, and the TUI renders it in the information area.
 * (A tool's sticky display MESSAGE is different: it belongs to the
 * AGENT that executed the call — Agent.toolMessageSet.)
 * @param {object} env
 * @param {string} name - flattened tool name
 * @param {Object} info - shallow-merged into the existing status
 * @returns {Object} the tool's merged status
 */
export function updateToolStatus(env, name, info) {
  const entry = env._tools.get(name);
  if (!entry) throw new Error(`Env.toolStatusSet: unknown tool "${name}"`);
  entry.status = { ...entry.status, ...(info ?? {}) };
  return entry.status;
}

/**
 * Return names of currently eligible tools in the flattened registry.
 * @param {object} env - environment whose `_tools` map is read
 * @returns {string[]} eligible flattened tool names
 */
export function toolNames(env) {
  return [...env._tools.keys()].filter((name) => env._tools.get(name).eligible !== false);
}

/** Harness metadata keys: never part of the provider-facing schema. */
const METADATA = ["safe", "trusted", "sandbox", "secret", "storage", "detect", "onTimeout", "fn", "available", "readOnly", "inProcess"];

/**
 * Remove harness-only keys from a tool schema before publication.
 * @param {object} [schema={}] - original schema; defaults to an empty object
 * @returns {object} shallow object containing only publishable entries
 */
function publishable(schema = {}) {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !METADATA.includes(key)));
}

/**
 * Build an immutable catalog record for one registry entry without exposing its callable.
 * @param {string} name - flattened tool name
 * @param {object} entry - registry entry containing schema and policy metadata
 * @returns {{name: string, schema: object, safe: boolean, trusted: boolean, sandbox: boolean,
 *   secret: boolean, interactive: boolean, builtin: boolean, file?: string, storage?: string,
 *   status?: object, onTimeout?: Function, detect?: Function, readOnly?: Function, inProcess?: Function}} frozen ToolInfo record
 */
function toolInfo(name, entry) {
  return Object.freeze({
    name,
    schema: publishable(entry.schema),
    safe: entry.safe === true,
    trusted: entry.trusted === true,
    sandbox: entry.sandbox === true,
    secret: entry.secret === true,
    interactive: entry.schema?.interactive === true,
    builtin: entry.builtin === true,
    ...(entry.file ? { file: entry.file } : {}),
    ...(entry.storage ? { storage: entry.storage } : {}),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.onTimeout ? { onTimeout: entry.onTimeout } : {}),
    ...(entry.detect ? { detect: entry.detect } : {}),
    ...(entry.readOnly ? { readOnly: entry.readOnly } : {}),
    ...(entry.inProcess ? { inProcess: entry.inProcess } : {}),
  });
}

/**
 * Resolve one pair's enabled provider tools after its opt-outs, as name-to-definition entries.
 * Returns an empty map if the selector/pair/provider tools are unavailable.
 * @param {object} env - environment providing model and provider configuration
 * @param {string} selector - endpoint/model selector
 * @returns {Map<string, object>} provider tool name to definition
 */
function providerTools(env, selector) {
  if (typeof selector !== "string") return new Map();
  const pair = env.models(true).get(selector);
  const config = pair ? endpointConfig(env, pair.endpoint) : undefined;
  const tools = env._providers[config?.provider ?? DEFAULT_PROVIDER]?.provider?.capabilities?.tools;
  if (!pair || tools === null || typeof tools !== "object") return new Map();
  return new Map(pair.caps.tools.filter((name) => typeof tools[name]?.function === "function").map((name) => [name, tools[name]]));
}

/**
 * The catalog: eligible tools (only `safe: true` ones when `safe`), and a
 * pair's provider tools, which SHADOW the same-named global tool (its
 * schema and safety unless the provider declares its own).
 * @param {object} env
 * @param {boolean} [safe=false]
 * @param {string} [selector] - `<endpoint>/<model>`
 * @returns {Map<string, object>} name -> ToolInfo
 */
export function toolsList(env, safe = false, selector) {
  const out = new Map();
  for (const [name, entry] of env._tools) {
    if (entry.eligible === false || (safe && entry.safe !== true)) continue;
    out.set(name, toolInfo(name, entry));
  }
  for (const [name, tool] of providerTools(env, selector)) {
    const global = env._tools.get(name);
    const info = Object.freeze({
      name,
      schema: {
        description: tool.description ?? global?.schema?.description ?? "",
        inputSchema: tool.schema ?? global?.schema?.inputSchema ?? { type: "object", properties: {} },
      },
      safe: tool.safe ?? global?.safe === true,
      trusted: false, sandbox: false, secret: false, interactive: false, builtin: false,
      provider: true,
      ...(global ? { shadows: true } : {}),
    });
    if (safe && !info.safe) continue;
    out.set(name, info);
  }
  return out;
}

/**
 * Tool-folder roots, ACCUMULATED in layer order (the package folder
 * is ALWAYS included — the layers are lib/env/paths.js): the
 * package's own `tools/`, `<settingsDir>/tools`, `settings.tools.folders`
 * (array — package/settings scope ONLY: project-scoped folders
 * are stripped at load, see lib/env/load.js).
 * The PROJECT folder is NEVER a tool root: tool code is executable
 * trust (only a package-root schema can mark itself trusted), so a
 * project-writable root would let an agent author its own unsandboxed
 * tools — tools live in the package and the settings
 * folder, both outside the agent's write reach. A folder already
 * listed under an earlier layer appears once (resolved-path dedup —
 * scanning a root twice would throw on the duplicate tool names).
 * @param {object} env
 * @returns {string[]}
 */
export function defaultToolRoots(env) {
  const roots = [join(PACKAGE_DIR, "tools")];
  roots.push(...(env._extensionRoots ?? []).map((root) => join(root, "tools")));
  if (env._settingsDir !== null) roots.push(join(env._settingsDir, "tools"));
  const folders = env._settings.tools?.folders === undefined ? [] : env._settings.tools.folders;
  if (!Array.isArray(folders) || folders.some((folder) => typeof folder !== "string" || folder.trim() === "")) {
    throw new TypeError("tools.folders must be an array of non-empty strings");
  }
  roots.push(...folders);
  return dedupeFolders(roots);
}

/**
 * Tool scan-and-load: import each root's TOP-LEVEL JS modules (the
 * scan is NOT recursive — sub-folders hold a tool's private helpers)
 * and publish described-and-exported callables.
 * @param {object} env
 * @param {Object} [options]
 * @param {string[]} [options.dirs] - root override (tests); remembered
 *   for later refreshTools() calls
 * @returns {Promise<string[]>} the published tool names
 */
export async function loadTools(env, { dirs } = {}) {
  env._toolRoots = dirs ?? defaultToolRoots(env); // env.folders lists them
  return refreshTools(env);
}

/**
 * Rescan the tool roots and rebuild the tool/schema/callable maps:
 * dropped tools disappear, changed modules re-import with a
 * cache-busting revision (bumped on EVERY refresh — wrapper modules
 * re-run, so their helper imports, stamped with the shared
 * Env.toolRevision(), re-import fresh too), built-ins survive.
 * Invoke ONLY between model requests (the tool-refresh built-in runs
 * it during tool execution, which is between requests by
 * construction). Import-side-effect extensions must tolerate
 * repeated initialization.
 * @param {object} env
 * @returns {Promise<string[]>} the published tool names
 */
export async function refreshTools(env) {
  bumpRevision(); // the shared refresh revision (toolTimestamp)
  const roots = env._toolRoots ?? defaultToolRoots(env);
  const trustedRoots = [join(PACKAGE_DIR, "tools")];
  const { tools: discovered, settingsSchema } = await scanToolRoots(roots, env, { trustedRoots });
  const rebuilt = new Map();
  for (const [name, entry] of env._tools) {
    if (entry.builtin && !env._mcpShortcuts?.has(name)) rebuilt.set(name, entry);
  }
  for (const [name, entry] of discovered) {
    if (rebuilt.has(name)) {
      throw new Error(
        `Env: duplicate tool name "${name}" (${entry.file} conflicts with a built-in)`,
      );
    }
    rebuilt.set(name, entry);
  }
  env._tools = rebuilt;
  mcpRegister(env); // the shortcuts follow settings.mcp
  await refreshToolAvailability(env);
  env._toolSettingsSchema = settingsSchema; // rebuilt whole, like the tools themselves
  return toolNames(env);
}

/**
 * Exact flattened lookup + invoke. Missing names are ordinary errors
 * (Agent surfaces them as tool-result errors), never a crash. The
 * optional TOOL CONTEXT is handed to every tool as its second argument.
 * Forked sandbox workers receive the reduced data context plus explicit
 * JSONL request/reply bridges; host callbacks never cross that boundary.
 * @param {object} env
 * @param {string} name
 * @param {object} args
 * @param {object} [context] - harness tool context ({question})
 * @returns {Promise<*>} the tool's return value
 */
export async function callTool(env, name, args, context = {}) {
  const entry = env._tools.get(name);
  const tool = providerTools(env, context.selector).get(name);
  if (tool && !(context.safe && (tool.safe ?? entry?.safe === true) !== true)) {
    // the provider's own backend first; undefined (or a failure, when a
    // global tool can still serve) falls through to the shadowed tool
    try {
      const value = await tool.function({ aiio: context.io, args, signal: context.signal, deadline: context.deadline });
      if (value !== undefined) return value;
    } catch (error) {
      if (!entry) throw error;
    }
    if (!entry) throw new Error(`Env: tool "${name}" is unsupported here`);
  }
  if (!entry) throw new Error(`Env: unknown tool "${name}"`);
  if (context.safe && entry.safe !== true) {
    throw new Error(`Env.safe: "${name}" is not available in safe mode (read-only tools only)`);
  }
  if (entry.available && !(await entry.available(env, context))) throw new Error(`Env: tool "${name}" is not currently available`);
  // a tool reports its own live status (its catalog entry's `status`)
  context.statusSet ??= (info) => updateToolStatus(env, name, info);
  return entry.fn(args, context);
}

/**
 * Recheck dynamic publication only; ordinary tools are untouched and modules are not reimported.
 * Every env.tools() call and every scan runs it; concurrent callers share
 * one check (coalesced). Failure closes eligibility.
 * @param {object} env - environment whose registered availability callbacks are checked
 * @returns {Promise<string[]>} eligible tool names after checks complete
 * @effects Updates each dynamic entry's `eligible` flag and coalesces concurrent checks in `env._toolsChecking`.
 * Availability callback errors are caught and make that tool ineligible.
 */
export function refreshToolAvailability(env) {
  env._toolsChecking ??= Promise.all([...env._tools.values()].filter((entry) => entry.available).map(async (entry) => {
    try { entry.eligible = (await entry.available(env)) === true; } catch { entry.eligible = false; }
  })).then(() => toolNames(env)).finally(() => { env._toolsChecking = null; });
  return env._toolsChecking;
}
