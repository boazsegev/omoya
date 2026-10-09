/** test/api-schema.js — LIBRARY for the doc tests: generate the quiet
 *  public-contract schema reference (API-schema.md). No CLI —
 *  test/api-docs.test.js rewrites the file on every `bun test` run. */
import { collect, publicMembers, toolCatalog, toolContract } from "./api-reference.js";

const tick = String.fromCharCode(96);
const fence = `${tick}${tick}${tick}`;
const TYPE_FENCE = "ts";
const shapes = {
  "context.autocompact": "boolean | number (default 0.4; true = 0.4; fractions < 1 or percentages > 1; false/0/1/100 disable)",
  "context.autocompactMax": "nonnegative safe integer (tokens; default 200000; 0 disables)",
  projects: { "<absolute folder or name alias>": { folder: "absolute folder", name: "shortest unique folder suffix", "models?": "<endpoint>/<model> -> ISO timestamp", "groups?": "<group> -> boolean", "description?": "string" } },
  env: { "<NAME>": "false | true | string" },
  extensions: { "<package-or-folder>": "boolean" },
  prompts: { "<path>": "boolean" },
  skills: { "<path>": "boolean" },
  "tools.folders": { "<path>": "boolean" },
  "tui.keys": { "<key>": "key binding" },
  mcp: { "<server>": { command: "string", args: "string[]", env: "object", timeout: "number", safe: "boolean", description: "string" } },
  providers: { tools: { "<tool>": "boolean" }, "<endpoint>": { provider: "string", url: "string", model: "string", timeout: "number", contextWindow: "number", models: "object" } },
  themes: { "<theme>": {
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
  if (member.kind === "property") return returnType(member.accessors.get ?? member.accessors.set);
  if (member.kind === "getter") return returnType(member);
  if (member.kind === "constructor") return `constructor(${parameters(member)})`;
  if (member.kind === "field" || member.kind === "class") return returnType(member);
  return functionType(member);
}
function memberDeclaration(member) {
  const prefix = member.static ? "static " : "";
  if (member.kind === "constructor") return memberType(member);
  if (member.kind === "property") {
    const read = member.accessors.get && `read: ${returnType(member.accessors.get)}`;
    const write = member.accessors.set && `write: (${parameters(member.accessors.set)}) => void`;
    return `${prefix}${member.name}: { ${[read, write].filter(Boolean).join("; ")} }`;
  }
  if (member.kind === "getter") return `${prefix}get ${member.name}(): ${returnType(member)}`;
  if (member.kind === "setter") return `${prefix}set ${member.name}(${parameters(member)})`;
  return `${prefix}${member.name}: ${memberType(member)}`;
}
function inputSchema(schema) {
  const alternatives = schema?.anyOf ?? schema?.oneOf;
  if (alternatives && (!schema.properties || alternatives.some((branch) => branch.properties || branch.type))) {
    const variants = alternatives.map(inputSchema);
    const unique = [...new Map(variants.map((variant) => [JSON.stringify(variant), variant])).values()];
    return unique.length === 1 ? unique[0] : { union: unique };
  }
  if (schema?.enum) return schema.enum;
  if (!schema?.properties || typeof schema.properties !== "object") {
    if (schema?.const !== undefined) return { const: schema.const };
    return schema?.type === "array" && schema.items ? { array: inputSchema(schema.items) } : schema?.type || schema?.description || "unknown";
  }
  const required = new Set(schema.required || []);
  const fields = Object.fromEntries(Object.entries(schema.properties).map(([key, spec]) => [required.has(key) ? key : `${key}?`, inputSchema(spec)]));
  return !schema.type && schema.description ? { forms: schema.description, fields } : fields;
}
function publicSchemas(data) {
  const renderedClasses = new Set();
  let out = "";
  for (const module of data.modules) {
    for (const symbol of module.exports) {
      if (symbol.kind === "class") {
        if (renderedClasses.has(symbol.name)) continue;
        renderedClasses.add(symbol.name);
        const lines = publicMembers(module, symbol).map((member) => `  ${memberDeclaration(member)};`);
        out += typeSection(module.name === symbol.name || module.name.endsWith(`.${symbol.name}`) ? module.name : `${module.name}.${symbol.name}`, `export class ${symbol.name} {\n${lines.join("\n")}\n}`);
        continue;
      }
      const declaration = symbol.kind === "function"
        ? `export const ${symbol.name}: ${functionType(symbol)};`
        : `export const ${symbol.name}: unknown;`;
      out += typeSection(`${module.name}.${symbol.name}`, declaration);
      const members = publicMembers(module, symbol);
      if (members.length) out += typeSection(`${module.name}.${symbol.name} members`, members.map((member) => `${memberDeclaration(member)};`).join("\n"));
    }
  }
  return out;
}
function infer(value, path = "") {
  if (shapes[path] !== undefined) return shapes[path];
  if (Array.isArray(value)) return value.length ? `${infer(value[0])}[]` : "unknown[]";
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, infer(item, path ? `${path}.${key}` : key)]));
  return value === undefined ? "unknown" : typeof value;
}
function combine(base, contributed) {
  if (!base || typeof base !== "object" || Array.isArray(base)) return contributed ?? base;
  if (!contributed || typeof contributed !== "object" || Array.isArray(contributed)) return base;
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(contributed)])]
    .map((key) => [key, combine(base[key], contributed[key])]));
}
/** Derive the live settings contract once for both the Markdown schema and website. */
export function settingsSchemaValues(data) {
  const contract = data.contracts.find((item) => Array.isArray(item.entries));
  return Object.fromEntries((contract?.entries || []).map((entry) =>
    [entry.key, infer(combine(entry.coreDefault, entry.value), entry.key)]));
}
function settingsSchemas(data) {
  return schemaSection("Env.settings", settingsSchemaValues(data));
}
function typedefSchemas(data) {
  const context = data.contracts.find((item) => item.name.startsWith("Context schema"));
  let out = "";
  for (const source of context?.sources || []) for (const type of source.typedefs || []) {
    const value = type.properties.length ? Object.fromEntries(type.properties.map((property) => [property.name, property.type || "unknown"])) : type.type || "object";
    out += schemaSection(`Agent.Context.${type.name}`, value);
  }
  return out;
}
function contracts(data) {
  const catalog = toolCatalog(data);
  const contract = toolContract(data);
  let out = `## ${contract.name}\n\n${contract.sources.map((source) => `- ${source.label ?? source.file} — \`${source.file}\``).join("\n")}\n\n`;
  out += schemaSection("Env.toolArguments", { args: "object matching the tool's inputSchema (parsed JSON)", context: "Internal Agent dispatch context (in-process); serializable worker ctx with env, sandbox, deadline, onData, agent.folder and optional question bridge" });
  out += schemaSection("Tool execution context (not a public constructor)", { question: "{ ask(questions): Promise<answers> } | null", env: "Env", safe: "boolean", selector: "string | undefined", io: "IO | undefined", call: "{callId: string, name: string} | undefined", agent: "Agent | undefined", storage: "object | undefined", trusted: "boolean", resetTimeout: "() => void", "statusSet?": "(info: object) => void" });
  out += schemaSection("Env.toolReturn", { result: "string | Content[] | { content: Content[] } | JSON", "system?": "string | string[]", "display?": "string | string[]" });
  out += schemaSection("Env.toolCallResult", { type: 4, callId: "string", name: "string", "error?": "boolean", content: "Content[]" });
  out += schemaSection("Env.toolDescription", { description: "string", inputSchema: "JSON Schema", "safe?": "boolean", "trusted?": "boolean", "interactive?": "boolean", "sandbox?": "boolean", "secret?": "boolean", "fn?": "(args, context) => result | Promise<result>", "onTimeout?": "function(args, context)" });
  out += "## Core tool catalog (live schemas)\n\n";
  for (const tool of catalog?.tools || []) {
    out += `${tool.description}\n\nSource: \`${tool.file}\`${tool.flags.length ? `; flags: ${tool.flags.join(", ")}` : ""}\n\n`;
    out += schemaSection(`Env.toolDescription.${tool.name}.inputSchema`, inputSchema(tool.inputSchema));
  }
  return out;
}
export async function generate() { const data = await collect(); return "# API schema\n\nCompact contract notation, not executable TypeScript or a validation schema. Accessors share one published property with separate read and write contracts. The full API reference contains their effects and ownership rules.\n\n" + settingsSchemas(data) + typedefSchemas(data) + contracts(data) + publicSchemas(data); }
