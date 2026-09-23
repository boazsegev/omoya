/** test/api-schema.js — LIBRARY for the doc tests: generate the quiet
 *  public-contract schema reference (API-schema.md). No CLI —
 *  test/api-docs.test.js rewrites the file on every `bun test` run. */
import { collect } from "./api-reference.js";

const tick = String.fromCharCode(96);
const fence = `${tick}${tick}${tick}`;
const TYPE_FENCE = "ts";
const shapes = {
  mcp: { "<server>": { command: "string", args: "string[]", env: "object", timeout: "number", safe: "boolean", description: "string" } },
  providers: { "<endpoint>": { provider: "string", url: "string", model: "string", timeout: "number", contextWindow: "number", models: "object" } },
  "tui.themes": { "<theme>": {
    parent: "theme name | default",
    "<role>": { fg: "color | {dark, light, default}", bg: "color | {dark, light, default}", bold: "boolean", dim: "boolean", italic: "boolean", underline: "boolean", reverse: "boolean", strike: "boolean" },
    "tool.preview": { maxRows: "positive integer" },
    "message.thinking.preview": { maxRows: "positive integer" },
  } },
};
function orderedEntries(value) {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
function render(value, indent = "") {
  if (Array.isArray(value)) return `[${value.map((v) => render(v, indent)).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = orderedEntries(value);
    if (!entries.length) return "{}";
    const next = `${indent}  `;
    return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${render(v, next)},`).join("\n")}\n${indent}}`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
function schemaSection(name, value) { return `### ${tick}${name}${tick}\n\n${fence}schema\n${render(value)}\n${fence}\n\n`; }
function typeSection(name, text) { return `### ${tick}${name}${tick}\n\n${fence}${TYPE_FENCE}\n${text}\n${fence}\n\n`; }
function parameterText(signature = "") {
  const open = signature.indexOf("(");
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === "(") depth++;
    if (signature[i] === ")" && --depth === 0) return signature.slice(open + 1, i);
  }
  return "";
}
function parameters(symbol) {
  const documented = new Map((symbol.doc?.params || []).map((param) => [param.name.replace(/[\[\]]/g, "").split("=")[0], param]));
  const raw = parameterText(symbol.signature).trim();
  if (!raw) return "";
  // A destructured/default parameter stays one TypeScript parameter;
  // JSDoc supplies its outer type where available.
  if (raw.startsWith("{") || raw.startsWith("[")) return `options?: ${documented.get("options")?.type || "object"}`;
  return raw.split(/,\s*/).map((item) => {
    const name = item.replace(/^\.\.\./, "").replace(/\s*=.*$/, "").trim();
    const param = documented.get(name);
    const optional = item.includes("=") || item.startsWith("[") ? "?" : "";
    return `${name}${optional}: ${param?.type || "unknown"}`;
  }).join(", ");
}
function returnType(symbol) {
  return (symbol.doc?.returns?.type || "unknown").trim() || "unknown";
}
function functionType(symbol) { return `(${parameters(symbol)}) => ${returnType(symbol)}`; }
function memberType(member) {
  if (member.kind === "getter") return returnType(member);
  if (member.kind === "constructor") return `constructor(${parameters(member)})`;
  if (member.kind === "field") return "unknown";
  return functionType(member);
}
function inputSchema(schema) {
  if (!schema?.properties || typeof schema.properties !== "object") return schema?.type || "unknown";
  const required = new Set(schema.required || []);
  return Object.fromEntries(Object.entries(schema.properties).map(([key, spec]) => [required.has(key) ? key : `${key}?`, spec?.enum || spec?.type || "unknown"]));
}
function publicSchemas(data) {
  const renderedClasses = new Set();
  let out = "";
  for (const module of data.modules) {
    if (module.name === "index") continue; // aggregate re-exports add no contract
    const exports = module.exports.filter((symbol) => symbol.kind !== "class");
    if (exports.length > 0) {
      const lines = exports
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
        .map((symbol) => symbol.kind === "function"
          ? `export const ${symbol.name}: ${functionType(symbol)};`
          : `export const ${symbol.name}: unknown;`);
      out += typeSection(`${module.name} module`, lines.join("\n"));
    }
    for (const symbol of module.exports) {
      if (symbol.kind !== "class" || renderedClasses.has(symbol.name)) continue;
      renderedClasses.add(symbol.name);
      const lines = (symbol.members || [])
        .filter((member) => !(symbol.name === "Env" && member.name === "settings"))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
        .map((member) => member.kind === "constructor" ? `  ${memberType(member)};` : `  ${member.static ? "static " : ""}${member.name}: ${memberType(member)};`);
      out += typeSection(symbol.name, `export class ${symbol.name} {\n${lines.join("\n")}\n}`);
    }
  }
  return out;
}
function settingsSchemas(data) {
  const contract = data.contracts.find((item) => Array.isArray(item.entries));
  const values = {};
  for (const entry of contract?.entries || []) values[entry.key] = shapes[entry.key] || (entry.default === undefined ? "unknown" : entry.default);
  return schemaSection("Env.settings", values);
}
function typedefSchemas(data) {
  const context = data.contracts.find((item) => item.name.startsWith("Context schema"));
  let out = "";
  for (const source of context?.sources || []) for (const type of source.typedefs || []) {
    const value = type.properties.length ? Object.fromEntries(type.properties.map((property) => [property.name, property.type || "unknown"])) : type.type || "object";
    out += schemaSection(`Context.${type.name}`, value);
  }
  return out;
}
function contracts(data) {
  const catalog = data.contracts.find((item) => Array.isArray(item.tools));
  // Tool modules publish toolDescription() (or the describe() fallback);
  // these call-time contracts are owned by Env's registry surface.
  let out = schemaSection("Env.toolContext", { question: "{ ask(questions): Promise<answers> } | null", env: "Env", call: "ToolCallContent | undefined", agent: "Agent | undefined" });
  out += schemaSection("Env.toolReturn", { result: "string | Content[] | { content: Content[] } | JSON", "system?": "string | string[]", "display?": "string | string[]" });
  out += schemaSection("Env.toolCallResult", { type: 4, callId: "string", name: "string", "error?": "boolean", content: "Content[]" });
  out += schemaSection("Env.toolDescription", { description: "string", inputSchema: "JSON Schema", "safe?": "boolean", "interactive?": "boolean", "sandbox?": "boolean", "secret?": "boolean", "onTimeout?": "function(args, context)" });
  for (const tool of catalog?.tools || []) out += schemaSection(`Env.toolDescription.${tool.name}.inputSchema`, inputSchema(tool.inputSchema));
  return out;
}
export async function generate() { const data = await collect(); return "# API schema\n\n" + settingsSchemas(data) + typedefSchemas(data) + contracts(data) + publicSchemas(data); }
