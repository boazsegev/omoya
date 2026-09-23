// test/env-settings-schema.test.js — proof for the DEFAULTS SCHEMA
// (lib/env/settings-schema.js, env.defaultsSchema()): the core keys
// Env seeds, and a loaded tool's own settingsSchema() contribution
// (tools/mcp.js's `mcp` key — see test/agent-mcp.test.js for the tool
// itself). Contract only: keys exist with a default + description and
// tool contributions merge/drop — the DEFAULT VALUES themselves are
// content, free to change without touching this test.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Env } from "../lib/env.js";

describe("env.defaultsSchema()", () => {
  test("seeds the core keys with a default and a description, before any tool loads", () => {
    const dir = mkdtempSync("./ai-tmp/schema-");
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    const schema = env.defaultsSchema();
    // every core key pairs a defined default with a description — the
    // default VALUES (timeouts, fractions, screen mode) are content
    for (const key of ["toolTimeout", "toolTimeoutLimit", "contextGuardCap", "tui"]) {
      expect(schema[key]?.default, key).toBeDefined();
      expect(schema[key]?.description, key).toEqual(expect.any(String));
    }
    expect(schema.mcp).toBeUndefined(); // owned by tools/mcp.js, not core — absent until it loads
  });

  test("a loaded tool's settingsSchema() merges in (tools/mcp.js contributes `mcp`)", async () => {
    const dir = mkdtempSync("./ai-tmp/schema-");
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    await env.loadTools({ dirs: ["./tools"] });
    const schema = env.defaultsSchema();
    expect(schema.mcp).toEqual({ default: {}, description: expect.any(String) });
    expect(schema.toolTimeout.default).toBeDefined(); // core entries still present
  });

  test("dropping the contributing tool and refreshing drops its schema entry too", async () => {
    const dir = mkdtempSync("./ai-tmp/schema-");
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    await env.loadTools({ dirs: ["./tools"] });
    expect(env.defaultsSchema().mcp).toBeDefined();
    const empty = mkdtempSync("./ai-tmp/schema-empty-");
    await env.loadTools({ dirs: [empty] }); // no mcp.js in scope
    expect(env.defaultsSchema().mcp).toBeUndefined();
  });
});
