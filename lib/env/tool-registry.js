/**
 * lib/env/tool-registry.js — the tool registry (private to Env):
 * scan-load and refresh of tool roots, the flattened callable lookup,
 * the publishable catalog, live status/messages, and the SAFE VIEW
 * (a Proxy facade whose tool surface is read-only tools only).
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanToolRoots, bumpRevision } from "./tools.js";
import { dedupeFolders } from "./paths.js";
import { NAMES } from "../namespace.js";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Register a tool into the flattened callable lookup (the scan-load
 * calls this; programmatic tools may too). Duplicate flattened names
 * are diagnosed, never resolved arbitrarily. A schema with `safe:
 * true` publishes the tool as READ-ONLY (it never mutates state):
 * safe-mode Agents publish and execute ONLY safe tools. A missing
 * `safe` key means false. Every tool receives the same harness context;
 * interaction is not execution policy. A schema with `trusted: true` requests unrestricted host
 * execution. It is honored only for tools loaded from the package
 * root; other roots cannot grant themselves trust.
 * Trusted tools may still request the OS sandbox. A schema with `sandbox:
 * true` marks an ordinary tool for the OS-LEVEL write sandbox (lib/env/os-sandbox.js — the seatbelt/
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
 * @param {object} schema - MCP-like {description, inputSchema, safe?, trusted?, sandbox?, secret?, onTimeout?}
 * @param {{builtin?: boolean, file?: string, allowTrusted?: boolean}} [options]
 * @returns {Function} fn
 */
export function registerTool(env, name, fn, schema, { builtin = false, file, allowTrusted = builtin } = {}) {
  if (typeof fn !== "function") {
    throw new TypeError(`Env.registerTool: "${name}" is not callable`);
  }
  if (env._tools.has(name)) {
    throw new Error(`Env: duplicate tool name "${name}"`);
  }
  if (schema?.onTimeout !== undefined && typeof schema.onTimeout !== "function") {
    throw new TypeError(`Env.registerTool: "${name}" onTimeout must be a function`);
  }
  if (schema?.detect !== undefined && typeof schema.detect !== "function") {
    throw new TypeError(`Env.registerTool: "${name}" detect must be a function`);
  }
  if (schema?.available !== undefined && typeof schema.available !== "function") {
    throw new TypeError(`Env.registerTool: "${name}" available must be a function`);
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
 * AGENT that executed the call — Agent.updateToolMessage.)
 * @param {object} env
 * @param {string} name - flattened tool name
 * @param {Object} info - shallow-merged into the existing status
 * @returns {Object} the tool's merged status
 */
export function updateToolStatus(env, name, info) {
  const entry = env._tools.get(name);
  if (!entry) throw new Error(`Env.updateToolStatus: unknown tool "${name}"`);
  entry.status = { ...entry.status, ...(info ?? {}) };
  return entry.status;
}

/** @returns {Array<{name: string, status: Object}>} tools with a live status object */
export function toolStatus(env) {
  const out = [];
  for (const [name, entry] of env._tools) {
    if (entry.status !== undefined) out.push({ name, status: entry.status });
  }
  return out;
}

/** @returns {string[]} all flattened tool names */
export function toolNames(env) {
  return [...env._tools.keys()].filter((name) => env._tools.get(name).eligible !== false);
}

/**
 * The SAFE VIEW of an environment: one cached facade (a Proxy —
 * every other member delegates untouched) whose TOOL surface is
 * limited to read-only (`safe: true`) tools:
 *   - toolSchemas() intersects any selection with the safe list
 *     (omitted/["*"] publishes exactly the safe list);
 *   - toolNames() returns the safe list;
 *   - callTool() REFUSES an unsafe tool with an ordinary error.
 * It is a VIEW, not a mode: no state changes, so any number of
 * consumers share one Env while each
 * picks `env` or `env.safe` per its own mode — the user's
 * `this.safe ? Env.safe : Env` pattern. `env.safe.safe` is the
 * same view (safe of safe is safe).
 * @param {object} env
 * @returns {object}
 */
export function safeView(env) {
  if (env._safeView === undefined) {
    const target = env;
    env._safeView = new Proxy(env, {
      get(_, prop) {
        if (prop === "safe") return target.safe;
        if (prop === "toolNames") return () => safeToolNames(target);
        if (prop === "toolSchemas") {
          return (names, options) => {
            const safeNames = safeToolNames(target);
            const selection = names === undefined ||
              (Array.isArray(names) && names.length === 1 && names[0] === "*")
              ? safeNames
              : Array.isArray(names)
                ? names.filter((n) => safeNames.includes(n))
                : names; // non-arrays fall through for the contract error
            return toolSchemas(target, selection, options);
          };
        }
        if (prop === "callTool") {
          return async (name, args, context) => {
            if (target.toolEntry(name)?.safe !== true) {
              throw new Error(`Env.safe: "${name}" is not available in safe mode (read-only tools only)`);
            }
            return target.callTool(name, args, context);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return env._safeView;
}

/**
 * The READ-ONLY tools: schemas published with `safe: true` (the tool
 * never mutates state — a file read, a search, a catalog listing).
 * Safe-mode Agents limit publishing and execution to this list.
 * @param {object} env
 * @returns {string[]}
 */
export function safeToolNames(env) {
  return [...env._tools.entries()]
    .filter(([, entry]) => entry.safe === true && entry.eligible !== false)
    .map(([name]) => name);
}

/**
 * The publishable tool catalog. Omitted/`["*"]` = all current tools;
 * `[]` = none; an explicit list exposes only recognized names. A
 * `secret: true` tool is EXCLUDED unless `includeSecret` is set — the
 * model-facing publish path (lib/io.js) uses the default (hidden);
 * the human-facing surfaces (bin/scripts/tool, the TUI's `/<tool>` input
 * and Tools menu) pass `{ includeSecret: true }` to see everything.
 * @param {object} env
 * @param {string[]} [names]
 * @param {{includeSecret?: boolean}} [options]
 * @returns {Array} [{name, ...schema}]
 */
export function toolSchemas(env, names, { includeSecret = false } = {}) {
  let selected;
  if (names === undefined || (Array.isArray(names) && names.length === 1 && names[0] === "*")) {
    selected = [...env._tools.keys()];
  } else if (Array.isArray(names)) {
    selected = names.filter((n) => env._tools.has(n));
  } else {
    throw new TypeError('Env.toolSchemas: names must be an array, ["*"], or omitted');
  }
  return selected
    .filter((name) => env._tools.get(name).eligible !== false)
    .filter((name) => includeSecret || env._tools.get(name).secret !== true)
    .map((name) => {
      // `safe`/`trusted`/`sandbox`/`secret`/`onTimeout`/`fn` are harness
      // metadata, never published to the provider.
      const { safe, trusted, sandbox, secret, storage, detect, onTimeout, fn, available, ...schema } = env._tools.get(name).schema;
      return { name, ...schema };
    });
}

/** @param {object} env @param {string} name @returns {boolean} */
export function hasTool(env, name) {
  return env._tools.has(name) && env._tools.get(name).eligible !== false;
}

/**
 * The registry entry for a tool ({fn, schema, builtin?, file?, safe?,
 * trusted?, sandbox?, onTimeout?, status?, message?}), or undefined. The `file`
 * marker tells the tool sandbox the tool can be reconstructed in a
 * forked child from the tool roots — only file-scanned tools are
 * forkable (and only forkable tools can take the OS write sandbox).
 * @param {object} env
 * @param {string} name
 * @returns {object|undefined}
 */
export function toolEntry(env, name) {
  return env._tools.get(name);
}

/**
 * Tool-folder roots, ACCUMULATED in layer order (the package folder
 * is ALWAYS included — the layers are lib/env/paths.js): the
 * package's own `tools/`, `<settingsDir>/tools`, `settings.tools`
 * (string or array — package/settings scope ONLY: a project-scoped
 * `tools` key is stripped at load, see lib/env/load.js).
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
  if (env.settingsDir !== null) roots.push(join(env.settingsDir, "tools"));
  if (env._settings.tools !== undefined) roots.push(...[].concat(env._settings.tools));
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
  env._toolRoots = dirs ?? defaultToolRoots(env);
  // the tool roots join the environment's folder surface (deduped
  // by path), each titled for the startup banner
  for (const root of env._toolRoots) {
    if (!env.environment.folders.some((f) => f.path === root)) {
      env.environment.folders.push({ title: "tool folder", path: root });
    }
  }
  return refreshTools(env);
}

/**
 * Rescan the tool roots and rebuild the tool/schema/callable maps:
 * dropped tools disappear, changed modules re-import with a
 * cache-busting revision (bumped on EVERY refresh — wrapper modules
 * re-run, so their helper imports, stamped with the shared
 * Env.toolTimestamp(), re-import fresh too), built-ins survive.
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
    if (entry.builtin) rebuilt.set(name, entry);
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
export async function callTool(env, name, args, context) {
  const entry = env._tools.get(name);
  if (!entry) throw new Error(`Env: unknown tool "${name}"`);
  if (entry.available && !(await entry.available(env, context))) throw new Error(`Env: tool "${name}" is not currently available`);
  return entry.fn(args, context);
}

/** Recheck dynamic publication only; ordinary tools are untouched and modules are not reimported.
 * Called before every model request, and after a scan. Failure closes eligibility.
 */
export async function refreshToolAvailability(env) {
  await Promise.all([...env._tools.values()].filter((entry) => entry.available).map(async (entry) => {
    try { entry.eligible = (await entry.available(env)) === true; } catch { entry.eligible = false; }
  }));
  return toolNames(env);
}
