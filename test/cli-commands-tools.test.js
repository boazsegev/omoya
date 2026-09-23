// test/cli-commands-tools.test.js — proof for lib/tui-app/commands.js
// + command-handlers.js's runTool: /tool-<name> (the RESERVED tool
// namespace) runs a registered tool directly (close to the "manual
// door" bin/ai-tool is — lib/cli/tool-run.js — but WITH the viewed
// agent as the caller), and never falls back to a prompt on a miss.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCommands as createAppCommands } from "../lib/tui-app/commands.js";
import { Agent } from "../lib/agent.js";

const createCommands = (options) => createAppCommands({ copy: () => false, ...options });
import { testEnv } from "./fakes.js";

/** A temp tool folder + an Agent/commands router with it loaded. */
async function setup(files) {
  const dir = mkdtempSync("./ai-tmp/commands-tools-");
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  const env = await testEnv();
  await env.loadTools({ dirs: [dir] });
  const lines = [];
  const agent = new Agent({ env, model: "fake/m", context: [] });
  const commands = createCommands({ agent, log: (l) => lines.push(l) });
  return { agent, commands, lines };
}

const ECHO_TOOL = `
export function echoIt({ text } = {}) { return text; }
export function toolDescription() {
  return { echoIt: { description: "echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } } };
}
`;

const ENVELOPE_TOOL = `
export function withSides() { return { result: "main", system: "sys note", display: ["d1", "d2"] }; }
export function toolDescription() {
  return { withSides: { description: "returns an envelope", inputSchema: { type: "object", properties: {} } } };
}
`;

const THROWING_TOOL = `
export function boom() { throw new Error("kaboom"); }
export function toolDescription() {
  return { boom: { description: "always throws", inputSchema: { type: "object", properties: {} } } };
}
`;

const SECRET_TOOL = `
export function hidden() { return "still runs"; }
export function toolDescription() {
  return { hidden: { secret: true, description: "hidden from the model", inputSchema: { type: "object", properties: {} } } };
}
`;

const CALLER_TOOL = `
export function whoCalls(args, ctx) { return ctx?.agent ? "has an agent" : "no agent"; }
export function toolDescription() {
  return { whoCalls: { interactive: true, description: "reports its calling agent", inputSchema: { type: "object", properties: {} } } };
}
`;

describe("commands.js: /tool-<name> runs a registered tool directly", () => {
  test("a JSON object argument calls the tool and logs its plain-string result", async () => {
    const { commands, lines } = await setup({ "echo.js": ECHO_TOOL });
    expect(await commands.handle('/tool-echoIt {"text":"hello there"}')).toBe(true);
    expect(lines).toEqual(["hello there"]);
  });

  test("a bare value shorthands into the tool's first schema property", async () => {
    const { commands, lines } = await setup({ "echo.js": ECHO_TOOL });
    expect(await commands.handle('/tool-echoIt "shorthand"')).toBe(true);
    expect(lines).toEqual(["shorthand"]);
  });

  test("no arguments at all calls the tool with {}", async () => {
    const { commands, lines } = await setup({ "echo.js": ECHO_TOOL });
    expect(await commands.handle("/tool-echoIt")).toBe(true);
    expect(lines).toEqual(["undefined"]); // echoIt({}) -> text is undefined -> formatted as text
  });

  test("a {result, system, display} envelope logs the result then each side channel, labeled", async () => {
    const { commands, lines } = await setup({ "sides.js": ENVELOPE_TOOL });
    expect(await commands.handle("/tool-withSides")).toBe(true);
    expect(lines).toEqual(["main", "[system] sys note", "[display] d1", "[display] d2"]);
  });

  test("a thrown error surfaces as a labeled failure, never a crash", async () => {
    const { commands, lines } = await setup({ "boom.js": THROWING_TOOL });
    expect(await commands.handle("/tool-boom")).toBe(true);
    expect(lines).toEqual(["tool boom failed: kaboom"]);
  });

  test("invalid JSON args report a clear error, never a crash", async () => {
    const { commands, lines } = await setup({ "echo.js": ECHO_TOOL });
    expect(await commands.handle("/tool-echoIt {not json")).toBe(true);
    expect(lines[0]).toMatch(/tool echoIt: invalid JSON args/);
  });

  test("a secret:true tool still runs from the input area (secrecy is from the model, not the user)", async () => {
    const { commands, lines } = await setup({ "hidden.js": SECRET_TOOL });
    expect(await commands.handle("/tool-hidden")).toBe(true);
    expect(lines).toEqual(["still runs"]);
  });

  test("the TUI supplies the viewed agent as the caller — an interactive tool that anchors on it works", async () => {
    const { commands, lines } = await setup({ "caller.js": CALLER_TOOL });
    expect(await commands.handle("/tool-whoCalls")).toBe(true);
    expect(lines).toEqual(["has an agent"]);
  });

  test("an unknown tool is a clear error — the \"tool-\" namespace never falls back to a prompt", async () => {
    const { commands, lines } = await setup({});
    expect(await commands.handle("/tool-nope-at-all")).toBe(true);
    expect(lines[0]).toMatch(/unknown tool: \/tool-nope-at-all/);
    expect(lines[0]).toMatch(/reserved/);
  });

  test("a bare /<name> (no tool- prefix) is NEVER a tool call — it falls through to the prompt path", async () => {
    const { commands, lines } = await setup({ "echo.js": ECHO_TOOL });
    expect(await commands.handle("/echoIt")).toBe(true);
    expect(lines[0]).toMatch(/unknown command or prompt: \/echoIt/); // never ran the tool
  });
});
