// test/env-settings-schema.test.js — proof for the DEFAULTS SCHEMA
// (lib/env/settings-schema.js, env.settingsSchema()): the core keys
// Env seeds, and a loaded tool's own settingsSchema() contribution
// (tools/read.js's `read` key). Contract only: keys exist with a default + description and
// tool contributions merge/drop — the DEFAULT VALUES themselves are
// content, free to change without touching this test.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Env } from "../lib/env.js";
import { toolsLoad } from "./env-internals.js";

describe("env.settingsSchema()", () => {
  test("seeds the core keys with a default and a description, before any tool loads", () => {
    const dir = mkdtempSync("./ai-tmp/schema-");
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    const schema = env.settingsSchema();
    // every core key pairs a defined default with a description — the
    // default VALUES (timeouts, fractions, screen mode) are content
    for (const key of ["tools", "web", "context", "retry", "tui"]) {
      expect(schema[key]?.default, key).toBeDefined();
      expect(schema[key]?.description, key).toEqual(expect.any(String));
    }
    expect(schema.tools.default).toEqual({ folders: [], timeout: 120_000, timeoutLimit: 1_200_000, concurrency: 3 });
    for (const retired of ["tool", "toolTimeout", "toolTimeoutLimit", "contextGuardCap", "contextGuardTurnCap", "maxAttempts", "retryBase", "retryMax"]) expect(schema[retired]).toBeUndefined();
    expect(schema.mcp).toEqual({ default: {}, layers: ["package", "user"], description: expect.any(String) }); // core: Env owns MCP
    expect(schema.read).toBeUndefined(); // owned by tools/read.js, not core — absent until it loads
  });

  test("a loaded tool's settingsSchema() merges in (tools/read.js contributes `read`)", async () => {
    const dir = mkdtempSync("./ai-tmp/schema-");
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    await toolsLoad(env, { dirs: ["./tools"] });
    const schema = env.settingsSchema();
    expect(schema.read).toEqual({ default: expect.any(Object), description: expect.any(String) });
    expect(schema.tools.default).toBeDefined(); // core entries still present
  });

  test("dropping the contributing tool and refreshing drops its schema entry too", async () => {
    const dir = mkdtempSync("./ai-tmp/schema-");
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    await toolsLoad(env, { dirs: ["./tools"] });
    expect(env.settingsSchema().read).toBeDefined();
    const empty = mkdtempSync("./ai-tmp/schema-empty-");
    await toolsLoad(env, { dirs: [empty] }); // no read.js in scope
    expect(env.settingsSchema().read).toBeUndefined();
  });
});
