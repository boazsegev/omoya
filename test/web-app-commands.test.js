// test/web-app-commands.test.js — proof for lib/web-app/commands.js:
// the web app's slash-command layer (built only on public Agent/Env
// façades). /agent-name is the headline case: it must be routed (the
// autocomplete lists it) and must rename the agent.
import { describe, expect, test } from "bun:test";
import { runCommand, catalog } from "../lib/web-app/commands.js";
import Agent from "../lib/agent.js";
import { testEnv } from "./fakes.js";

describe("web-app commands: /agent-name", () => {
  test("shows and sets the human-friendly Agent name", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [] });
    expect((await runCommand(agent, "/agent-name")).text).toBe(`agent name: ${agent.name}`);
    expect((await runCommand(agent, "/agent-name scribe")).text).toBe("agent name: scribe");
    expect(agent.name).toBe("scribe");
    expect((await runCommand(agent, "/agent-name two words")).text).toBe("agent name: two words");
    expect(agent.name).toBe("two words");
  });

  test("is offered by the autocomplete catalog", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [] });
    expect(catalog(agent).commands).toContain("/agent-name");
  });
});

describe("web-app commands: TUI parity", () => {
  test("a unique prefix resolves; an ambiguous one does not", async () => {
    const { resolveCommand } = await import("../lib/web-app/commands.js");
    expect(resolveCommand("/agent-st")).toBe("/agent-status");
    expect(resolveCommand("/context-c")).toBe("/context-c");
  });

  test("/context-copy hands the last response to the client clipboard", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [
      { type: 2, content: [{ type: "text", text: "q" }] },
      { type: 3, content: [{ type: "text", text: "the answer" }] },
    ] });
    expect(await runCommand(agent, "/context-copy")).toEqual({ copy: "the answer" });
  });

  test("dialog-backed commands open client views", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [] });
    expect(await runCommand(agent, "/endpoint-login")).toEqual({ open: "login" });
    expect(await runCommand(agent, "/menu")).toEqual({ open: "palette" });
    expect(await runCommand(agent, "/context-edit 3")).toEqual({ open: "context", index: 3 });
  });

  test("the catalog carries argument hints for the composer ghost text", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [] });
    expect(catalog(agent).hints["/session-name"]).toBe("<name>");
    expect(catalog(agent).commands).toContain("/session-delete-all!");
  });
});
