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
import { collect, contractProblems, renderApiReference, toolCatalog, toolContract } from "./api-reference.js";
import { buildApiLinks, linkApiReferences } from "../website/lib/api.js";
import { generate } from "./api-schema.js";

describe("generated API documentation", () => {
  test("every public export is documented, every contract source resolves", async () => {
    const problems = contractProblems(await collect());
    expect(problems).toEqual([]);
  }, 20_000);

  test("instance data fields and both property accessors are documented consistently", async () => {
    const data = await collect();
    const klass = (name) => data.modules.find((module) => module.name === name).exports.find((symbol) => symbol.name === name);
    expect(klass("Agent").members.map(({ name }) => name)).toEqual(expect.arrayContaining(["env", "context", "url", "timeout", "settings", "model"]));
    expect(klass("IO").members.map(({ name }) => name)).toEqual(expect.arrayContaining(["env", "model", "name", "url", "timeout", "provider", "Provider", "protocol"]));
    expect(klass("Env").members.map(({ name }) => name)).toContain("cwd");
    const Core = (await import("../lib/index.js")).default;
    for (const name of ["Agent", "IO", "Env", "Context"]) {
      const documented = new Set(klass(name).members.map(({ name }) => name));
      const instance = name === "Context" ? new Core.Context({ save: false })
        : name === "Env" ? new Core.Env({ dir: "./providers", cwd: "./providers", settingsDir: null })
        : name === "Agent" ? new Core.Agent({ env: new Core.Env({ dir: "./providers", cwd: "./providers", settingsDir: null, settings: { system: "docs" } }) })
        : Object.create(Core.IO.prototype);
      const publicNames = [...Object.getOwnPropertyNames(Core[name]), ...Object.getOwnPropertyNames(Core[name].prototype), ...Object.keys(instance)]
        .filter((key) => !key.startsWith("_") && !["length", "name", "prototype", "caller", "arguments"].includes(key));
      expect(publicNames.filter((key) => !documented.has(key)), `${name} runtime coverage`).toEqual([]);
      await instance.close?.();
    }
    expect(klass("Context").members.map(({ name }) => name)).toEqual(expect.arrayContaining(["id", "dir", "uuid", "file", "origin", "name", "created"]));
    const text = await generate();
    expect(text).toContain("get model(): string|undefined;");
    expect(text).toContain("set model(selector: string|undefined);");
    expect(text).not.toContain("model: (selector:");
    expect(data.modules.find(({ name }) => name === "index").exports.find(({ name }) => name === "default").members.map(({ name }) => name)).toContain("Agent");
    expect(data.modules.find(({ name }) => name === "index_app").exports.find(({ name }) => name === "default").members.map(({ name }) => name)).toContain("App");
  }, 20_000);

  test("GTUI frozen namespaces and factory protocols expose documented callables", async () => {
    const data = await collect();
    const gtui = data.modules.find((module) => module.name === "GTUI");
    const names = (symbol) => symbol.members.map((member) => member.name);
    expect(names(gtui.exports.find((symbol) => symbol.name === "view"))).toEqual(expect.arrayContaining(["text", "row", "menu"]));
    expect(names(gtui.exports.find((symbol) => symbol.name === "effect"))).toEqual(expect.arrayContaining(["task", "quit"]));
    expect(names(gtui.exports.find((symbol) => symbol.name === "event"))).toEqual(expect.arrayContaining(["key", "taskFailed"]));
    expect(names(gtui.exports.find((symbol) => symbol.name === "host"))).toEqual(["memory", "terminal"]);
    const text = await renderApiReference();
    expect(text).toContain("### `GTUI.view.text(props = {…}, content = \"\")`");
    expect(text).toContain("### `GTUI.effect.task(key, run)`");
    expect(text).toContain("### `GTUI.event.key(payload)`");
  }, 20_000);

  test("Env plugin members appear on Env, documented from their plugin", async () => {
    const data = await collect();
    const env = data.modules.find((module) => module.name === "Env");
    const klass = env.exports.find((symbol) => symbol.name === "Env");
    expect(klass.members.find((member) => member.name === "agentCreate")).toMatchObject({
      signature: "agentCreate(options = {…})",
      from: "lib/agent/env-plugin.js",
    });
    expect(klass.members.find((member) => member.name === "agents")?.from).toBe("lib/agent/env-plugin.js");
  }, 20_000);

  test("API cross-references link method-call notation across modules", async () => {
    const data = await collect();
    const html = linkApiReferences("<p><code>Agent.close()</code></p>", buildApiLinks(data), "Env");
    // Root-relative: deployed pages are extensionless clean URLs (/api/env),
    // where a relative "./agent/" would resolve to /agent — outside the API tree.
    expect(html).toBe('<p><a href="/api/agent/#Agent-close"><code>Agent.close()</code></a></p>');
    // Same-module mentions stay fragment-only.
    const local = linkApiReferences("<p><code>Env.settings</code></p>", buildApiLinks(data), "Env");
    expect(local).toBe('<p><a href="#Env-settings"><code>Env.settings</code></a></p>');
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

  test("API.md regenerates from the live tree on every run", async () => {
    const text = await renderApiReference();
    writeFileSync("API.md", text);
    expect(readFileSync("API.md", "utf8")).toBe(text);
    expect(text).toContain("# API (");
  }, 20_000);

  test("both renderers publish the FULL doc: class doc, params, returns (JobsError)", async () => {
    // The collected doc is the single source; both surfaces must show all of it.
    const data = await collect();
    const jobsError = data.modules.find((m) => m.name === "Jobs").exports.find((e) => e.name === "JobsError");
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
    const html = apiPages(data).find((p) => p.path === "/api/jobs/").html;
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
    expect(settings).toContain('"env-refuse": "string[]"');
    expect(settings).toContain('"providerTools": {');
    expect(settings).toContain('"folders": "string[]"');
    expect(settings).not.toContain('"tui": "unknown"');
  }, 20_000);

  test("API-schema.md regenerates from the live tree on every run", async () => {
    const text = await generate();
    writeFileSync("API-schema.md", text);
    expect(readFileSync("API-schema.md", "utf8")).toBe(text);
    expect(text).toStartWith("# API schema");
  }, 20_000);
});
