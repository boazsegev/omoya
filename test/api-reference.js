/**
 * test/api-reference.js — LIBRARY for the doc tests: emit a compact API
 * reference for the public modules. No CLI — generation is owned by
 * test/api-docs.test.js, which rewrites API.md on every `bun test`
 * run (documentation generation must always happen) and asserts the
 * documentation gate (contractProblems).
 *
 * Two stages, deliberately separate:
 *   1. COLLECT (JSON): every public module is parsed — its module doc,
 *      every `export` (functions, classes with their methods/getters,
 *      constants) with the JSDoc comment above it (description, @param,
 *      @returns), and re-exports resolved to their source module — into
 *      one JSON document (`--format json` prints it; every renderer
 *      consumes exactly this). Alongside the modules, ARCHITECTURE is
 *      discovered from actual import edges, `lib/<facade>/` helper
 *      folders and `bin/*`; CONTRACTS (context/provider/
 *      tool/timeout/auth/settings schemas) are collected FROM SOURCE —
 *      module docs, @typedef blocks, exported symbols, class members,
 *      const keys, a README table, and live settings — never copied as
 *      prose here, so code and docs are picked up on the next run. The
 *      TOOL CATALOG is AUTO-DETECTED the same
 *      way: every package `tools/*.js` module is imported and its
 *      toolDescription() result (describe() when toolDescription is
 *      undefined — the fallback; toolSchema() is the legacy alias)
 *      collected verbatim, harness metadata flags included.
 *   2. RENDER (callbacks): a renderer is a set of callbacks
 *      {document, contract, module, symbol, member} the driver
 *      (renderWith) calls while walking the JSON; `markdown` is the
 *      shipped one (compact, LLM-oriented: signatures first, prose
 *      second, no decoration). Add HTML/etc. by supplying another
 *      callback set.
 *
 * Hand-rolled parser (zero dependencies): it understands the code style
 * of this project — `export function|class|const|let`, `export { a, b }
 * from "./x.js"`, `export * as ns from`, and JSDoc `/** … *\/` blocks —
 * and nothing more. Good enough for a reference; not a JS parser.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename, relative, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TRANSPILER = new Bun.Transpiler({ loader: "js" }); // parse real imports, never quoted examples/comments
const SOURCE_EXTENSIONS = new Set([".js"]);
const isSourceFile = (entry) => entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name));

const PUBLIC_MODULES = [
  { name: "Markdown", file: "lib/markdown.js" },
  { name: "Context", file: "lib/context.js" },
  { name: "Env", file: "lib/env.js" },
  { name: "IO", file: "lib/io.js" },
  { name: "Agent", file: "lib/agent.js" },
  { name: "CLI", file: "lib/cli.js" },
  { name: "Jobs", file: "lib/jobs.js" },
  { name: "TUI", file: "lib/tui.js" },
  { name: "GTUI", file: "lib/gtui/gtui.js" },
  { name: "index", file: "lib/index.js" },
];

/* ========================================================== contracts */

/**
 * The schemas & contracts, each COLLECTED FROM SOURCE (no embedded
 * contract text below — only pointers to where the truth lives and
 * what to lift out of it):
 *   moduleDoc  - the file's module-level JSDoc prose
 *   typedefs   - every @typedef JSDoc block (name, properties)
 *   symbols    - named exports with their doc comments
 *   members    - named methods of one exported class, with docs
 *   objectKeys - the keys of a top-level `const X = {…}` literal
 *   table      - the rows of the markdown table under a `## <heading>`
 *   example    - the file's content, verbatim (a small live example)
 */
const CONTRACTS = [
  {
    name: "Jobs — activation, scheduling, execution and task files",
    sources: [
      { file: "lib/jobs.js", moduleDoc: true },
      { file: "lib/jobs/tasks.js", moduleDoc: true, symbols: ["parseTask", "parseTasks"] },
      { file: "lib/jobs/operations.js", symbols: ["scheduleJobs", "validateJobsOperational"] },
      { file: "lib/jobs/dispatcher.js", symbols: ["dispatchJobs", "cycleRecord"] },
      { file: "lib/jobs/agent-execution.js", moduleDoc: true },
      { file: "bin/scripts/jobs", moduleDoc: true },
    ],
  },
  {
    name: "Context schema — messages and content blocks",
    sources: [{ file: "lib/context/types.js", moduleDoc: true, typedefs: true }],
  },
  {
    name: "Provider contract",
    sources: [
      { file: "lib/env/provider.js", moduleDoc: true, symbols: ["defineProvider", "ProviderError", "classifyError"], objectKeys: ["INSTANCE_DEFAULTS", "methods completed with OpenAI defaults when the class lacks them"] },
      { file: "providers/ollama.js", moduleDoc: true, note: "reference implementation" },
    ],
  },
  {
    name: "Tool contract — PUBLISHES / REQUIRES / RETURNS (add a tool by reading this)",
    sources: [
      { label: "PUBLISHES — the module shape a tool file must export", file: "lib/env/tools.js", moduleDoc: true, symbols: ["scanToolRoots"] },
      { file: "lib/env/tool-registry.js", symbols: ["registerTool", "toolSchemas"] },
      { label: "PUBLISHES — a worked example: the minimal wrapper shape (read-only, no ctx)", file: "tools/read.js", example: true },
      { label: "PUBLISHES — a worked example: sandboxed (`sandbox: true`, forked, write-jailed)", file: "tools/write.js", example: true },
      { label: "REQUIRES — every in-process call's (args, ctx) signature: ctx = {question, env, call, agent}", file: "lib/agent.js", members: { class: "Agent", names: ["_toolContext", "_toolEnv"] } },
      { label: "REQUIRES — dispatch: which tools fork (sandboxed worker, REDUCED ctx) vs stay in-process (full ctx)", file: "lib/agent/tool-exec.js", symbols: ["callToolFor"] },
      { label: "REQUIRES — a worked example: an interactive tool (`interactive: true`) using ctx.question.ask", file: "tools/question.js", moduleDoc: true },
      { label: "REQUIRES — the forked worker's REDUCED ctx: {question: null, env} only — no `call`, no `agent`", file: "lib/agent/tool-worker.js", moduleDoc: true },
      { label: "RETURNS — every shape a tool's return value may take", file: "lib/agent/tool-exec.js", symbols: ["resultContent", "executeToolCall"] },
    ],
  },
  {
    name: "Agent identity and delegation metadata",
    sources: [
      { file: "lib/agent.js", members: { class: "Agent", names: ["parent", "children", "createChild", "childAdd", "childRemove", "name", "description", "spawnPermission", "setSpawnPermission"] } },
      { label: "Env.createAgent installation at the Agent/Env composition boundary", file: "lib/agent.js", moduleDoc: true },
      { file: "lib/env.js", members: { class: "Env", names: ["onEvent", "offEvent"] } },
      { file: "lib/env/events.js", symbols: ["ENV_EVENT"] },
    ],
  },
  {
    name: "Headless usage — running the Agent from your own script, no TUI",
    sources: [
      { label: "the headless core entry point: callbacks replace stdio/process.exit/terminal APIs", file: "lib/agent.js", moduleDoc: true },
      { label: "the reference consumer: a one-shot stdin-to-stdout tool loop, as a CLI", file: "bin/scripts/agent", moduleDoc: true },
    ],
  },
  {
    name: "Agent-owned tool timeout policy",
    sources: [
      { file: "lib/env/tool-timeout.js", moduleDoc: true, symbols: ["DEFAULT_TOOL_TIMEOUT", "DEFAULT_TOOL_TIMEOUT_LIMIT", "TOOL_ON_TIMEOUT_LIMIT"] },
      { file: "lib/agent/tool-timeout.js", moduleDoc: true, symbols: ["prepareToolTimeout", "runWithToolTimeout"] },
      { file: "lib/env.js", members: { class: "Env", names: ["toolTimeout", "toolTimeoutLimit"] } },
    ],
  },
  {
    name: "Agent-owned runaway guard — context-usage caps, settable",
    sources: [
      { file: "lib/env/context-guard.js", moduleDoc: true, symbols: ["DEFAULT_CONTEXT_GUARD_CAP", "DEFAULT_CONTEXT_GUARD_TURN_CAP", "configuredContextGuardCap", "configuredContextGuardTurnCap"] },
      { file: "lib/agent/run.js", symbols: ["contextGuardTrip"] },
      { file: "lib/env.js", members: { class: "Env", names: ["contextGuardCap", "contextGuardTurnCap"] } },
    ],
  },
  {
    name: "IO-failure retries and endpoint token-depletion — settable",
    sources: [
      { file: "lib/env/reliability.js", moduleDoc: true, symbols: ["DEFAULT_MAX_ATTEMPTS", "DEFAULT_RETRY_BASE", "DEFAULT_RETRY_MAX", "RETRYABLE_KINDS", "configuredMaxAttempts", "retryDelay", "awaitTimeout"] },
      { file: "lib/env/provider.js", symbols: ["depletionError"] },
      { file: "lib/env.js", members: { class: "Env", names: ["maxAttempts", "retryDelay"] } },
    ],
  },
  {
    name: "TUI input, cursor, mouse-selection, and questionnaire editing",
    sources: [
      { file: "lib/tui-app/input-controller.js", moduleDoc: true },
      { file: "lib/gtui/controls.js", symbols: ["createControls"] },
      { file: "lib/gtui/terminal-input.js", symbols: ["createTerminalInput"] },
      { file: "lib/tui-app/questionnaire-view.js", moduleDoc: true },
    ],
  },
  {
    name: "Endpoint/auth entity",
    sources: [
      { file: "lib/env.js", members: { class: "Env", names: ["endpointSettings", "refreshEndpointSettings", "authSet", "saveEndpoint"] } },
      { file: "settings.json", example: true },
    ],
  },
  {
    name: "Settings schema — the merged settings tree",
    sources: [
      { file: "lib/env/settings.js", moduleDoc: true },
      { file: "README.md", table: "Settings" },
    ],
  },
];

/* ============================================================ collect */

/**
 * Parse one JSDoc block into {description, params, returns, tags}.
 * @param {string} raw - the comment text between the markers
 */
function parseDoc(raw) {
  const lines = raw.split("\n").map((l) => l.replace(/^\s*\*\s?/, "").replace(/^\s+(?=@)/, "").replace(/\s+$/, ""));
  const doc = { description: "", params: [], returns: null, tags: [] };
  let current = null; // {kind, text}
  const flush = () => {
    if (!current) return;
    const text = current.text.trim();
    if (current.kind === "description") doc.description = text;
    else if (current.kind === "param") {
      const m = /^(?:\{([^}]*)\}\s*)?(\[?[\w.$]+(?:=[^\]]*)?\]?)\s*-?\s*([\s\S]*)$/.exec(text);
      if (m) doc.params.push({ type: m[1] ?? "", name: m[2], description: m[3].trim() });
    } else if (current.kind === "returns") {
      // greedy type capture: nested generics ({Promise<Map<…{…}>>}) keep their braces
      const m = /^(?:\{(.*)\}\s*)?([\s\S]*)$/.exec(text);
      doc.returns = { type: m?.[1] ?? "", description: (m?.[2] ?? "").trim() };
    } else doc.tags.push({ tag: current.kind, text });
    current = null;
  };
  current = { kind: "description", text: "" };
  for (const line of lines) {
    const tag = /^@(\w+)\s*([\s\S]*)$/.exec(line);
    if (tag) {
      flush();
      const kind = tag[1] === "return" ? "returns" : tag[1];
      current = { kind, text: tag[2] };
    } else if (current) {
      current.text += (current.text === "" ? "" : "\n") + line;
    }
  }
  flush();
  // a tag-only block ("/** @returns {X} what it is */") documents the
  // symbol through its returns/param text: that text is its description
  if (doc.description === "") {
    doc.description = doc.returns?.description || doc.params.map((p) => p.description).find(Boolean) || "";
  }
  return doc;
}

/** The JSDoc block that ends right before `index` (only whitespace between), or null. */
function docBefore(src, index) {
  const before = src.slice(0, index);
  // the block must be adjacent (nothing but whitespace between it and the symbol)
  if (!/\*\/\s*$/.test(before)) return null;
  const close = before.lastIndexOf("*/");
  const open = before.lastIndexOf("/**", close);
  if (open === -1) return null;
  return parseDoc(before.slice(open + 3, close));
}

/** The module-level doc: the first /** … *\/ block of the file. */
function moduleDoc(src) {
  const m = /^\s*\/\*\*([\s\S]*?)\*\//.exec(src);
  return m ? parseDoc(m[1]).description : "";
}

/** Extract a balanced (...) parameter list starting at `open` (index of "("). */
function paramList(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return "";
}

/** Compact a parameter list: collapse whitespace, drop default-object bodies. */
function compactParams(text) {
  return text.replace(/\s+/g, " ").replace(/= \{[^}]*\}/g, "= {…}").trim();
}

/** Find the matching "}" for the "{" at `open`. */
function blockEnd(src, open) {
  let depth = 0;
  let inStr = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 1; continue; }
    if (ch === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return src.length;
}

/** Class members: methods, getters, static methods AND static/instance
 *  fields (`static EVENT = EVENT;`) with their docs. */
/**
 * Callable own properties of a frozen object literal. This deliberately
 * recognizes syntax rather than names: exported namespaces and a function's
 * returned protocol object are both ordinary frozen objects.
 * @param {string} body - text inside the object braces
 * @returns {Array<{name: string, kind: string, signature: string, doc: object|null}>}
 */
function frozenObjectMembers(body) {
  const candidates = [...body.matchAll(/^(\s*)(?:(get|set)\s+)?([\w$]+)\s*(?::\s*(async\s*)?)?\(/gm)];
  const indents = [...body.matchAll(/^(\s*)\S/gm)].map((m) => m[1].length);
  const indent = Math.min(...indents);
  if (!Number.isFinite(indent)) return [];
  const members = [];
  for (const m of candidates) {
    if (m[1].length !== indent) continue;
    const open = m.index + m[0].length - 1;
    const close = open + paramList(body.slice(open), 0).length + 2;
    const following = body.slice(close).trimStart();
    // A callable object property is either shorthand (`name() {}`) or an
    // arrow property (`name: () =>`). Do not mistake calls in a value for it.
    if (!(following.startsWith("{") || following.startsWith("=>"))) continue;
    const accessor = m[2];
    const name = m[3];
    const async = Boolean(m[4]);
    const params = compactParams(paramList(body, open));
    members.push({
      name,
      kind: accessor ? `${accessor}ter` : "method",
      async,
      signature: `${async ? "async " : ""}${accessor ? `${accessor} ` : ""}${name}(${params})`,
      doc: docBefore(body, m.index),
    });
  }
  // Arrow properties are the dominant object-namespace form. Capture both
  // parenthesized and single-argument arrows, preserving their signature.
  for (const m of body.matchAll(/^(\s*)([\w$]+)\s*:\s*(async\s+)?(?:\(([^)]*)\)|([\w$]+))\s*=>/gm)) {
    if (m[1].length !== indent || members.some((member) => member.name === m[2])) continue;
    const doc = docBefore(body, m.index);
    members.push({ name: m[2], kind: "method", async: Boolean(m[3]), signature: `${m[3] ? "async " : ""}${m[2]}(${compactParams(m[4] ?? m[5] ?? "")})`, doc });
  }
  // A documented `name: factory(...)` or shorthand `factory,` is callable
  // when it references a local constructor helper. Its arguments are
  // implementation detail here, so retain a truthful variadic signature.
  for (const m of body.matchAll(/^(\s*)([\w$]+)(?:\s*:\s*[\w$]+\s*\(|\s*,|\s*$)/gm)) {
    if (m[1].length !== indent || members.some((member) => member.name === m[2])) continue;
    const doc = docBefore(body, m.index);
    if (doc) members.push({ name: m[2], kind: "method", async: false, signature: `${m[2]}(...)`, doc });
  }
  return members;
}

/** Locate a frozen object literal starting at an exported declaration's end. */
function frozenObjectAt(src, start) {
  const match = /=\s*(?:Object\.)?freeze\s*\(\s*\{/.exec(src.slice(start));
  if (!match) return null;
  const open = start + match.index + match[0].lastIndexOf("{");
  return { open, end: blockEnd(src, open) };
}

function classMembers(body) {
  const members = [];
  // class-level members sit at exactly two spaces of indentation; nested
  // statements (calls inside a method body) sit deeper and never match
  const re = /^ {2}(?=\S)(static\s+)?(async\s+)?(get\s+|set\s+)?(\*\s*)?([\w$]+)\s*(\(|=[^=])/gm;
  for (const m of body.matchAll(re)) {
    const name = m[5];
    if (name === "if" || name === "for" || name === "while" || name === "switch" || name === "return" || name === "catch") continue;
    if (name.startsWith("_")) continue; // private by convention
    const doc = docBefore(body, m.index);
    if (m[6].startsWith("=")) {
      members.push({
        name,
        kind: "field",
        static: Boolean(m[1]),
        async: false,
        signature: `${m[1] ? "static " : ""}${name}`,
        doc,
      });
      continue;
    }
    const open = m.index + m[0].length - 1;
    const params = compactParams(paramList(body, open));
    members.push({
      name,
      kind: name === "constructor" ? "constructor" : m[3] ? m[3].trim() + "ter" : "method",
      static: Boolean(m[1]),
      async: Boolean(m[2]),
      signature: `${m[1] ? "static " : ""}${m[3] ? m[3].trim() + " " : ""}${name}(${params})`,
      doc,
    });
  }
  return members;
}

/**
 * One method of one exported class, by name — INCLUDING "_"-prefixed
 * (private-by-convention) members that classMembers() always skips.
 * Only for CONTRACT sources that must document an internal protocol
 * shape (e.g. Agent._toolContext IS the (args, ctx) a tool receives);
 * never used for the public per-module symbol listing.
 * @param {string} src - the whole file source
 * @param {string} className
 * @param {string} memberName
 * @returns {object|null}
 */
function classMemberRaw(src, className, memberName) {
  const clsMatch = new RegExp(`^export\\s+class\\s+${className}\\b[^{]*\\{`, "m").exec(src);
  if (!clsMatch) return null;
  const open = src.indexOf("{", clsMatch.index);
  const body = src.slice(open + 1, blockEnd(src, open));
  const re = new RegExp(`^ {2}(?=\\S)(static\\s+)?(async\\s+)?(get\\s+|set\\s+)?(\\*\\s*)?(${memberName})\\s*\\(`, "m");
  const m = re.exec(body);
  if (!m) return null;
  const paramsOpen = m.index + m[0].length - 1;
  const params = compactParams(paramList(body, paramsOpen));
  return {
    name: memberName,
    kind: memberName === "constructor" ? "constructor" : m[3] ? m[3].trim() + "ter" : "method",
    static: Boolean(m[1]),
    async: Boolean(m[2]),
    signature: `${m[1] ? "static " : ""}${m[3] ? m[3].trim() + " " : ""}${memberName}(${params})`,
    doc: docBefore(body, m.index),
  };
}

/**
 * Collect the exports of one module file. Re-exports (`export { a }
 * from "./x.js"`) are resolved into the source module so the doc
 * comment comes along; `export * as ns` records a namespace export.
 * @param {string} file - absolute path
 * @param {Map<string, object>} cache - file -> parsed module
 * @returns {{file: string, doc: string, exports: Array}}
 */
function collectModule(file, cache) {
  if (cache.has(file)) return cache.get(file);
  const src = readFileSync(file, "utf8");
  const mod = { file, doc: moduleDoc(src), exports: [] };
  cache.set(file, mod);

  // local declarations
  const decl = /^export\s+(async\s+)?(function\*?|class|const|let|var)\s+([\w$]+)/gm;
  for (const m of src.matchAll(decl)) {
    const kind = m[2].startsWith("function") ? "function" : m[2] === "class" ? "class" : "constant";
    const name = m[3];
    const entry = { name, kind, from: file, doc: docBefore(src, m.index) };
    const after = m.index + m[0].length;
    if (kind === "function") {
      const open = src.indexOf("(", after);
      entry.signature = `${m[1] ? "async " : ""}${name}(${compactParams(paramList(src, open))})`;
    } else if (kind === "class") {
      const open = src.indexOf("{", after);
      const end = blockEnd(src, open);
      const ext = /^\s*extends\s+([\w$.]+)/.exec(src.slice(after, open));
      entry.signature = `class ${name}${ext ? ` extends ${ext[1]}` : ""}`;
      entry.members = classMembers(src.slice(open + 1, end));
    } else {
      // Frozen object exports are public namespaces. Their callable own
      // properties are API members just like methods on an exported class.
      const object = frozenObjectAt(src, after);
      if (object) entry.members = frozenObjectMembers(src.slice(object.open + 1, object.end));
      const line = src.slice(after, src.indexOf("\n", after));
      let value = /^\s*=\s*(.*?);?\s*$/.exec(line)?.[1] ?? "";
      // a multi-line literal: show its opening with an ellipsis, balanced
      const opens = (value.match(/[({[]/g) ?? []).length - (value.match(/[)}\]]/g) ?? []).length;
      if (opens > 0) value = `${value}…${value.includes("({") ? "})" : value.endsWith("{") ? "}" : value.endsWith("[") ? "]" : ")"}`;
      entry.signature = `${name} = ${value.length > 72 ? `${value.slice(0, 69)}…` : value}`;
    }
    if (kind === "function") {
      // A public factory may return a frozen protocol object. Expose its
      // callable contract without coupling this collector to any library.
      const paramsOpen = src.indexOf("(", after);
      const paramsClose = paramsOpen + paramList(src.slice(paramsOpen), 0).length + 1;
      const open = src.indexOf("{", paramsClose);
      const end = blockEnd(src, open);
      const functionBody = src.slice(open + 1, end);
      const returned = /\breturn\s+(?:Object\.)?freeze\s*\(\s*\{/.exec(functionBody);
      if (returned) {
        const objectOpen = open + 1 + returned.index + returned[0].lastIndexOf("{");
        entry.members = frozenObjectMembers(src.slice(objectOpen + 1, blockEnd(src, objectOpen)));
      }
    }
    mod.exports.push(entry);
  }

  // Imported names can be re-exported through a façade. Resolve them so the
  // public reference documents the owning module's actual contract.
  const imports = new Map();
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];/gm)) {
    for (const spec of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const [imported, local = imported] = spec.split(/\s+as\s+/).map((s) => s.trim());
      imports.set(local, { imported, file: resolve(dirname(file), m[2]) });
    }
  }
  // re-exports: export { a, b as c } from "./x.js"  |  export { a, b };
  const reexp = /^export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?\s*;/gm;
  for (const m of src.matchAll(reexp)) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const directTarget = m[2] ? collectModule(resolve(dirname(file), m[2]), cache) : mod;
    const reexportDoc = docBefore(src, m.index);
    for (const spec of names) {
      const [local, exported = local] = spec.split(/\s+as\s+/).map((s) => s.trim());
      const imported = !m[2] && imports.get(local);
      const target = imported ? collectModule(imported.file, cache) : directTarget;
      const found = target.exports.find((e) => e.name === (imported?.imported ?? local));
      if (!found) {
        if (target === mod) continue; // a local symbol exported by name: covered above
        // `default as Name` has no named source entry to resolve. Its
        // public re-export must carry an adjacent façade-level contract.
        mod.exports.push({ name: exported, kind: "unknown", from: target.file, doc: reexportDoc, signature: exported });
        continue;
      }
      if (target === mod) continue;
      mod.exports.push({ ...found, name: exported, from: found.from, doc: reexportDoc ?? found.doc });
    }
  }

  // namespace re-exports: export * as ns from "./x.js"
  const nsre = /^export\s*\*\s*as\s+([\w$]+)\s*from\s*["']([^"']+)["']/gm;
  for (const m of src.matchAll(nsre)) {
    const target = collectModule(resolve(dirname(file), m[2]), cache);
    mod.exports.push({
      name: m[1], kind: "namespace", from: target.file, signature: `${m[1]} (namespace of ${basename(target.file)})`,
      doc: { description: `The whole ${basename(target.file)} surface as a namespace.`, params: [], returns: null, tags: [] },
      members: target.exports.map((e) => ({ name: e.name, kind: e.kind, signature: e.signature, doc: e.doc })),
    });
  }
  return mod;
}

/**
 * All `@typedef` JSDoc blocks of a source file: [{name, type, description, properties}].
 * Properties are the block's @property lines ({type, name, description}).
 * @param {string} src
 */
function collectTypedefs(src) {
  const typedefs = [];
  for (const m of src.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    if (!/@typedef/.test(m[1])) continue;
    const doc = parseDoc(m[1]);
    const td = doc.tags.find((t) => t.tag === "typedef");
    if (!td) continue;
    const tm = /^(?:\{([^}]*)\}\s*)?([\w$]+)?\s*([\s\S]*)$/.exec(td.text);
    const description = doc.description || (tm?.[3] ?? "");
    const properties = doc.tags.filter((t) => t.tag === "property").map((p) => {
      const pm = /^(?:\{([^}]*)\}\s*)?(\[?[\w$.]+\]?)\s*-?\s*([\s\S]*)$/.exec(p.text);
      return { type: pm?.[1] ?? "", name: pm?.[2] ?? "", description: (pm?.[3] ?? "").trim() };
    });
    typedefs.push({ name: tm?.[2] ?? "", type: tm?.[1] ?? "", description: description.trim(), properties });
  }
  return typedefs;
}

/** The keys of a top-level `const <name> = {…}` literal. */
function collectObjectKeys(src, name) {
  const m = new RegExp(`^const ${name} = \\{`, "m").exec(src);
  if (!m) return [];
  const open = src.indexOf("{", m.index);
  const body = src.slice(open + 1, blockEnd(src, open));
  return [...body.matchAll(/^\s{2}([\w$]+):/gm)].map((k) => k[1]);
}

/** The rows of the markdown table under a `## <heading>` of a markdown file: [{key, meaning}]. */
function collectTableRows(src, heading) {
  const m = new RegExp(`^##\\s+${heading}\\s*$`, "m").exec(src);
  if (!m) return [];
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/^##\s/m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const rows = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2 || cells.every((c) => /^[-: ]*$/.test(c))) continue; // separator row
    if (cells[0] === "key") continue; // header row
    rows.push({ key: cells[0], meaning: cells.slice(1).join(" | ") });
  }
  return rows;
}

/**
 * Collect one contract source per its spec (see CONTRACTS). Unresolvable
 * requests are recorded in `missing` (the --check gate reports them).
 * @param {object} spec - one entry of a contract's sources[]
 * @param {Map<string, object>} cache - shared module cache
 * @param {string[]} missing - collects "<file>: <what>" drift notes
 */
function collectContractSource(spec, cache, missing) {
  const file = join(ROOT, spec.file);
  if (!existsSync(file)) {
    missing.push(`${spec.file}: file not found`);
    return { file: spec.file, missing: true };
  }
  const out = { file: spec.file };
  if (spec.note) out.note = spec.note;
  if (spec.label) out.label = spec.label;
  if (spec.example) {
    out.example = readFileSync(file, "utf8").trim();
    return out;
  }
  const src = readFileSync(file, "utf8");
  if (spec.moduleDoc) {
    out.doc = moduleDoc(src.replace(/^#![^\n]*\n/, "")); // executables carry a shebang before the doc block
    if (!out.doc) missing.push(`${spec.file}: no module doc`);
  }
  if (spec.typedefs) {
    out.typedefs = collectTypedefs(src);
    if (out.typedefs.length === 0) missing.push(`${spec.file}: no @typedef blocks`);
  }
  if (spec.objectKeys) {
    const [name, label] = spec.objectKeys;
    const keys = collectObjectKeys(src, name);
    if (keys.length === 0) missing.push(`${spec.file}: const ${name} not found`);
    out.objectKeys = { name, label, keys };
  }
  if (spec.table) {
    out.table = collectTableRows(src, spec.table);
    if (out.table.length === 0) missing.push(`${spec.file}: no table under "## ${spec.table}"`);
  }
  if (spec.symbols) {
    const mod = collectModule(file, cache);
    out.symbols = [];
    for (const name of spec.symbols) {
      const found = mod.exports.find((e) => e.name === name);
      if (found) out.symbols.push({ ...found, from: spec.file });
      else missing.push(`${spec.file}: export "${name}" not found`);
    }
  }
  if (spec.members) {
    const mod = collectModule(file, cache);
    const cls = mod.exports.find((e) => e.name === spec.members.class);
    out.members = [];
    for (const name of spec.members.names) {
      // the public listing (classMembers) skips "_"-prefixed members by
      // convention; a contract may still need to document one of them
      // as part of the actual runtime protocol (e.g. Agent._toolContext
      // IS the shape a tool call receives) — raw re-parse, source of
      // truth stays the file either way, never copied prose
      const found = cls?.members?.find((mem) => mem.name === name) ?? classMemberRaw(src, spec.members.class, name);
      if (found) out.members.push(found);
      else missing.push(`${spec.file}: ${spec.members.class}.${name} not found`);
    }
  }
  return out;
}

/**
 * Collect the schemas & contracts from their sources (see CONTRACTS).
 * @param {Map<string, object>} cache - shared module cache
 * @returns {{contracts: Array, missing: string[]}}
 */
export function collectContracts(cache = new Map()) {
  const missing = [];
  const contracts = CONTRACTS.map((c) => ({
    name: c.name,
    ...(c.see ? { see: c.see } : {}),
    sources: c.sources.map((s) => collectContractSource(s, cache, missing)),
  }));
  return { contracts, missing };
}

/** Harness metadata detectors (all values are stripped before publishing). */
const TOOL_FLAGS = {
  safe: (value) => value === true,
  trusted: (value) => value === true,
  interactive: (value) => value === true,
  sandbox: (value) => value === true,
  secret: (value) => value === true,
  onTimeout: (value) => typeof value === "function",
};

/**
 * AUTO-DETECT the package tools' schemas: every top-level
 * `tools/*.js` module is imported (lib/env.js first — tool wrappers
 * stamp their helper imports with the Env global) and its
 * toolDescription() result collected verbatim; describe() is the
 * fallback when toolDescription is undefined — the same precedence
 * the tool scan (lib/env/tools.js) applies. A module exporting neither,
 * and an entry lacking description/inputSchema, are DRIFT (the
 * --check gate reports them).
 * @param {string} [dir] - the tools folder (default: the package's)
 * @returns {Promise<{contract: object, missing: string[]}>}
 */
export async function collectToolCatalog(dir = join(ROOT, "tools")) {
  await import("../lib/env.js"); // the global tool wrappers stamp with
  const { isToolModuleFile } = await import("../lib/env.js"); // the public façade (never lib privates)
  const folder = resolve(dir); // imports need absolute file URLs
  const missing = [];
  const tools = [];
  let files = [];
  try {
    files = readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".js") && isToolModuleFile(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    missing.push(`${dir}: tools folder not readable`);
    return { contract: { name: "Tool catalog — the package tools' live schemas (auto-detected)", tools }, missing };
  }
  for (const name of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(join(folder, name)).href);
    } catch (err) {
      missing.push(`tools/${name}: import failed — ${err.message}`);
      continue;
    }
    // toolDescription() wins; describe() is the fallback when it is
    // undefined
    const describe = typeof mod.toolDescription === "function" ? mod.toolDescription
      : typeof mod.describe === "function" ? mod.describe
      : null;
    if (describe === null) {
      missing.push(`tools/${name}: no toolDescription()/describe()`);
      continue;
    }
    let described;
    try {
      described = describe();
    } catch (err) {
      missing.push(`tools/${name}: describe() threw — ${err.message}`);
      continue;
    }
    for (const [tool, schema] of Object.entries(described ?? {})) {
      // the same acceptance the tool scan applies: a static export, or a
      // schema-carried fn (tools/web.js's web-search/web-fetch pattern)
      if (typeof mod[tool] !== "function" && typeof schema?.fn !== "function") continue;
      if (typeof schema?.description !== "string" || schema.description === "") {
        missing.push(`tools/${name}: "${tool}" has no description`);
      }
      if (schema?.inputSchema === undefined || schema.inputSchema === null) {
        missing.push(`tools/${name}: "${tool}" has no inputSchema`);
      }
      tools.push({
        name: tool,
        file: `tools/${name}`,
        description: String(schema?.description ?? ""),
        flags: Object.entries(TOOL_FLAGS).filter(([key, test]) => test(schema?.[key])).map(([key]) => key),
        inputSchema: schema?.inputSchema ?? null,
      });
    }
  }
  return {
    contract: { name: "Tool catalog — the package tools' live schemas (auto-detected)", tools },
    missing,
  };
}

/**
 * AUTO-DETECT the DEFAULTS SCHEMA (lib/env/settings-schema.js): a
 * package-scoped Env loads ONLY the package's own tools/ (never
 * configured tool roots — this must build identically on every
 * machine) and env.defaultsSchema() is collected verbatim, so a
 * tool's own contributed key (tools/mcp.js's `mcp`) appears exactly
 * as it would at runtime. Each entry keeps its complete schema so
 * renderers can expose it on demand instead of expanding nested
 * defaults (such as themes) into the page.
 * @returns {Promise<{contract: object}>}
 */
export async function collectSettingsSchema() {
  const { Env } = await import("../lib/env.js");
  const env = new Env();
  await env.loadTools({ dirs: [join(ROOT, "tools")] });
  const schema = env.defaultsSchema();
  const entries = Object.entries(schema)
    .map(([key, setting]) => ({
      key,
      description: String(setting?.description ?? ""),
      schema: setting ?? {},
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { contract: { name: "Settings defaults schema — top-level keys (auto-detected)", entries } };
}

/** Compact parameter summary of a tool's inputSchema: name (required marked), type. */
function toolParams(inputSchema) {
  const properties = inputSchema?.properties;
  if (!properties || typeof properties !== "object") return [];
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  return Object.entries(properties).map(([name, spec]) => ({
    name,
    required: required.has(name),
    type: spec?.type ?? "any",
    description: firstLine(spec?.description ?? ""),
  }));
}

/** Project-relative path with stable slash separators. */
function rootPath(file) {
  return relative(ROOT, file).replaceAll("\\", "/");
}

/** Actual internal import/re-export targets, parsed by Bun (no quoted-example false positives). */
function sourceImports(file) {
  const src = readFileSync(file, "utf8");
  const paths = [];
  for (const entry of TRANSPILER.scan(src).imports) {
    if (!entry.path.startsWith(".")) continue;
    const target = resolve(dirname(file), entry.path.split("?")[0]);
    const rel = rootPath(target);
    if (rel === ".." || rel.startsWith("../") || !existsSync(target)) continue;
    if (!paths.includes(rel)) paths.push(rel);
  }
  return paths.sort();
}

/** Every .js file below one helper folder, project-relative. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(file));
    else if (isSourceFile(entry)) out.push(rootPath(file));
  }
  return out.sort();
}

/** Module-level doc for source that may start with an executable shebang. */
function sourceDoc(file) {
  return moduleDoc(readFileSync(file, "utf8").replace(/^#![^\n]*\n/, ""));
}

/**
 * One owned helper directory's file, chosen to represent the whole
 * directory in prose: `repl.js` when present (a rendering engine's own
 * entry point, historically), else the first file alphabetically.
 * @param {string[]} files - project-relative paths
 */
function representativeFile(files) {
  return files.find((f) => basename(f) === "repl.js") ?? files[0];
}

/**
 * Split a facade's owned helper directories into SHARED vs DISTINCT
 * groups when more than one directory competes for the same role (a
 * facade with two or more competing implementations of one concern).
 * A directory is "shared" when 2+ *other* owned directories import
 * from it; everything else is "distinct" (its own implementation). A
 * facade that owns a single directory is never split (kind "owned").
 * @param {Array<{name: string, path: string, files: string[], imports: string[]}>} ownedDirs
 * @returns {Array<{kind: "owned"|"shared"|"distinct", name: string, path: string, files: string[], usedBy: string[], label: string, publicDependencies: string[]}>}
 */
function classifyHelperGroups(ownedDirs, publicByFile) {
  const dirOfPath = (p) => ownedDirs.find((d) => d.files.includes(p));
  const incoming = new Map(ownedDirs.map((d) => [d.name, new Set()]));
  for (const d of ownedDirs) {
    for (const imp of d.imports) {
      const target = dirOfPath(imp);
      if (target && target.name !== d.name) incoming.get(target.name).add(d.name);
    }
  }
  const single = ownedDirs.length <= 1;
  return ownedDirs.map((d) => {
    const usedBy = [...incoming.get(d.name)];
    const shared = !single && usedBy.length >= 2;
    const rep = representativeFile(d.files);
    const label = single ? "" : shared
      ? `shared (used by ${usedBy.join(", ")})`
      : oneParagraph(sourceDoc(join(ROOT, rep))).replace(/^\S+\s+—\s+/, "") || d.name;
    return {
      kind: single ? "owned" : shared ? "shared" : "distinct",
      name: d.name,
      path: d.path,
      files: d.files,
      usedBy,
      label,
      publicDependencies: [...new Set(d.imports.map((t) => publicByFile.get(t)).filter(Boolean))],
    };
  });
}

/** An owned helper folder's name doesn't always share the façade's own
 *  basename (lib/gtui/ is owned by tui.js despite the name, per AI-TUI
 *  MIGRATION.md — it's the generic runtime tui-app/ is built on, not a
 *  tui-prefixed variant) — the one explicit exception to the
 *  name-prefix heuristic below. */
const FOLDER_OWNER_ALIASES = { gtui: "tui" };

/**
 * Collect architecture directly from the source tree: public façade
 * import edges, owned private helper folders (split into shared vs
 * distinct groups when a facade owns 2+ competing implementations),
 * executables, and Aiori's built-in IO modes. This replaces hand-maintained
 * architecture prose.
 * @param {Array<{name: string, file: string}>} modules
 * @returns {{layers: Array, executables: Array, connectors: Array}}
 */
export function collectArchitecture(modules = PUBLIC_MODULES) {
  const publicByFile = new Map(modules.map((m) => [m.file, m.name]));
  const libDir = join(ROOT, "lib");
  const helperDirs = readdirSync(libDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const layers = modules.map(({ name, file }) => {
    const facadeImports = sourceImports(join(ROOT, file));
    const base = basename(file, ".js");
    const ownedDirs = helperDirs
      .filter((entry) => entry.name === base || entry.name.startsWith(`${base}-`) || FOLDER_OWNER_ALIASES[entry.name] === base)
      .map((entry) => {
        const dir = join(libDir, entry.name);
        const files = sourceFiles(dir);
        const dirImports = [...new Set(files.flatMap((f) => sourceImports(join(ROOT, f))))].sort();
        return { name: entry.name, path: rootPath(dir), files, imports: dirImports };
      });
    const helperGroups = classifyHelperGroups(ownedDirs, publicByFile);
    // the facade's TRUE public dependencies: its own imports plus every
    // owned dir's (lazy-loaded engines never show up in the facade's
    // own static imports — see lib/tui.js's createRequire dispatch)
    const allImports = [...new Set([...facadeImports, ...ownedDirs.flatMap((d) => d.imports)])].sort();
    return {
      name,
      file,
      imports: allImports,
      publicDependencies: [...new Set(allImports.map((target) => publicByFile.get(target)).filter(Boolean))],
      helperGroups,
    };
  });
  // executables = the bin/ shims PLUS the bin/scripts implementations they
  // forward to (the shims are generated; the docs live with the scripts)
  const binDir = join(ROOT, "bin");
  const shimFiles = readdirSync(binDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .map((entry) => join(binDir, entry.name));
  const scriptFiles = readdirSync(join(binDir, "scripts"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .map((entry) => join(binDir, "scripts", entry.name));
  const executables = [...shimFiles, ...scriptFiles].map((file) => ({
    name: basename(file), file: rootPath(file), doc: sourceDoc(file), imports: sourceImports(file),
  }));
  const cliRunFile = join(ROOT, "lib", "tui-app", "cli-run.js");
  const cliRunSource = readFileSync(cliRunFile, "utf8");
  const modeList = /export const IO_MODES\s*=\s*Object\.freeze\(\[([^\]]+)\]\)/.exec(cliRunSource)?.[1] ?? "";
  const connectors = [...modeList.matchAll(/["']([^"']+)["']/g)].map((match) => ({
    name: match[1], file: rootPath(cliRunFile), doc: "Built-in IO mode.", imports: sourceImports(cliRunFile),
  }));
  return { layers, executables, connectors };
}

/** Methods installed on another exported class prototype at a composition
 * boundary (`Object.defineProperty(Env.prototype, "createAgent", …)`). */
function installedPrototypeMembers(src) {
  const members = [];
  const re = /Object\.defineProperty\(([\w$]+)\.prototype,\s*["']([\w$]+)["'],\s*\{/g;
  for (const m of src.matchAll(re)) {
    const open = src.indexOf("{", m.index + m[0].length - 1);
    const body = src.slice(open + 1, blockEnd(src, open));
    const value = /\bvalue\s*\(([^)]*)\)\s*\{/.exec(body);
    if (!value) continue;
    members.push({
      owner: m[1],
      member: {
        name: m[2], kind: "method", async: false,
        signature: `${m[2]}(${compactParams(value[1])})`,
        doc: docBefore(src, m.index),
      },
    });
  }
  return members;
}

/**
 * Collect the reference for a set of public modules (plus architecture,
 * contracts, and the auto-detected package tool catalog).
 * @param {Array<{name: string, file: string}>} modules
 * @returns {Promise<{generated: string, root: string, architecture: object, contracts: Array, contractDrift: string[], modules: Array}>} the JSON document
 */
/** The one alphabetical order every generated API artifact shares:
 *  case-insensitive by name, so API.md, API-schema.md, and the website
 *  pages/nav/search all present the same A–Z listing regardless of the
 *  source files' declaration order. */
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export async function collect(modules = PUBLIC_MODULES) {
  const cache = new Map();
  const { contracts, missing } = collectContracts(cache);
  const catalog = await collectToolCatalog();
  // Every presented list is alphabetical: declaration order in a source
  // file is no order at all for a reference. (Contract SOURCES keep
  // their specified narrative order — PUBLISHES → REQUIRES → RETURNS.)
  catalog.contract.tools.sort(byName);
  contracts.push(catalog.contract);
  missing.push(...catalog.missing);
  const settingsSchema = await collectSettingsSchema();
  contracts.push(settingsSchema.contract);
  contracts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const contract of contracts) {
    for (const source of contract.sources ?? []) {
      if (source.typedefs) source.typedefs = [...source.typedefs].sort(byName);
    }
  }
  const collectedModules = modules.map(({ name, file }) => {
    const mod = collectModule(join(ROOT, file), cache);
    return {
      name, file, doc: mod.doc,
      exports: mod.exports.map((e) => ({ ...e, from: e.from.startsWith(ROOT) ? e.from.slice(ROOT.length) : e.from })),
    };
  });
  for (const { file } of modules) {
    const sourceFile = join(ROOT, file);
    for (const installed of installedPrototypeMembers(readFileSync(sourceFile, "utf8"))) {
      const ownerModule = collectedModules.find((mod) => mod.exports.some((symbol) => symbol.kind === "class" && symbol.name === installed.owner));
      const owner = ownerModule?.exports.find((symbol) => symbol.kind === "class" && symbol.name === installed.owner);
      if (owner && !owner.members.some((member) => member.name === installed.member.name)) {
        owner.members.push({ ...installed.member, from: sourceFile.startsWith(ROOT) ? sourceFile.slice(ROOT.length) : sourceFile });
      }
    }
  }
  for (const mod of collectedModules) {
    mod.exports.sort(byName);
    for (const symbol of mod.exports) symbol.members?.sort(byName);
  }
  collectedModules.sort(byName);
  return {
    generated: new Date().toISOString().slice(0, 10),
    root: ".",
    architecture: collectArchitecture(modules),
    contracts,
    contractDrift: missing,
    modules: collectedModules,
  };
}

/* ============================================================= render */

/**
 * Walk the JSON document, calling the renderer's callbacks; returns
 * the concatenated output. Callbacks receive the node and a context
 * {document, contract, module, symbol} and return a string (or nothing).
 * @param {object} data - from collect()
 * @param {{document?: Function, contract?: Function, module?: Function, symbol?: Function, member?: Function, end?: Function}} callbacks
 * @returns {string}
 */
export function renderWith(data, callbacks) {
  const parts = [];
  const push = (s) => { if (s) parts.push(s); };
  push(callbacks.document?.(data));
  for (const contract of data.contracts ?? []) {
    push(callbacks.contract?.(contract, { document: data, contract }));
  }
  for (const module of data.modules) {
    const ctx = { document: data, module };
    push(callbacks.module?.(module, ctx));
    for (const symbol of module.exports) {
      push(callbacks.symbol?.(symbol, { ...ctx, symbol }));
      for (const member of symbol.members ?? []) {
        push(callbacks.member?.(member, { ...ctx, symbol, member }));
      }
    }
  }
  push(callbacks.end?.(data));
  return parts.join("");
}

/** Compact API-only renderer: one documented callable per entry. */
export const markdown = {
  document(data) { return "# API (" + data.generated + ")\n\n"; },
  module(module) { return "## " + module.name + "\n\n"; },
  symbol(symbol, { module }) {
    if (symbol.kind === "class" || symbol.kind === "namespace") return "";
    if (module.name === "index") return apiEntry(symbol.signature, symbol.doc);
    const open = symbol.signature.indexOf("(");
    const equals = symbol.signature.indexOf(" =");
    const qualified = symbol.kind === "function" && open >= 0
      ? `${symbol.signature.startsWith("async ") ? "async " : ""}${module.name}.${symbol.name}${symbol.signature.slice(open)}`
      : `${module.name}.${symbol.name}${equals >= 0 ? symbol.signature.slice(equals) : ""}`;
    return apiEntry(qualified, symbol.doc);
  },
  member(member, context) {
    const { module, symbol } = context;
    const signature = member.kind === "field" ? member.name : member.signature.replace(/^static\s+/, "");
    const owner = module.name !== "index" && symbol.name !== module.name
      ? `${module.name}.${symbol.name}`
      : symbol.name;
    const qualified = symbol.kind === "namespace" ? symbol.name + "." + member.name : owner + "." + signature;
    return apiEntry(qualified, member.doc);
  },
};

/** Render a standalone public API entry without expanding its JSDoc tags. */
function apiEntry(signature, doc) {
  const marker = String.fromCharCode(96);
  return "### " + marker + signature + marker + "\n\n" + (docSummary(doc?.description) || "(undocumented)") + "\n\n";
}

/** First sentence of a JSDoc description, retaining a useful short fallback. */
function docSummary(text) {
  const paragraph = oneParagraph(text);
  const end = paragraph.search(/[.!?](?:\s|$)/);
  return end < 0 ? paragraph : paragraph.slice(0, end + 1);
}

const firstLine = (text) => (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
const oneParagraph = (text) => (text ?? "").split(/\n\s*\n/)[0].split("\n").map((l) => l.trim()).join(" ");
/** The shipped renderers by name (add HTML etc. here). */
export const renderers = { markdown, json: null };

/** The full API.md text for the public modules (rendered markdown). */
export async function renderApiReference(modules = PUBLIC_MODULES) {
  return renderWith(await collect(modules), markdown).trimEnd() + "\n";
}

/** The "every public symbol is documented, every contract source
 *  resolves" gate as data: the exported symbols/members WITHOUT a doc
 *  comment plus contract sources that no longer resolve. An empty
 *  result passes (test/api-docs.test.js asserts it).
 * @param {object} data - collect()'s JSON document
 * @returns {string[]}
 */
export function contractProblems(data) {
  const missing = [...(data.contractDrift ?? [])];
  for (const m of data.modules) {
    for (const e of m.exports) {
      if (!e.doc || !e.doc.description) missing.push(`${m.file}: ${e.name} (${e.from})`);
      for (const member of e.members ?? []) {
        if (!member.doc || !member.doc.description) missing.push(`${m.file}: ${e.name}.${member.name} (${e.from})`);
      }
    }
  }
  return missing;
}
