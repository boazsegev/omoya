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
import { collect, contractProblems, renderApiReference } from "./api-reference.js";
import { buildApiLinks, linkApiReferences } from "../website/lib/api.js";
import { generate } from "./api-schema.js";

describe("generated API documentation", () => {
  test("every public export is documented, every contract source resolves", async () => {
    const problems = contractProblems(await collect());
    expect(problems).toEqual([]);
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

  test("composition-boundary prototype methods appear on their owning class", async () => {
    const data = await collect();
    const env = data.modules.find((module) => module.name === "Env");
    const klass = env.exports.find((symbol) => symbol.name === "Env");
    expect(klass.members.find((member) => member.name === "createAgent")).toMatchObject({
      signature: "createAgent(options = {…})",
      from: "lib/agent.js",
    });
  }, 20_000);

  test("API cross-references link method-call notation across modules", async () => {
    const data = await collect();
    const html = linkApiReferences("<p><code>Agent.close()</code></p>", buildApiLinks(data), "Env");
    // Root-relative: deployed pages are extensionless clean URLs (/api/env),
    // where a relative "./agent/" would resolve to /agent — outside the API tree.
    expect(html).toBe('<p><a href="/api/agent/#Agent-close"><code>Agent.close()</code></a></p>');
    // Same-module mentions stay fragment-only.
    const local = linkApiReferences("<p><code>Env.safe</code></p>", buildApiLinks(data), "Env");
    expect(local).toBe('<p><a href="#Env-safe"><code>Env.safe</code></a></p>');
  }, 20_000);

  test("API.md regenerates from the live tree on every run", async () => {
    const text = await renderApiReference();
    writeFileSync("API.md", text);
    expect(readFileSync("API.md", "utf8")).toBe(text);
    expect(text).toContain("# API (");
  }, 20_000);

  test("API-schema.md regenerates from the live tree on every run", async () => {
    const text = await generate();
    writeFileSync("API-schema.md", text);
    expect(readFileSync("API-schema.md", "utf8")).toBe(text);
    expect(text).toStartWith("# API schema");
  }, 20_000);
});
