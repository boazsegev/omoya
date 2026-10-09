// test/api-docs.test.js — OWNS documentation generation. API.md and
// API-schema.md are checked-in generated artifacts, and generation is
// not optional: every `bun test` run rewrites both from the live tree
// (a stale working tree simply becomes visibly dirty in git). The
// generator libraries live beside this file (test/api-reference.js,
// test/api-schema.js) — the tests are the only source of truth; their
// --check gates live here as assertions: every public export
// documented, every contract source resolving.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { collect, contractProblems, publicMembers, renderApiReference, toolCatalog, toolContract } from "./api-reference.js";
import { apiPages, buildApiLinks, linkApiReferences } from "../website/lib/api.js";
import { generate } from "./api-schema.js";
import { searchIndex } from "../website/lib/search.js";

describe("generated API documentation", () => {
  test("core and application entry exports keep their canonical namespace ownership", async () => {
    const Core = await import("../lib/agent.js");
    const AppEntry = await import("../lib/app.js");
    expect(Object.keys(Core).sort()).toEqual(["Agent", "default"]);
    expect(Object.keys(AppEntry).sort()).toEqual(["Agent", "App", "default"]);
    expect(Core.default).toBe(Core.Agent);
    expect(AppEntry.Agent).toBe(Core.Agent);
    expect(AppEntry.default).toEqual({ Agent: Core.Agent, App: AppEntry.App });
    const data = await collect();
    expect(data.modules.map(({ name }) => name)).toEqual(expect.arrayContaining(["Agent", "Agent.Context", "Agent.Env", "Agent.IO", "Agent.Jobs", "App"]));
    expect(data.modules.some(({ name }) => ["Context", "Env", "IO", "Jobs"].includes(name))).toBe(false);
    const links = buildApiLinks(data);
    for (const name of ["Context", "Env", "IO", "Jobs"]) {
      expect(links.resolve(`Agent.${name}`, "Agent")).toEqual({ slug: `agent.${name.toLowerCase()}`, hash: name });
    }
    const app = data.modules.find(({ name }) => name === "App");
    expect(app.exports.map(({ name }) => name)).toEqual(["App"]);
  });
  test("classes precede uppercase names and all other symbols use case-sensitive name order", async () => {
    const mod = { name: "Sample", exports: [] };
    const symbol = { name: "Sample", members: [
      { name: "alpha", kind: "method" }, { name: "Zoo", kind: "method" },
      { name: "Beta", kind: "property" }, { name: "AClass", kind: "class" },
      { name: "A_CONST", kind: "constant" }, { name: "apple", kind: "property" },
    ] };
    expect(publicMembers(mod, symbol).map(({ name }) => name)).toEqual([
      "AClass", "A_CONST", "Beta", "Zoo", "alpha", "apple",
    ]);
    const data = await collect();
    const agent = data.modules.find(({ name }) => name === "Agent");
    const members = publicMembers(agent, agent.exports.find(({ name }) => name === "Agent"));
    const names = members.map(({ name }) => name);
    expect(names.indexOf("EVENT")).toBeLessThan(names.indexOf("close"));
    const md = await renderApiReference();
    const html = apiPages(data).find(({ path }) => path === "/api/agent/").html;
    expect(md.indexOf("### `Agent.EVENT`")).toBeLessThan(md.indexOf("### `Agent.close()"));
    expect(html.indexOf('id="Agent-EVENT"')).toBeLessThan(html.indexOf('id="Agent-close"'));
    expect(html.indexOf('href="#Agent-EVENT"')).toBeLessThan(html.indexOf('href="#Agent-close"'));
  }, 20_000);

  test("constructor objects lead the case-sensitive name order on every documentation surface", async () => {
    const data = await collect();
    const mod = data.modules.find(({ name }) => name === "Agent");
    const symbol = mod.exports.find(({ name }) => name === "Agent");
    const members = publicMembers(mod, symbol);
    expect(members.slice(0, 4).map(({ name }) => name)).toEqual(["Context", "Env", "IO", "Jobs"]);
    const rest = members.slice(4).map(({ name }) => name);
    expect(rest).toEqual([...rest].sort());
    expect(rest.indexOf("EVENT")).toBeLessThan(rest.indexOf("close"));
    const context = data.modules.find(({ name }) => name === "Agent.Context");
    expect(context.exports[0].name).toBe("Context");
    const md = await renderApiReference();
    const html = apiPages(data).find(({ path }) => path === "/api/agent/").html;
    const schema = await generate();
    const labels = ["Context", "Env", "IO", "Jobs", "EVENT"];
    for (const [before, after] of labels.slice(1).map((label, index) => [labels[index], label])) {
      expect(md.indexOf(`### \`Agent.${before}\``)).toBeLessThan(md.indexOf(`### \`Agent.${after}\``));
      expect(html.indexOf(`id="Agent-${before}"`)).toBeLessThan(html.indexOf(`id="Agent-${after}"`));
      expect(html.indexOf(`href="#Agent-${before}"`)).toBeLessThan(html.indexOf(`href="#Agent-${after}"`));
      expect(schema.indexOf(`static ${before}:`)).toBeLessThan(schema.indexOf(`static ${after}:`));
    }
    expect(html).toContain('href="/api/agent.context/#Context"');
    expect(md).toContain("[Agent.Context](#agentcontext)");
    expect(schema.indexOf("export class Context")).toBeLessThan(schema.indexOf("export const ContentType:"));
  }, 20_000);

  test("architecture owns nested facade folders and uses the same alphabetical module order", async () => {
    const data = await collect();
    expect(data.architecture.layers.map(({ name }) => name)).toEqual(data.modules.map(({ name }) => name));
    const layers = new Map(data.architecture.layers.map((layer) => [layer.name, layer]));
    expect(layers.get("App.CLI").helperGroups.map(({ path }) => path)).toContain("lib/app/cli");
    expect(layers.get("App.TUI").helperGroups.map(({ path }) => path)).toContain("lib/app/tui");
    expect(layers.get("App.Markdown").helperGroups.map(({ path }) => path)).toContain("lib/app/markdown");
    expect(layers.get("App").helperGroups.map(({ path }) => path)).toEqual(expect.arrayContaining(["lib/app/cli", "lib/app/gtui", "lib/app/shared", "lib/app/tui", "lib/app/web"]));
    for (const layer of data.architecture.layers) {
      expect(layer.publicDependencies).not.toContain(layer.name);
      expect(layer.helperGroups.map(({ name }) => name)).toEqual(layer.helperGroups.map(({ name }) => name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
    }
    expect(data.architecture.executables.some(({ file }) => file.endsWith(".js"))).toBe(false);
    const html = apiPages(data).find(({ path }) => path === "/api/architecture/").html;
    expect(html.indexOf('id="agent"')).toBeLessThan(html.indexOf('id="agent.context"'));
    expect(html.indexOf('id="agent.jobs"')).toBeLessThan(html.indexOf('id="app"'));
    expect(html).toContain("Environment-only discovery is cached");
  }, 20_000);

  test("every public export is documented, every contract source resolves", async () => {
    const problems = contractProblems(await collect());
    expect(problems).toEqual([]);
  }, 20_000);

  test("instance data fields and both property accessors are documented consistently", async () => {
    const data = await collect();
    const klass = (name) => data.modules.find((module) => module.name === (name === "Agent" ? name : `Agent.${name}`)).exports.find((symbol) => symbol.name === name);
    expect(klass("Agent").members.map(({ name }) => name)).toEqual(expect.arrayContaining(["env", "context", "model", "can", "create"]));
    expect(klass("IO").members.map(({ name }) => name)).toEqual(expect.arrayContaining(["env", "model", "name", "url", "timeout", "provider", "Provider", "protocol", "cancel"]));
    expect(klass("Env").members.map(({ name }) => name)).toContain("folder");
    const Core = await import("../lib/agent.js");
    for (const name of ["Agent", "IO", "Env", "Context"]) {
      const documented = new Set(klass(name).members.map(({ name }) => name));
      const instance = name === "Context" ? new Core.default.Context({ save: false })
        : name === "Env" ? await Core.default.Env.open("./providers", { dir: "./providers", settingsDir: null })
        : name === "Agent" ? await Core.default.create({ env: await Core.default.Env.open("./ai-tmp/api-docs-agent", { dir: "./providers", settingsDir: null, settings: { system: "docs" } }) })
        : Object.create(Core.default.IO.prototype);
      const publicNames = [...Object.getOwnPropertyNames((name === "Agent" ? Core.default : Core.default[name])), ...Object.getOwnPropertyNames((name === "Agent" ? Core.default : Core.default[name]).prototype), ...Object.keys(instance)]
        .filter((key) => !key.startsWith("_") && !["length", "name", "prototype", "caller", "arguments"].includes(key));
      expect(publicNames.filter((key) => !documented.has(key)), `${name} runtime coverage`).toEqual([]);
      await instance.close?.();
      if (name === "Agent") await instance.env.close();
    }
    expect(klass("Context").members.map(({ name }) => name)).toEqual(expect.arrayContaining(["id", "dir", "uuid", "file", "origin", "name", "created", "contextUsage", "planUsage"]));
    const text = await generate();
    expect(text).toContain("model: { read: string|undefined; write: (selector: string|undefined) => void };");
    expect(text).not.toContain("model: (selector:");
    expect(Core.default).toBe(Core.Agent);
    expect(data.modules.find(({ name }) => name === "App").exports.find(({ name }) => name === "App").members.map(({ name }) => name)).toContain("CLI");
  }, 20_000);

  test("read/write properties publish one entry with both contracts across every surface", async () => {
    const data = await collect();
    const mod = data.modules.find(({ name }) => name === "Agent");
    const symbol = mod.exports.find(({ name }) => name === "Agent");
    const property = publicMembers(mod, symbol).filter(({ name }) => name === "model");
    expect(property).toHaveLength(1);
    expect(property[0].accessors.get.signature).toBe("get model()");
    expect(property[0].accessors.set.signature).toBe("set model(selector)");
    const md = await renderApiReference();
    expect(md.match(/^### `Agent.model`$/gm)).toHaveLength(1);
    expect(md).toContain("**Read** — `get model()`");
    expect(md).toContain("**Write** — `set model(selector)`");
    const schema = await generate();
    expect(schema).toContain("model: { read: string|undefined; write: (selector: string|undefined) => void };");
    expect(schema.match(/model: \{ read: string\|undefined; write: \(selector: string\|undefined\) => void \};/g)).toHaveLength(1);
    const pages = apiPages(data);
    const html = pages.find(({ path }) => path === "/api/agent/").html;
    expect(html.match(/id="Agent-model"/g)).toHaveLength(1);
    expect(html).not.toContain('id="Agent-model-1"');
    expect(html).toContain("Read: <code>get model()</code>");
    expect(html).toContain("Write: <code>set model(selector)</code>");
    expect(buildApiLinks(data).resolve("Agent.model", "Agent.Env")).toEqual({ slug: "agent", hash: "Agent-model" });
    const entries = searchIndex(pages.map((page) => page.search), data, data.generated).entries;
    expect(entries.filter(({ u }) => u === "/api/agent/#Agent-model")).toHaveLength(1);
    expect(entries.find(({ u }) => u === "/api/agent/#Agent-model").x).toContain("set model(selector)");
  }, 20_000);

  test("reference omits internal members and unexported Sandbox, while documenting Env.ready", async () => {
    const data = await collect();
    expect(data.modules.some((module) => module.name === "Sandbox")).toBe(false);
    const text = await renderApiReference();
    expect(text).not.toContain("## Sandbox\n");
    expect(text).not.toMatch(/^### `(?:Env|GTUI\.memory)\._/m);
    expect(text).toContain("### `Agent.Env.ready()`");
    expect(text).not.toMatch(/^### `(?:Env\._agentAdd|Env\._agentRemove|IO\.(?:requestSignal|modelCurrent|planUsage)|Agent\.(?:skillCatalog|promptCatalog|skillSection))`/m);
    expect(data.modules.map(({ name }) => name)).not.toEqual(expect.arrayContaining(["index", "index_app", "CLI", "TUI", "GTUI", "Markdown", "Web"]));
    expect(data.modules.map(({ name }) => name)).toEqual(expect.arrayContaining(["App.CLI", "App.TUI", "App.GTUI", "App.Markdown", "App.Web"]));
    expect(data.modules.find(({ name }) => name === "App.CLI").file).toBe("lib/app/cli.js");
    const agent = data.modules.find(({ name }) => name === "Agent").exports.find(({ name }) => name === "Agent");
    expect(agent.members.map(({ name }) => name)).toContain("skillLoad");
    expect(agent.members.map(({ name }) => name)).toContain("Jobs");
    for (const name of ["contextNew", "contextFork", "contextResume", "reseat", "policy", "toolStorage", "toolStorageClear", "toolMessageSet", "toolMessagesDetect", "backgroundStart", "backgroundList", "backgroundOutput", "backgroundStop", "backgroundStopAll", "questionInstall", "questionTimeoutReset", "folderResolve", "TOOL_TIMEOUT_DEFAULT"]) {
      expect(agent.members.some((member) => member.name === name), name).toBe(false);
    }
    const contextProperty = publicMembers(data.modules.find(({ name }) => name === "Agent"), agent).find(({ name }) => name === "context");
    expect(Object.keys(contextProperty.accessors)).toEqual(["get"]);
    expect(contextProperty.accessors.get.signature).toBe("get context()");
    expect(contextProperty.doc.returns.description).toContain("read-only");
    expect(publicMembers(data.modules.find(({ name }) => name === "Agent"), agent).find(({ name }) => name === "Jobs").reference).toEqual({ module: "Agent.Jobs", symbol: "Jobs" });
    const ioProperty = publicMembers(data.modules.find(({ name }) => name === "Agent"), agent).filter(({ name }) => name === "io");
    expect(ioProperty).toHaveLength(1);
    expect(Object.keys(ioProperty[0].accessors).sort()).toEqual(["get", "set"]);
    const env = data.modules.find(({ name }) => name === "Agent.Env").exports.find(({ name }) => name === "Env");
    expect(env.members.map(({ name }) => name)).toEqual(expect.arrayContaining(["skillCatalog", "promptCatalog", "skillSection"]));
    expect(text).toContain("### `Agent.skillLoad(names)`");
    expect(text).toContain("### `Agent.io`");
    expect(text).toContain("### `Agent.IO.cancel()`");
    expect(text).not.toContain("### `Agent.planUsage`");
    expect(text).toContain("### `Agent.Env.skillCatalog(options = {…})`");
    expect(text).toContain("### `Agent.Context.planUsage`");
  }, 20_000);

  test("website page, sidebar and links share the Markdown public-member policy", async () => {
    const data = await collect();
    const pages = apiPages(data);
    expect(pages.some((entry) => entry.path === "/api/sandbox/")).toBe(false);
    const env = pages.find((entry) => entry.path === "/api/agent.env/")?.html ?? "";
    const gtui = pages.find((entry) => entry.path === "/api/app.gtui/")?.html ?? "";
    const agent = pages.find((entry) => entry.path === "/api/agent/")?.html ?? "";
    expect(env).toContain('id="Env-ready"');
    expect(env).not.toContain('id="Env-_attachHooks"');
    expect(gtui).not.toContain('id="memory-_effect"');
    expect(agent).toContain('id="Agent-finishAdd"');
    expect(agent).not.toContain('id="finishAdd"');
    expect(agent).not.toContain('id="Agent-reseat"');
    expect(agent).not.toContain('id="Agent-contextNew"');
    expect(agent).toContain('id="Agent-Context"');
    expect(agent).toContain('href="/api/agent.context/#Context"');
    expect(buildApiLinks(data).resolve("Agent.Context.messageUser", "App")).toEqual({ slug: "agent.context", hash: "messageUser" });
    expect(buildApiLinks(data).resolve("Agent.Env.models", "App")).toEqual({ slug: "agent.env", hash: "Env-models" });
    expect(buildApiLinks(data).resolve("Env._attachHooks", "Agent.Env")).toBeNull();
    const entries = searchIndex(pages.map((page) => page.search), data, data.generated).entries;
    expect(entries.some((entry) => entry.u === "/api/agent.env/#Env-_attachHooks")).toBe(false);
    expect(entries.some((entry) => entry.u === "/api/agent.env/#Env-ready")).toBe(true);
    expect(entries.some((entry) => entry.t === "Agent.Context.planUsage" && entry.u === "/api/agent.context/#Context-planUsage")).toBe(true);
    expect(entries.some((entry) => entry.t === "Agent.Agent.Context.planUsage")).toBe(false);
    for (const entry of entries.filter((entry) => entry.u.includes("#"))) {
      const [path, hash] = entry.u.split("#");
      expect(pages.find((page) => page.path === path)?.html).toContain(`id="${hash}"`);
    }
  }, 20_000);

  test("GTUI frozen namespaces and factory protocols expose documented callables", async () => {
    const data = await collect();
    const gtui = data.modules.find((module) => module.name === "App.GTUI");
    const names = (symbol) => symbol.members.map((member) => member.name);
    expect(names(gtui.exports.find((symbol) => symbol.name === "view"))).toEqual(expect.arrayContaining(["text", "row", "menu"]));
    expect(names(gtui.exports.find((symbol) => symbol.name === "effect"))).toEqual(expect.arrayContaining(["task", "quit"]));
    expect(names(gtui.exports.find((symbol) => symbol.name === "event"))).toEqual(expect.arrayContaining(["key", "taskFailed"]));
    expect(names(gtui.exports.find((symbol) => symbol.name === "host"))).toEqual(["memory", "terminal"]);
    const text = await renderApiReference();
    expect(text).toContain("### `App.GTUI.view.text(props = {…}, content = \"\")`");
    expect(text).toContain("### `App.GTUI.effect.task(key, run)`");
    expect(text).toContain("### `App.GTUI.event.key(payload)`");
  }, 20_000);

  test("Env plugin members appear on Env, documented from their plugin", async () => {
    const data = await collect();
    const env = data.modules.find((module) => module.name === "Agent.Env");
    const klass = env.exports.find((symbol) => symbol.name === "Env");
    expect(klass.members.find((member) => member.name === "agentCreate")).toMatchObject({
      signature: "async agentCreate(options = {…})",
      from: "lib/agent/env-plugin.js",
    });
    expect(klass.members.find((member) => member.name === "agents")?.from).toBe("lib/agent/env-plugin.js");
  }, 20_000);

  test("API cross-references link method-call notation across modules", async () => {
    const data = await collect();
    const html = linkApiReferences("<p><code>Agent.close()</code></p>", buildApiLinks(data), "Agent.Env");
    // Root-relative: deployed pages are extensionless clean URLs (/api/env),
    // where a relative "./agent/" would resolve to /agent — outside the API tree.
    expect(html).toBe('<p><a href="/api/agent/#Agent-close"><code>Agent.close()</code></a></p>');
    // Same-module mentions stay fragment-only.
    const local = linkApiReferences("<p><code>Agent.Env.settings</code></p>", buildApiLinks(data), "Agent.Env");
    expect(local).toBe('<p><a href="#Env-settings"><code>Agent.Env.settings</code></a></p>');
  }, 20_000);

  test("both references document the tool contract and the same live catalog", async () => {
    const data = await collect();
    const md = await renderApiReference();
    const schema = await generate();
    expect(toolContract(data).sources.length).toBeGreaterThan(0);
    expect(md).toContain("## Tool contract — PUBLISHES / REQUIRES / RETURNS");
    expect(md).toContain("## Core tool catalog (live schemas)");
    expect(schema).toContain("## Core tool catalog (live schemas)");
    expect(schema).toContain("Env.toolArguments");
    for (const tool of toolCatalog(data).tools) {
      expect(md).toContain(`### \`${tool.name}\``);
      expect(md).toContain(tool.description);
      expect(schema).toContain(`Env.toolDescription.${tool.name}.inputSchema`);
      expect(schema).toContain(tool.description);
    }
  }, 20_000);

  test("compact schemas retain object fields and prose for mixed-shape inputs", async () => {
    const text = await generate();
    for (const name of ["edit", "write"]) {
      const section = text.split(`### \`Env.toolDescription.${name}.inputSchema\`\n\n\`\`\`schema\n`)[1]?.split("\n```")[0];
      expect(section).toContain('"path');
      expect(section).not.toBe('"unknown"');
    }
    expect(text).toContain('"glob?": "Only files matching a glob');
    expect(text).toContain('"notes?": "set: a map');
    expect(text).toContain('"forms": "Task schedule: a string');
    expect(text).toContain('"forms": "Optional focused preview: a plain string');
  }, 20_000);

  test("API.md regenerates from the live tree on every run", async () => {
    const text = await renderApiReference();
    writeFileSync("API.md", text);
    expect(readFileSync("API.md", "utf8")).toBe(text);
    expect(text).toContain("# API (");
  }, 20_000);

  test("both renderers publish the FULL doc: class doc, params, returns (JobsError)", async () => {
    // The collected doc is the single source; both surfaces must show all of it.
    const data = await collect();
    const jobsError = data.modules.find((m) => m.name === "Agent.Jobs").exports.find((e) => e.name === "JobsError");
    expect(jobsError.doc.description).toContain("Error type used for actionable Jobs failures");
    const ctor = jobsError.members.find((m) => m.name === "constructor");
    expect(ctor.doc.params.map((p) => p.name)).toEqual(["code", "message", "[details={}]"]);
    expect(ctor.doc.returns.type).toBe("JobsError");

    // API.md (markdown): the class doc block exists (never omitted), and the
    // constructor publishes every @param and the @returns.
    const md = await renderApiReference();
    expect(md).toContain("### `class JobsError extends Error`");
    expect(md).toContain("Error type used for actionable Jobs failures.");
    expect(md).toContain("- `code` (string) — Stable error code");
    expect(md).toContain("- `[details={}]` (object)");
    expect(md).toContain("Returns `JobsError`");

    // Website (HTML): the same member publishes the same params and returns.
    const { apiPages } = await import("../website/lib/api.js");
    const html = apiPages(data).find((p) => p.path === "/api/agent.jobs/").html;
    const section = html.split('id="JobsError-constructor"')[1]?.split("</section>")[0] ?? "";
    expect(section).toContain("Stable error code identifying the failure.");
    expect(section).toContain("Optional contextual data");
    expect(section).toContain("Returns <code>JobsError</code>");
  }, 20_000);

  test("settings schema includes live nested defaults and dynamic-key contracts", async () => {
    const text = await generate();
    const settings = text.split("### `Env.settings`\n\n```schema\n")[1]?.split("\n```")[0];
    expect(settings).toContain('"tui": {');
    expect(settings).toContain('"cursor": {');
    expect(settings).toContain('"blink": "number"');
    expect(settings).toContain('"web": {');
    expect(settings).toContain('"collapse": {');
    expect(settings).toContain('"thinking": "boolean"');
    expect(settings).toContain('"tools": {');
    expect(settings).toContain('"timeout": "number"');
    expect(settings).toContain('"read": {');
    expect(settings).toContain('"<server>": {');
    expect(settings).toContain('"env": {');
    expect(settings).toContain('"<NAME>": "false | true | string"');
    expect(settings).toContain('"providers": {');
    expect(settings).toContain('"<tool>": "boolean"');
    expect(settings).not.toContain('"providerTools": {');
    expect(settings).toContain('"folders": {');
    expect(settings).not.toContain('"tui": "unknown"');
  }, 20_000);

  test("API-schema.md regenerates from the live tree on every run", async () => {
    const text = await generate();
    writeFileSync("API-schema.md", text);
    expect(readFileSync("API-schema.md", "utf8")).toBe(text);
    expect(text).toStartWith("# API schema");
    expect(text).toContain('"autocompactMax": "nonnegative safe integer (tokens; default 200000; 0 disables)"');
  }, 20_000);
});
