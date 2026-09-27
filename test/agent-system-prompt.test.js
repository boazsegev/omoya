// test/agent-system-prompt.test.js — proof for Agent's construction-time
// system-prompt seeding: a NEW context starts with env.resolveSystemPrompt()'s
// text(s) as its FIRST message(s) — at construction (never a TUI/CLI
// concern, never lazily on run()), ahead of any constructor-provided
// context, exactly once. Only `resume` skips it: a resumed session's
// stored context replaces the seeded one wholesale. newSession()
// re-seeds (read fresh); a seeded-only session persists NOTHING (the
// conversation hasn't started — Context treats it as empty).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { Context } from "../lib/context.js";
import { scriptedIO, USER, TEXT } from "./fakes.js";

/** An Env over a fresh, writable temp folder (so settings.system /
 * AGENTS.md can be planted per test), isolated from this repo's own. */
function envWith(settings) {
  mkdirSync("./ai-tmp", { recursive: true });
  const dir = realpathSync(resolve(mkdtempSync(join("./ai-tmp/", "agent-sysprompt-"))));
  // cwd isolated too — otherwise resolveSystemPrompt()'s project-local
  // layer would pick up the real repo root's own AGENTS.md.
  return new Env({
    dir,
    cwd: dir,
    settingsDir: dir,
    settings: {
      ...settings,
      providers: { ...(settings?.providers ?? {}), fake: { provider: "test", url: "test://script" } },
    },
  });
}

const ROOT = `./ai-tmp/agent-sysprompt-sessions-${process.pid}`;
const SYSTEM = (text) => ({ type: 1, content: [{ type: "text", text }] });

describe("Agent: construction-time system-prompt seeding", () => {
  test("a fresh agent starts with the seeded system prompt — at construction, before any input", async () => {
    const env = envWith({ system: "be terse" });
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done" }]]);
    const agent = new Agent({ env, model: "fake/m", context: [], createIO: () => io });
    // seeded NOW — the agent awaits further input with the prompt in place
    expect(agent.context.messages()).toEqual([SYSTEM("be terse")]);
    agent.send(USER("hello"));
    await agent.run();
    expect(agent.context.at(0)).toEqual(SYSTEM("be terse"));
    expect(agent.context.at(1)).toEqual(USER("hello"));
  });

  test("the seeded prompt is ALWAYS first — ahead of a constructor-provided context", async () => {
    const env = envWith({ system: "be terse" });
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done" }]]);
    const agent = new Agent({ env, model: "fake/m", context: [USER("go")], createIO: () => io });
    expect(agent.context.at(0)).toEqual(SYSTEM("be terse"));
    expect(agent.context.at(1)).toEqual(USER("go"));
    await agent.run();
    expect(agent.context.at(0)).toEqual(SYSTEM("be terse"));
    expect(io.writes[0].context.at(0)).toEqual(SYSTEM("be terse")); // the provider sees it first too
  });

  test("all resolveSystemPrompt() layers seed (folded into one leading system message)", () => {
    mkdirSync("./ai-tmp", { recursive: true });
    const dir = realpathSync(resolve(mkdtempSync(join("./ai-tmp/", "agent-sysprompt-"))));
    const cwd = realpathSync(resolve(mkdtempSync(join("./ai-tmp/", "agent-sysprompt-"))));
    const settingsHome = realpathSync(resolve(mkdtempSync(join("./ai-tmp/", "agent-sysprompt-"))));
    writeFileSync(join(dir, "AGENTS.md"), "harness rules\n"); // the package layer
    writeFileSync(join(settingsHome, "AGENTS.md"), "user rules\n"); // the settings-folder layer
    writeFileSync(join(cwd, "AGENTS.md"), "project rules\n"); // the project-local layer
    const env = new Env({
      dir,
      cwd,
      settingsDir: settingsHome,
      settings: { system: "be terse", providers: { fake: { provider: "test", url: "test://script" } } },
    });
    const agent = new Agent({ env, model: "fake/m", createIO: () => scriptedIO([]) });
    expect(agent.context.messages()).toHaveLength(1); // append-merged, one system message
    expect(agent.context.at(0).type).toBe(1);
    const text = agent.context.at(0).content.map((b) => b.text ?? "").join("\n");
    expect(text).toContain("be terse"); // the override replaces the package layer
    expect(text).not.toContain("harness rules");
    expect(text).toContain("user rules");
    expect(text).toContain("project rules");
  });

  test("the prompt is read fresh at construction — editing the source afterwards is honored by contextNew() only", async () => {
    const env = envWith({ system: "v1" });
    const io = scriptedIO([[...TEXT(0, "a"), { type: "done" }], [...TEXT(1, "b"), { type: "done" }]]);
    const agent = new Agent({ env, model: "fake/m", context: [], createIO: () => io });
    env.settings.system = "v2"; // too late for THIS context — it already started
    agent.send(USER("one"));
    await agent.run();
    expect(agent.context.at(0)).toEqual(SYSTEM("v1"));

    agent.contextNew("0"); // anonymous, fresh — the prompt is read again
    agent.send(USER("two"));
    await agent.run();
    expect(agent.context.at(0)).toEqual(SYSTEM("v2"));
  });

  test("seeded exactly ONCE across a multi-request run (tool-call loop) and across turns", async () => {
    const env = envWith({ system: "be terse" });
    env.toolAdd("t", () => "ok", { description: "d", inputSchema: {} });
    const io = scriptedIO([
      [{ type: "tool_call_start", contentIndex: 0, callId: "c1", name: "t", arguments: {} }, { type: "tool_call_end", contentIndex: 0, arguments: {} }, { type: "done" }],
      [...TEXT(0, "done"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "fake/m", context: [USER("go")], createIO: () => io });
    await agent.run();
    expect(agent.context.messages().filter((m) => m.type === 1)).toHaveLength(1);
    agent.send(USER("two"));
    await agent.run();
    expect(agent.context.messages().filter((m) => m.type === 1)).toHaveLength(1);
  });

  test("a resumed session (resume: true) keeps its stored context — no seeding", async () => {
    const env = envWith({ sessions: resolve(ROOT),  system: "be terse" });
    const store = new Context({ id: "s1", dir: ROOT });
    store.append(USER("earlier"));
    store.flush();
    store.close();
    const io = scriptedIO([[...TEXT(0, "reply"), { type: "done" }]]);
    const agent = new Agent({ env, model: "fake/m", contextId: "s1", createIO: () => io });
    expect(agent.context.messages().filter((m) => m.type === 1)).toHaveLength(0);
    await agent.run();
    expect(agent.context.messages().filter((m) => m.type === 1)).toHaveLength(0);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("contextResume() replaces the seeded context with the stored one", async () => {
    const env = envWith({ sessions: resolve(ROOT),  system: "be terse" });
    const store = new Context({ id: "s2", dir: ROOT });
    store.append(USER("earlier"));
    store.flush();
    store.close();
    const io = scriptedIO([[...TEXT(0, "reply"), { type: "done" }]]);
    // a fresh (seeded) Agent that then explicitly resumes at runtime — the /resume path
    const agent = new Agent({ env, model: "fake/m", context: [], createIO: () => io });
    expect(agent.context.messages().filter((m) => m.type === 1)).toHaveLength(1); // seeded
    agent.contextResume("s2");
    expect(agent.context.messages().filter((m) => m.type === 1)).toHaveLength(0); // replaced
    await agent.run();
    expect(agent.context.messages().filter((m) => m.type === 1)).toHaveLength(0);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("with no source configured anywhere, the context starts untouched", async () => {
    const env = envWith({});
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done" }]]);
    const agent = new Agent({ env, model: "fake/m", context: [USER("hello")], createIO: () => io });
    expect(agent.context.at(0)).toEqual(USER("hello"));
    await agent.run();
    expect(agent.context.at(0)).toEqual(USER("hello"));
  });

  test("a seeded-only session persists NOTHING (the conversation hasn't started)", () => {
    const env = envWith({ sessions: resolve(ROOT),  system: "be terse" });
    const agent = new Agent({ env, model: "fake/m", contextId: "s3", createIO: () => scriptedIO([]) });
    expect(agent.context.messages()).toEqual([SYSTEM("be terse")]);
    agent.context.flush();
    expect(existsSync(agent.context.file)).toBe(false); // seeded prompt only = empty session
    // once a real message arrives, the session (seed included) persists
    agent.context.append(USER("go"));
    agent.context.flush();
    expect(existsSync(agent.context.file)).toBe(true);
    const loaded = Context.resume({ id: "s3", dir: ROOT });
    expect(loaded.at(0)).toEqual(SYSTEM("be terse"));
    expect(loaded.at(1)).toEqual(USER("go"));
    loaded.close();
    rmSync(ROOT, { recursive: true, force: true });
  });
});
