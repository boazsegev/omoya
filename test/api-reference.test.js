// test/api-reference.test.js — proof for the api-reference tool's
// AUTO-DETECTED tool catalog (test/api-reference.js
// collectToolCatalog): every package tool's schema is collected from
// its toolDescription() (describe() fallback), harness-metadata flags
// included; undescribed modules and schema-less entries are drift.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collect, collectArchitecture, collectToolCatalog, markdown, renderWith } from "./api-reference.js";
import App from "../lib/index_app.js";
import { wrapperNames } from "../bin/scripts/index.js";

describe("api-reference: dynamically collected architecture", () => {
  test("imports, helper ownership, executables, and connectors come from the live tree", () => {
    const architecture = collectArchitecture();
    const jobs = architecture.layers.find((layer) => layer.name === "Jobs");
    expect(jobs).toBeDefined();
    expect(jobs.publicDependencies).toEqual(expect.arrayContaining(["Agent", "CLI", "Env"]));
    const agent = architecture.layers.find((layer) => layer.name === "Agent");
    expect(agent.publicDependencies).toEqual(expect.arrayContaining(["Context", "Env", "IO"]));
    expect(App.GTUI).toBeDefined();
    const gtui = architecture.layers.find((layer) => layer.name === "GTUI");
    expect(gtui).toBeDefined();
    expect(gtui.file).toBe("lib/gtui/gtui.js");
    const tui = architecture.layers.find((layer) => layer.name === "TUI");
    // TUI owns gtui/ (the generic runtime) and tui-app/ (the one
    // application built on it) — tui-app imports gtui's façade, nothing
    // imports tui-app, so neither crosses the >=2-importer bar for
    // "shared"; both are "distinct".
    expect(tui.helperGroups.find((g) => g.kind === "shared")).toBeUndefined();
    const distinctPaths = tui.helperGroups.filter((g) => g.kind === "distinct").map((g) => g.path).sort();
    expect(distinctPaths).toEqual(["lib/gtui", "lib/tui-app"]);
    // the executables are exactly the canonical wrapper set (bin/ FILES)
    // plus the script implementations (bin/scripts/*) — both derived
    const expected = [...wrapperNames(), "app", "agent", "io", "jobs", "tool", "skills", "tools2bash"];
    expect(architecture.executables.map((entry) => entry.name)).toEqual(expect.arrayContaining(expected));
    expect(architecture.connectors.map((entry) => entry.name)).toEqual(expect.arrayContaining(["line", "inline", "alt"]));
  });
});

describe("api-reference: compact API renderer", () => {
  test("renders documented callables independently without architecture or contracts", async () => {
    const text = renderWith(await collect([{ name: "Env", file: "lib/env.js" }]), markdown);
    expect(text).toStartWith("# API (");
    expect(text).toContain("### `Env.contextWindow(endpoint, model)`");
    expect(text).toContain("### `Env.parseDuration(value)`");
    expect(text).toContain("The model's context window in tokens");
    expect(text).not.toContain("## Architecture"); // callable docs only, no architecture section
    const agentText = renderWith(await collect([{ name: "Agent", file: "lib/agent.js" }]), markdown);
    expect(agentText).toContain("### `Agent.SessionStore.constructor(");
  });
});

describe("api-reference: the auto-detected tool catalog", () => {
  test("every package tool's schema is collected, harness flags included", async () => {
    const { contract, missing } = await collectToolCatalog();
    expect(missing).toEqual([]); // the package tools are all described
    const names = contract.tools.map((t) => t.name);
    for (const name of ["bash", "read", "write", "edit", "skill", "question", "mcp", "job-schedule"]) {
      expect(names).toContain(name);
    }
    const bash = contract.tools.find((t) => t.name === "bash");
    expect(bash.flags).toEqual(["sandbox", "onTimeout"]); // bash streams from its forked OS-sandboxed worker
    expect(bash.inputSchema.required).toEqual(["command"]);
    const question = contract.tools.find((t) => t.name === "question");
    expect(question.flags).toEqual(["safe", "sandbox"]);
    for (const tool of contract.tools) {
      expect(tool.description).not.toBe(""); // documented
      expect(tool.inputSchema).not.toBeNull(); // typed
    }
  });

  test("describe() is the fallback when toolDescription is undefined", async () => {
    // the describer fixture exports describe() only
    const { contract, missing } = await collectToolCatalog("./test/tool-fixtures");
    expect(missing).toEqual([]);
    const describer = contract.tools.find((t) => t.name === "describer");
    expect(describer.description).toContain("describe() fallback");
  });

  test("an undescribed module and a schema-less entry are reported as drift, not skipped silently", async () => {
    const dir = mkdtempSync("./ai-tmp/apiref-");
    writeFileSync(join(dir, "silent.js"), "export const x = 1;\n"); // no describe fn
    writeFileSync(join(dir, "bare.js"), `
      export function toolDescription() { return { bare: {} }; }
      export function bare() { return 1; }
    `);
    const { missing } = await collectToolCatalog(dir);
    expect(missing.some((m) => m.includes("silent.js: no toolDescription()/describe()"))).toBe(true);
    expect(missing.some((m) => m.includes('"bare" has no description'))).toBe(true);
    expect(missing.some((m) => m.includes('"bare" has no inputSchema'))).toBe(true);
  });
});
