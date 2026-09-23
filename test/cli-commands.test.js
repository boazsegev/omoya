// test/cli-commands.test.js — proof for lib/tui-app/commands.js: REPL
// /context-edit, /context-rollback, /context-pop route through the Agent into Context
// semantics — array/block addressing, stale provider/cache identifier
// cleanup on edit, tombstone/rewrite events in the session log when
// one is wired, plain in-memory mutation otherwise.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCommands as createAppCommands } from "../lib/tui-app/commands.js";
import { Agent } from "../lib/agent.js";

/** copy defaults to a harmless stub — createCommands requires one
 *  injected (parity with app.js's own production wiring); tests that
 *  care about the clipboard path pass their own and override it. */
const createCommands = (options) => createAppCommands({ copy: () => false, ...options });
import { SessionStore, findSessionFile } from "../lib/agent.js";
import { testEnv } from "./fakes.js";

const USER = (text, extra = {}) => ({ type: 2, content: [{ type: "text", text }], ...extra });
const ASSISTANT = (text, extra = {}) => ({ type: 3, content: [{ type: "text", text }], ...extra });

/** Agent over a seeded context + captured command logs. */
async function setup(context, { session = false } = {}) {
  const env = await testEnv();
  const lines = [];
  const options = { env, model: "fake/m", context };
  if (session) {
    options.session = new SessionStore({
      id: "commands-test",
      dir: mkdtempSync("./ai-tmp/commands-"),
      context,
    });
  }
  const agent = new Agent(options);
  agent.session?.flush?.();
  const commands = createCommands({ agent, log: (l) => lines.push(l) });
  return { agent, commands, lines };
}

const events = (agent) =>
  readFileSync(agent.session.file, "utf8").trim().split("\n").map(JSON.parse)
    .filter((record) => record?.type !== "session-metadata"); // the first, origin line

describe("cli-commands: /context-edit through Context", () => {
  test("/context-edit <i> <text> replaces the message content and drops stale provider ids", async () => {
    const { agent, commands, lines } = await setup([
      USER("original", { responseId: "stale-r", cacheId: "stale-c" }),
      ASSISTANT("answer"),
    ]);
    expect(await commands.handle("/context-edit 0 rewritten question")).toBe(true);

    expect(agent.context[0]).toEqual({
      type: 2,
      content: [{ type: "text", text: "rewritten question" }],
    }); // rebuilt from recognized fields: responseId/cacheId gone
    expect(agent.context[1]).toEqual(ASSISTANT("answer")); // untouched
    expect(lines).toEqual(["edited message 0"]);
  });

  test("/context-edit keeps tool-result linkage (callId/name/error survive the rebuild)", async () => {
    const toolResult = {
      type: 4, callId: "c1", name: "file-read",
      content: [{ type: "text", text: "old body" }], providerRef: "stale",
    };
    const { agent, commands } = await setup([USER("q"), toolResult]);
    await commands.handle("/context-edit 1 new body");

    expect(agent.context[1]).toEqual({
      type: 4, callId: "c1", name: "file-read",
      content: [{ type: "text", text: "new body" }],
    });
  });

  test("/context-edit <i> <j> <text> edits one block; thinking metadata is preserved", async () => {
    const message = {
      type: 3,
      content: [
        { type: "thinking", text: "old thought", signature: "sig-1" },
        { type: "text", text: "answer" },
      ],
    };
    const { agent, commands, lines } = await setup([USER("q"), message]);
    await commands.handle("/context-edit 1 0 new thought");

    expect(agent.context[1].content[0]).toEqual({
      type: "thinking", text: "new thought", signature: "sig-1",
    });
    expect(agent.context[1].content[1]).toEqual({ type: "text", text: "answer" });
    expect(lines).toEqual(["edited block 1.0"]);
  });

  test("/context-edit refuses toolCall blocks and bad addresses without touching the context", async () => {
    const call = { type: 3, content: [{ type: "toolCall", callId: "c1", name: "file-read", arguments: {} }] };
    const { agent, commands, lines } = await setup([USER("q"), call]);
    await commands.handle("/context-edit 1 0 nope");
    await commands.handle("/context-edit 9 text");
    await commands.handle("/context-edit 0");

    expect(agent.context[1]).toEqual(call); // unchanged
    expect(lines[0]).toContain("only text/thinking blocks edit");
    expect(lines[1]).toContain("no message at index 9");
    expect(lines[2]).toContain("usage: /context-edit");
  });

  test("edit rewrites the session file on flush", async () => {
    const { agent, commands } = await setup([USER("original"), ASSISTANT("answer")], { session: true });
    await commands.handle("/context-edit 0 rewritten");
    agent.session.flush();

    const records = events(agent);
    expect(records[0]).toEqual(USER("rewritten"));
    expect(records).toHaveLength(2); // no change log — the file IS the context
    agent.session.close();
  });
});

describe("cli-commands: /context-rollback and /context-pop tombstones", () => {
  test("/context-rollback <i> removes messages >= i; /context-pop removes the last", async () => {
    const { agent, commands, lines } = await setup([
      USER("one"), ASSISTANT("a1"), USER("two"), ASSISTANT("a2"),
    ]);
    await commands.handle("/context-rollback 2");
    expect(agent.context.map((m) => m.content[0].text)).toEqual(["one", "a1"]);
    await commands.handle("/context-pop");
    expect(agent.context.map((m) => m.content[0].text)).toEqual(["one"]);
    agent.context.push(USER("two"));
    agent.context.push(USER("three"));
    await commands.handle("/context-pop 2");
    expect(agent.context.map((m) => m.content[0].text)).toEqual(["one"]);
    expect(lines).toEqual([
      "rolled back 2 message(s); context now 2",
      "popped 1 message(s); context now 1",
      "popped 2 message(s); context now 1",
    ]);
  });

  test("tombstones rewrite the session file; a reload restores the edit", async () => {
    const { agent, commands } = await setup(
      [USER("one"), ASSISTANT("a1"), USER("two")],
      { session: true },
    );
    await commands.handle("/context-rollback 2");
    await commands.handle("/context-pop");
    agent.session.flush();

    expect(events(agent)).toEqual([USER("one")]); // truncated in place, no tombstones

    const replayed = SessionStore.resume({ id: agent.session.id, dir: agent.session.dir });
    expect(replayed.context).toEqual([USER("one")]);
    agent.session.close();
    replayed.close();
  });

  test("/context-pop on an empty context reports instead of crashing", async () => {
    const { commands, lines } = await setup([]);
    await commands.handle("/context-pop");
    expect(lines).toEqual(["context already empty"]);
  });

  test("/context-rollback validates its argument", async () => {
    const { agent, commands, lines } = await setup([USER("one")]);
    await commands.handle("/context-rollback");
    await commands.handle("/context-rollback x");
    expect(agent.context).toHaveLength(1);
    expect(lines[0]).toContain("usage: /context-rollback");
    expect(lines[1]).toContain("non-negative integer");
  });
});

describe("cli-commands: /endpoint-model endpoint+model switching", () => {
  const setupEndpoints = async (context = []) => {
    const { mkdtempSync } = await import("node:fs");
    const { Env } = await import("../lib/env.js");
    const { readLastCombo } = await import("../lib/cli.js");
    const dir = mkdtempSync("./ai-tmp/commands-model-");
    const env = new Env({ dir, cwd: dir, settings: {
      providers: {
        fake: { provider: "wire", url: "http://fake" },
        fake2: { provider: "wire", url: "http://fake2" },
      },
      fake2: { models: { "cached-2": null, "ns/lyricist": null } },
    } });
    class Wire {
      static provider = {};
      constructor(url, aiio) { this.url = url; this.aiio = aiio; }
      async models() { return { "live-1": null }; }
      async close() {}
    }
    env.registerProvider("wire", Wire);
    // A populated catalog is authoritative: selection must reject ids outside
    // it, while the test's intended explicit selections remain valid.
    env.endpoints.fake2.models = { "cached-2": {}, "ns/lyricist": {}, "custom:m": {} };
    const lines = [];
    const agent = new Agent({ env, model: "fake/m1", context });
    const commands = createCommands({ agent, log: (line) => lines.push(line) });
    return { agent, commands, lines, env, readLastCombo };
  };

  test("lists published endpoint/model candidates", async () => {
    const { commands, lines } = await setupEndpoints();
    await commands.handle("/endpoint-model");
    expect(lines[0]).toBe("model: fake/m1");
    expect(lines.slice(2).map((line) => line.trim())).toEqual(expect.arrayContaining(["fake", "fake2", "cached-2", "fake2/cached-2"]));
  });

  test("switches explicitly, resolves cached ids, and refreshes endpoint models", async () => {
    const { agent, commands } = await setupEndpoints();
    await commands.handle("/endpoint-model fake2/custom:m");
    expect([agent.endpoint, agent.model]).toEqual(["fake2", "custom:m"]);
    await commands.handle("/endpoint-model cached-2");
    expect([agent.endpoint, agent.model]).toEqual(["fake2", "cached-2"]);
    await commands.handle("/endpoint-model fake");
    expect([agent.endpoint, agent.model]).toEqual(["fake", "live-1"]);
  });

  test("refuses unknown models and persists only verified explicit combos", async () => {
    const { agent, commands, env, readLastCombo, lines } = await setupEndpoints();
    env.endpoints.fake.models = { m1: {} };
    await commands.handle("/endpoint-model whatever:9b");
    expect([agent.endpoint, agent.model]).toEqual(["fake", "m1"]);
    expect(lines.at(-1)).toContain("unknown model");
    await commands.handle("/endpoint-model fake2/custom:m");
    expect(readLastCombo(env)).toEqual({ endpoint: "fake2", model: "custom:m" });
  });

  test("validates argument shape and empty endpoint", async () => {
    const { agent, commands, lines } = await setupEndpoints();
    await commands.handle("/endpoint-model a b");
    await commands.handle("/endpoint-model /x");
    expect([agent.endpoint, agent.model]).toEqual(["fake", "m1"]);
    expect(lines[0]).toContain("usage: /endpoint-model");
    expect(lines[1]).toContain("empty endpoint");
  });
});

describe("cli-commands: /context-system appends a system message", () => {
  test("/context-system <text> on one line", async () => {
    const { agent, commands, lines } = await setup([]);
    expect(await commands.handle("/context-system be terse")).toBe(true);
    expect(agent.context).toEqual([{ type: 1, content: [{ type: "text", text: "be terse" }] }]);
    expect(lines).toEqual(["system message added; context now 1"]);
  });

  test("/context-system with a multi-line body preserves newlines, not tokenized", async () => {
    const { agent, commands } = await setup([]);
    await commands.handle("/context-system\nline one\nline two");
    expect(agent.context[0].content[0].text).toBe("line one\nline two");
  });

  test("same-line text plus continuation lines both contribute", async () => {
    const { agent, commands } = await setup([]);
    await commands.handle("/context-system be nice\nand also helpful");
    expect(agent.context[0].content[0].text).toBe("be nice\nand also helpful");
  });

  test("/context-system with no text at all is a usage error, nothing appended", async () => {
    const { agent, commands, lines } = await setup([]);
    await commands.handle("/context-system");
    expect(agent.context).toHaveLength(0);
    expect(lines[0]).toContain("usage: /context-system");
  });

  test("system message persists to the session file like any message", async () => {
    const { agent, commands } = await setup([USER("q")], { session: true });
    await commands.handle("/context-system be terse");
    agent.session.flush();
    expect(events(agent)).toEqual([
      USER("q"),
      { type: 1, content: [{ type: "text", text: "be terse" }] },
    ]);
    agent.session.close();
  });

  test("a LONE system message persists nothing (a system-only session is an unstarted conversation)", async () => {
    const { agent, commands } = await setup([], { session: true });
    await commands.handle("/context-system be terse");
    agent.session.flush();
    expect(existsSync(agent.session.file)).toBe(false);
    agent.session.close();
  });
});

describe("cli-commands: /session-fork", () => {
  test("/session-fork with no id forks into a random-UUID session holding the full context", async () => {
    const { agent, commands, lines } = await setup([USER("q"), ASSISTANT("a")], { session: true });
    const oldFile = agent.session.file;
    await commands.handle("/session-fork");

    expect(agent.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(agent.session.file).not.toBe(oldFile);
    expect(lines[0]).toContain(`forked into session: ${agent.session.id}`);
    // the fork holds the whole context; the original file is untouched
    expect(events(agent)).toEqual([USER("q"), ASSISTANT("a")]);
    agent.session.close();
  });

  test("/session-fork <id> names the new session", async () => {
    const { agent, commands, lines } = await setup([USER("q")], { session: true });
    await commands.handle("/session-fork my-copy");
    expect(agent.session.id).toBe("my-copy");
    expect(lines[0]).toContain("my-copy");
    agent.session.close();
  });

  test("/session-fork false forks into a hidden (anonymous, unpersisted) session", async () => {
    const { agent, commands, lines } = await setup([USER("q")], { session: true });
    await commands.handle("/session-fork false");
    expect(agent.session).toBeNull();
    expect(lines[0]).toContain("anonymous");
    expect(agent.context).toEqual([USER("q")]); // context kept in memory
  });

  test("/session-fork on an in-memory agent starts persisting under the new id", async () => {
    const { agent, commands, lines } = await setup([USER("q")]);
    expect(agent.session).toBeNull();
    await commands.handle("/session-fork named");
    expect(agent.session.id).toBe("named");
    expect(events(agent)).toEqual([USER("q")]);
    agent.session.close();
  });
});

describe("cli-commands: /agent-thinking", () => {
  test("bare /agent-thinking shows the current level; a level is set and reported", async () => {
    const { agent, commands, lines } = await setup([]);
    await commands.handle("/agent-thinking");
    expect(lines[0]).toContain("provider default");
    await commands.handle("/agent-thinking high");
    expect(agent.thinking).toBe("high");
    expect(lines[1]).toBe("thinking: high");
    await commands.handle("/agent-thinking off");
    expect(agent.thinking).toBe("off");
    await commands.handle("/agent-thinking bogus");
    expect(lines[3]).toContain("usage: /agent-thinking");
  });

  test("the vocabulary is default/off/low/medium/high/xhigh; default clears the level", async () => {
    const { agent, commands, lines } = await setup([]);
    await commands.handle("/agent-thinking xhigh");
    expect(agent.thinking).toBe("xhigh");
    await commands.handle("/agent-thinking default");
    expect(agent.thinking).toBeUndefined();
    await commands.handle("/agent-thinking on");
    expect(lines.at(-1)).toContain("usage: /agent-thinking [default|off|low|medium|high|xhigh]");
  });

  test("setThinking propagates to live provider connections (think option)", async () => {
    const { agent } = await setup([]);
    const io = { state: "idle", options: {}, setOption(k, v) { this.options[k] = v; }, async write() { return { type: "done" }; }, async kill() {} };
    agent._io.set("fake", io);
    agent.setThinking("low");
    expect(io.options.think).toBe("low");
    agent.setThinking("off");
    expect(io.options.think).toBe(false);
    agent.setThinking(undefined);
    expect("think" in io.options ? io.options.think : undefined).toBe(undefined);
  });
});

describe("cli-commands: /help and exit commands", () => {
  test("/help prints the command + keybinding summary", async () => {
    const { commands, lines } = await setup([]);
    await commands.handle("/help");
    const out = lines.join("\n");
    expect(out).toContain("/session-fork");
    expect(out).toContain("/agent-thinking");
    expect(out).toContain("^X menu");
  });

  test("/bye, /exit, /quit all invoke the onExit hook", async () => {
    let exits = 0;
    const { agent } = await setup([]);
    const commands = createCommands({ agent, log: () => {}, onExit: () => exits++ });
    expect(await commands.handle("/bye")).toBe(true);
    expect(await commands.handle("/quit")).toBe(true);
    expect(await commands.handle("/exit")).toBe(true);
    expect(exits).toBe(3);
  });

  test("without an onExit hook, exit commands explain instead of crashing", async () => {
    const { commands, lines } = await setup([]);
    expect(await commands.handle("/quit")).toBe(true);
    expect(lines[0]).toContain("Ctrl-D");
  });
});

describe("cli-commands: command line routing", () => {
  test("non-command lines pass through to the REPL as user turns", async () => {
    const { commands } = await setup([]);
    expect(await commands.handle("a plain question")).toBe(false);
    expect(await commands.handle("")).toBe(false);
  });

  test("unknown slash-commands are consumed with a hint, never a crash", async () => {
    const { commands, lines } = await setup([]);
    expect(await commands.handle("/nope 1 2")).toBe(true);
    expect(lines[0]).toContain("unknown command or prompt: /nope");
    expect(lines[0]).toContain("/endpoint-model"); // hint lists the command surface
  });

  test("a partial command resolves when it prefix-matches exactly one command", async () => {
    const { agent, commands, lines } = await setup([]);
    expect(await commands.handle("/context-r")).toBe(true); // -> /context-rollback, missing its arg
    expect(lines[0]).toContain("usage: /context-rollback");
    lines.length = 0;
    expect(await commands.handle("/context-s hello")).toBe(true); // -> /context-system hello
    expect(agent.context).toEqual([{ type: 1, content: [{ type: "text", text: "hello" }] }]);
  });

  test("an ambiguous partial command is left unresolved (reported as unknown)", async () => {
    const { commands, lines } = await setup([]);
    expect(await commands.handle("/context-c")).toBe(true); // copy/continue/clear-thoughts/compact all match
    expect(lines[0]).toContain("unknown command or prompt: /context-c");
  });

  test("a namespace-INSIDE partial resolves when it matches exactly one command (/po → /context-pop)", async () => {
    const { agent, commands } = await setup([USER("one"), USER("two")]);
    expect(await commands.handle("/po")).toBe(true); // -> /context-pop
    expect(agent.context).toEqual([USER("one")]); // the last message popped
  });

  test("an ambiguous namespace-inside partial is left unresolved", async () => {
    const { commands, lines } = await setup([]);
    expect(await commands.handle("/lo")).toBe(true); // login AND logout both match inside /endpoint-*
    expect(lines[0]).toContain("unknown command or prompt: /lo");
  });

  test("completion candidates include the namespace-inside matches", async () => {
    const { computeCompletions } = await import("../lib/tui-app/completion.js");
    const { COMMANDS } = await import("../lib/tui-app/command-data.js");
    const r = computeCompletions("/po", 3, { commands: COMMANDS });
    expect(r.candidates).toEqual(["/context-pop"]);
    const nested = computeCompletions("/fo", 3, { commands: COMMANDS });
    expect(nested.candidates).toContain("/session-fork");
    // a full-name prefix still wins outright; inside-matches don't repeat it
    const both = computeCompletions("/context-p", 10, { commands: COMMANDS });
    expect(both.candidates).toEqual(["/context-pop"]);
  });
});

describe("cli-commands: /continue (top-level — never /context-continue)", () => {
  test("routes to onContinue with no arguments", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [] });
    let called = 0;
    const commands = createCommands({ agent, onContinue: async () => { called++; } });
    expect(await commands.handle("/continue")).toBe(true);
    expect(called).toBe(1);
  });

  test("without an onContinue hook, reports it's unavailable rather than crashing", async () => {
    const { commands, lines } = await setup([]);
    expect(await commands.handle("/continue")).toBe(true);
    expect(lines[0]).toContain("not available");
  });

  test("/context-continue is NOT a command — it's a top-level /continue only", async () => {
    const { commands, lines } = await setup([]);
    expect(await commands.handle("/context-continue")).toBe(true);
    expect(lines[0]).toContain("unknown command or prompt");
  });
});

describe("cli-commands: //<name> loads a custom prompt into the input area", () => {
  function writePrompt(env, filename, frontmatter, body) {
    const dir = join(env.dir, "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), `---\n${frontmatter}\n---\n${body}\n`);
  }

  test("//<name> fills the input with the prompt body, never submitting a turn", async () => {
    const env = await testEnv();
    writePrompt(env, "greet.md", "name: greet\ndescription: d", "hello there");
    const agent = new Agent({ env, model: "fake/m", context: [] });
    let filled = null;
    const commands = createCommands({ agent, onFillInput: (text) => { filled = text; } });
    expect(await commands.handle("//greet")).toBe(true);
    expect(filled).toBe("hello there");
    expect(agent.context).toEqual([]); // never submitted
  });

  test("//<name> <data> appends the trailing text as its own line", async () => {
    const env = await testEnv();
    writePrompt(env, "greet.md", "name: greet\ndescription: d", "hello there");
    const agent = new Agent({ env, model: "fake/m", context: [] });
    let filled = null;
    const commands = createCommands({ agent, onFillInput: (text) => { filled = text; } });
    expect(await commands.handle("//greet please and thank you")).toBe(true);
    expect(filled).toBe("hello there\nplease and thank you");
  });

  test("bare // lists the prompt catalog via log()", async () => {
    const env = await testEnv();
    writePrompt(env, "greet.md", "name: greet\ndescription: a greeting", "hi");
    const agent = new Agent({ env, model: "fake/m", context: [] });
    const lines = [];
    const commands = createCommands({ agent, log: (l) => lines.push(l) });
    expect(await commands.handle("//")).toBe(true);
    expect(lines.join("\n")).toContain("# Prompt Catalog");
    expect(lines.join("\n")).toContain("`greet` — a greeting");
  });

  test("an unknown prompt name is reported, never resolved against COMMANDS", async () => {
    const { commands, lines } = await setup([]);
    expect(await commands.handle("//nope")).toBe(true);
    expect(lines[0]).toBe("unknown prompt: nope");
  });

  test("without an onFillInput hook, prints the expanded text instead", async () => {
    const env = await testEnv();
    writePrompt(env, "greet.md", "name: greet\ndescription: d", "hello there");
    const agent = new Agent({ env, model: "fake/m", context: [] });
    const lines = [];
    const commands = createCommands({ agent, log: (l) => lines.push(l) });
    expect(await commands.handle("//greet")).toBe(true);
    expect(lines[0]).toBe("hello there");
  });
});

describe("cli-commands: /context-edit with no arguments (move the last message into the input)", () => {
  test("pops the last message and fills the input with its text", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [USER("one"), ASSISTANT("draft answer")] });
    const lines = [];
    const filled = [];
    let changed = 0;
    const commands = createCommands({
      agent, log: (l) => lines.push(l),
      onChanged: () => changed++, onFillInput: (t) => filled.push(t),
    });
    expect(await commands.handle("/context-edit")).toBe(true);
    expect(agent.context).toEqual([USER("one")]); // popped
    expect(filled).toEqual(["draft answer"]); // moved into the input
    expect(changed).toBe(1); // the TUI re-renders from the active context
    expect(lines).toEqual(["last message moved into the input for editing"]);
  });

  test("empty context or a textless last message report errors, touching nothing", async () => {
    const env = await testEnv();
    const toolOnly = { type: 3, content: [{ type: "toolCall", callId: "c1", name: "file-read", arguments: {} }] };
    const agent = new Agent({ env, model: "fake/m", context: [] });
    const lines = [];
    const commands = createCommands({ agent, log: (l) => lines.push(l) });
    await commands.handle("/context-edit");
    agent.append(toolOnly);
    await commands.handle("/context-edit");
    expect(agent.context).toEqual([toolOnly]); // untouched
    expect(lines[0]).toContain("nothing to edit");
    expect(lines[1]).toContain("no text to edit");
  });

  test("multi-block text joins with newlines", async () => {
    const env = await testEnv();
    const message = { type: 3, content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] };
    const agent = new Agent({ env, model: "fake/m", context: [message] });
    const filled = [];
    const commands = createCommands({ agent, log: () => {}, onFillInput: (t) => filled.push(t) });
    await commands.handle("/context-edit");
    expect(filled).toEqual(["part one\npart two"]);
  });
});

describe("cli-commands: context mutations fire onChanged (the TUI re-renders)", () => {
  test("/context-edit <i>, /context-rollback, /context-pop each report the change", async () => {
    const env = await testEnv();
    const agent = new Agent({
      env, model: "fake/m",
      context: [USER("one"), ASSISTANT("a1"), USER("two")],
    });
    let changed = 0;
    const commands = createCommands({ agent, log: () => {}, onChanged: () => changed++ });
    await commands.handle("/context-edit 0 edited");
    await commands.handle("/context-pop");
    await commands.handle("/context-rollback 1");
    expect(agent.context.map((m) => m.content[0].text)).toEqual(["edited"]);
    expect(changed).toBe(3);
  });

  test("/context-rollback with the message COUNT is out of range (indexes only), with guidance", async () => {
    const { agent, commands, lines } = await setup([USER("one"), ASSISTANT("a1")]);
    await commands.handle("/context-rollback 2"); // 2 messages: valid indexes 0..1
    expect(agent.context).toHaveLength(2); // untouched (used to be a silent no-op)
    expect(lines[0]).toContain("no message at index 2");
    expect(lines[0]).toContain("/context-rollback 0 clears all");
    expect(lines[0]).toContain("/session-delete!");
  });
});

describe("cli-commands: /agent-safe", () => {
  const setup = async () => {
    const env = await testEnv();
    env.registerTool("reader", () => {}, { description: "r", inputSchema: {}, safe: true });
    env.registerTool("writer", () => {}, { description: "w", inputSchema: {} });
    const agent = new Agent({ env, model: "fake/m", context: [] });
    const lines = [];
    const commands = createCommands({ agent, log: (line) => lines.push(line) });
    return { agent, commands, lines };
  };

  test("shows the mode, toggles it, and reports the published tool count", async () => {
    const { agent, commands, lines } = await setup();
    await commands.handle("/agent-safe");
    expect(lines.at(-1)).toBe("safe mode: off");
    await commands.handle("/agent-safe on");
    expect(agent.safe).toBe(true);
    expect(lines.at(-1)).toContain("safe mode: on — 1 tool(s) published");
    await commands.handle("/agent-safe off");
    expect(agent.safe).toBe(false);
    expect(lines.at(-1)).toContain("safe mode: off — 3 tool(s) published");
    await commands.handle("/agent-safe bogus");
    expect(lines.at(-1)).toContain("usage: /agent-safe");
  });
});

describe("cli-commands: /agent-session-save", () => {
  test("shows and switches SessionStore saving", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", session: "storage", createIO: () => null });
    const lines = [];
    const commands = createCommands({ agent, log: (line) => lines.push(line) });
    await commands.handle("/agent-session-save");
    await commands.handle("/agent-session-save false");
    expect(lines).toEqual(["session save: true", "session save: false"]);
    expect(agent.sessionSave).toBe(false);
  });
});

describe("cli-commands: /agent-status plan usage", () => {
  test("the provider-reported quota map prints under /agent-status", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [] });
    agent._planUsage = { label: "Pro", quotas: { requests: { total: 500, remaining: 250, reset: "1h" } } };
    const lines = [];
    const commands = createCommands({ agent, log: (line) => lines.push(line) });
    await commands.handle("/agent-status");
    expect(lines).toContain("plan usage (Pro):");
    expect(lines).toContain("  requests: remaining=250 · total=500 · reset=1h");
  });

  test("a parseable ISO reset also shows its countdown, and windowSeconds prints as window=<n>s", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [] });
    const reset = new Date(Date.now() + 45 * 60_000).toISOString(); // ~45m out, clear of any hour/second-unit rounding
    agent._planUsage = { quotas: { "5h": { total: 100, used: 2, remaining: 98, windowSeconds: 18000, reset } } };
    const lines = [];
    const commands = createCommands({ agent, log: (line) => lines.push(line) });
    await commands.handle("/agent-status");
    const line = lines.find((l) => l.startsWith("  5h:"));
    expect(line).toMatch(/^ {2}5h: used=2 · remaining=98 · total=100 · window=18000s · reset=.+ \(resets in \d{1,2}m\)$/);
  });
});

describe("cli-commands: /agent-status (context details, tools + live status, MCP)", () => {
  test("prints the combo, session, context counts, and every tool with its status", async () => {
    const { agent, commands, lines } = await setup([
      USER("q1"),
      ASSISTANT("a1"),
      USER("q2"),
    ]);
    agent.env.registerTool("demo-tool", () => "ok",
      { description: "a demo tool", inputSchema: {} });
    agent.env.updateToolStatus("demo-tool", { runs: 3 });
    agent.env.updateToolStatus("demo-tool", { active: 1 }); // merges

    expect(await commands.handle("/agent-status")).toBe(true);
    const out = lines.join("\n");
    expect(out).toContain("status: fake/m (thinking: provider default)");
    expect(out).toContain("session: anonymous");
    expect(out).toContain("context: 3 message(s) — 0 system, 2 user, 1 assistant, 0 tool result(s)");
    expect(out).toContain("demo-tool — a demo tool status: {\"runs\":3,\"active\":1}");
    expect(out).toContain("MCP servers: none");
  });

  test("Env.updateToolStatus stores the merged status on the tool entry; unknown tools throw", async () => {
    const { agent } = await setup([]);
    agent.env.registerTool("t", () => "", { description: "", inputSchema: {} });
    const status = agent.env.updateToolStatus("t", { servers: ["a", "b"] });
    expect(status).toEqual({ servers: ["a", "b"] });
    expect(agent.env.toolEntry("t").status).toEqual({ servers: ["a", "b"] });
    agent.env.updateToolStatus("t", { active: 2 });
    expect(agent.env.toolEntry("t").status).toEqual({ servers: ["a", "b"], active: 2 });
    expect(() => agent.env.updateToolStatus("nope", {})).toThrow(/unknown tool/);
  });
});

describe("cli-commands: /session-new and /session-delete!", () => {
  test("/session-new starts an empty session; the old session file stays on disk", async () => {
    const { agent, commands, lines } = await setup([USER("one"), ASSISTANT("a1")], { session: true });
    const oldFile = agent.session.file;
    agent.session.flush();
    expect(await commands.handle("/session-new")).toBe(true);
    expect(agent.context).toEqual([]); // fresh, empty context
    expect(agent.session.id).not.toBe("commands-test"); // a new session id
    expect(readFileSync(oldFile, "utf8")).toContain("one"); // old snapshot preserved
    expect(lines[0]).toContain("new session:");
    agent.session.close();
  });

  test("/session-new <id> names the session; /session-new false goes anonymous", async () => {
    const { agent, commands, lines } = await setup([], { session: true });
    await commands.handle("/session-new my-test-session");
    expect(agent.session.id).toBe("my-test-session");
    expect(lines[0]).toContain("my-test-session");
    await commands.handle("/session-new false");
    expect(agent.session).toBeNull(); // anonymous: nothing persisted
    expect(agent.context).toEqual([]);
    expect(lines[1]).toContain("anonymous");
  });

  test("/new is a flat alias of /session-new; /anon of /session-new false", async () => {
    const { agent, commands, lines } = await setup([], { session: true });
    await commands.handle("/new named-via-alias");
    expect(agent.session.id).toBe("named-via-alias");
    expect(lines[0]).toContain("named-via-alias");
    await commands.handle("/anon");
    expect(agent.session).toBeNull(); // anonymous: nothing persisted
    expect(agent.context).toEqual([]);
    expect(lines[1]).toContain("anonymous");
    // a bare /new starts a fresh RANDOM session
    const { agent: agent2, commands: commands2 } = await setup([], { session: true });
    await commands2.handle("/new");
    expect(agent2.session.id).not.toBe("commands-test");
    agent2.session.close();
  });

  test("/session-delete! clears the context; the emptied session's file is REMOVED (recreated by new messages)", async () => {
    const { agent, commands, lines } = await setup([USER("one"), ASSISTANT("a1")], { session: true });
    agent.session.flush();
    expect(await commands.handle("/session-delete!")).toBe(true);
    expect(agent.context).toEqual([]);
    expect(agent.session.id).toBe("commands-test"); // same session restarted
    // an empty session has NO file — the stale one is gone, nothing
    // empty is written in its place
    expect(existsSync(agent.session.file)).toBe(false);
    expect(lines[0]).toContain("cleared 2 message(s)");
    // the next message recreates the file under the SAME session id
    agent.session.append(USER("after the clear"));
    agent.session.flush();
    const replayed = SessionStore.resume({ id: "commands-test", dir: agent.session.dir });
    expect(replayed.context).toEqual([USER("after the clear")]);
    agent.session.close();
    replayed.close();
  });

  test("/session-delete! on an empty context is a clean restart, not an error", async () => {
    const { agent, commands, lines } = await setup([], { session: true });
    await commands.handle("/session-delete!");
    expect(agent.context).toEqual([]);
    expect(lines[0]).toContain("cleared 0 message(s)");
    agent.session.close();
  });

  test("/session-new calls onReset (the view returns to its startup state) instead of onChanged, when wired", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [USER("one")] });
    let resetCalls = 0, changedCalls = 0;
    const commands = createCommands({ agent, onReset: () => resetCalls++, onChanged: () => changedCalls++ });
    await commands.handle("/session-new");
    expect(resetCalls).toBe(1);
    expect(changedCalls).toBe(0);
  });

  test("/session-delete! calls onReset too", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [USER("one")] });
    let resetCalls = 0;
    const commands = createCommands({ agent, onReset: () => resetCalls++ });
    await commands.handle("/session-delete!");
    expect(resetCalls).toBe(1);
  });

  test("/session-new falls back to onChanged when onReset isn't wired", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [] });
    let changed = false;
    const commands = createCommands({ agent, onChanged: () => { changed = true; } });
    await commands.handle("/session-new");
    expect(changed).toBe(true);
  });
});

describe("cli-commands: /session-name", () => {
  test("renames the session: the file takes the proper name, the old name's file is gone", async () => {
    const { agent, commands, lines } = await setup([USER("one"), ASSISTANT("a1")], { session: true });
    const oldFile = agent.session.file;
    agent.session.flush();
    expect(await commands.handle("/session-name my-proper-name")).toBe(true);
    expect(agent.session.id).toBe("my-proper-name");
    expect(agent.session.file).toContain("my-proper-name.jsonl"); // date + uuid8 prefix, then the new name
    expect(existsSync(oldFile)).toBe(false); // the old name's file moved
    expect(readFileSync(agent.session.file, "utf8")).toContain('"id":"my-proper-name"');
    expect(readFileSync(agent.session.file, "utf8")).toContain("one"); // the content moved along
    expect(lines[0]).toContain("session renamed: my-proper-name");
    // and it resumes under the new name
    const replayed = SessionStore.resume({ id: "my-proper-name", dir: agent.session.dir });
    expect(replayed.context).toHaveLength(2);
    agent.session.close();
    replayed.close();
  });

  test("refuses a taken name, an invalid one, a reserved spelling, and an anonymous session", async () => {
    const { agent, commands, lines } = await setup([USER("one")], { session: true });
    agent.session.flush();
    await commands.handle("/session-name other");
    await commands.handle("/session-name commands-test"); // would clobber the old file? it's gone — wait, it moved
    expect(lines.join("")).toContain("renamed: commands-test"); // the old file moved away, so the name is free
    await commands.handle("/session-new named-two");
    await commands.handle("/session-name commands-test"); // taken by the (moved) first session
    expect(lines.at(-1)).toContain('already exists');
    await commands.handle("/session-name false");
    expect(lines.at(-1)).toContain("reserved");
    await commands.handle("/session-name bad name");
    expect(lines.at(-1)).toContain("usage"); // two words = a usage error
    await commands.handle("/session-name bad/name");
    expect(lines.at(-1)).toContain("invalid session name");
    await commands.handle("/session-new false"); // anonymous
    await commands.handle("/session-name whatever");
    expect(lines.at(-1)).toContain("anonymous session has no file to name");
  });
});

describe("cli-commands: /context-copy", () => {
  test("copies the LAST assistant response's text through the injected clipboard", async () => {
    const env = await testEnv();
    const agent = new Agent({
      env, model: "fake/m",
      context: [USER("q1"), ASSISTANT("older answer"), USER("q2"), ASSISTANT("the last answer")],
    });
    const copied = [];
    const lines = [];
    const commands = createCommands({
      agent, log: (l) => lines.push(l),
      copy: async (t) => { copied.push(t); return true; },
    });
    expect(await commands.handle("/context-copy")).toBe(true);
    expect(copied).toEqual(["the last answer"]);
    expect(lines[0]).toContain("copied the last response");
  });

  test("reports when no assistant response exists; a failing clipboard is reported too", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [USER("only a question")] });
    const lines = [];
    const commands = createCommands({
      agent, log: (l) => lines.push(l), copy: async () => false,
    });
    await commands.handle("/context-copy");
    expect(lines[0]).toContain("no assistant response");
    agent.append(ASSISTANT("now there is one"));
    await commands.handle("/context-copy");
    expect(lines[1]).toContain("clipboard unavailable");
  });
});

describe("cli-commands: /context-edit interactive routing (onEditMode)", () => {
  test("bare /context-edit and /context-edit <i> route to the hook; text forms stay direct", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [USER("one"), ASSISTANT("two")] });
    const entered = [];
    const commands = createCommands({
      agent, log: () => {}, onEditMode: (i) => entered.push(i),
    });
    await commands.handle("/context-edit");
    await commands.handle("/context-edit 0");
    expect(entered).toEqual([1, 0]); // default: the last message
    expect(agent.context).toEqual([USER("one"), ASSISTANT("two")]); // the hook owns editing
    await commands.handle("/context-edit 0 rewritten");
    expect(agent.context[0].content[0].text).toBe("rewritten"); // direct form untouched
  });
});

const THINKING_ASSISTANT = (thinking, text) => ({
  type: 3,
  content: [{ type: "thinking", text: thinking }, { type: "text", text }],
});

describe("cli-commands: /context-clear-thoughts", () => {
  test("strips every THINKING block from every assistant message, keeps the rest", async () => {
    const { agent, commands, lines } = await setup([
      USER("q1"),
      THINKING_ASSISTANT("reasoning one", "answer one"),
      USER("q2"),
      THINKING_ASSISTANT("reasoning two", "answer two"),
    ]);
    expect(await commands.handle("/context-clear-thoughts")).toBe(true);
    expect(agent.context[1].content).toEqual([{ type: "text", text: "answer one" }]);
    expect(agent.context[3].content).toEqual([{ type: "text", text: "answer two" }]);
    expect(lines[0]).toContain("cleared thinking blocks from 2 message(s)");
  });

  test("with no thinking blocks anywhere, reports it and leaves the context untouched", async () => {
    const { agent, commands, lines } = await setup([USER("q1"), ASSISTANT("a1")]);
    const before = JSON.stringify(agent.context);
    expect(await commands.handle("/context-clear-thoughts")).toBe(true);
    expect(JSON.stringify(agent.context)).toBe(before);
    expect(lines[0]).toContain("no thinking blocks");
  });

  test("rejects arguments", async () => {
    const { commands, lines } = await setup([]);
    await commands.handle("/context-clear-thoughts extra");
    expect(lines[0]).toContain("usage: /context-clear-thoughts");
  });
});

describe("cli-commands: /context-compact", () => {
  test("routes to onCompact with no arguments", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [USER("one")] });
    let called = 0;
    const commands = createCommands({ agent, onCompact: async () => { called++; } });
    expect(await commands.handle("/context-compact")).toBe(true);
    expect(called).toBe(1);
  });

  test("refuses an empty context without calling onCompact", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [] });
    let called = 0;
    const lines = [];
    const commands = createCommands({ agent, log: (l) => lines.push(l), onCompact: async () => { called++; } });
    await commands.handle("/context-compact");
    expect(called).toBe(0);
    expect(lines[0]).toContain("nothing to compact");
  });

  test("without an onCompact hook, reports it's unavailable", async () => {
    const { commands, lines } = await setup([USER("one")]);
    await commands.handle("/context-compact");
    expect(lines[0]).toContain("not available");
  });
});

describe("cli-commands: /endpoint-logout", () => {
  test("/endpoint-logout <endpoint> removes the endpoint and clears a combo pointing at it", async () => {
    const { agent, commands, lines } = await setup([USER("q")]);
    agent.env.endpoints.acme = { provider: "fake", url: "http://x" };
    agent.endpoint = "acme";
    agent.model = "m";
    expect(await commands.handle("/endpoint-logout acme")).toBe(true);
    expect(agent.env.endpoint("acme")).toBeUndefined();
    expect(agent.endpoint).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(lines[0]).toContain("endpoint removed: acme");
    expect(lines[0]).toContain("combo is cleared");
  });

  test("/endpoint-logout on an endpoint the combo doesn't use keeps the combo", async () => {
    const { agent, commands, lines } = await setup([]);
    agent.env.endpoints.acme = { provider: "fake", url: "http://x" };
    agent.env.endpoints.other = { provider: "fake", url: "http://y" };
    agent.endpoint = "other";
    await commands.handle("/endpoint-logout acme");
    expect(agent.endpoint).toBe("other");
    expect(lines[0]).toBe("endpoint removed: acme");
  });

  test("/endpoint-logout usage errors: missing name, unknown endpoint", async () => {
    const { agent, commands, lines } = await setup([]);
    await commands.handle("/endpoint-logout");
    await commands.handle("/endpoint-logout nope");
    expect(lines.some((l) => l.includes("usage: /endpoint-logout <endpoint>"))).toBe(true);
    expect(lines.some((l) => l.includes('unknown endpoint "nope"'))).toBe(true);
    expect(agent.env.endpointNames()).toEqual(expect.arrayContaining(["fake", "p", "test"]));
  });
});

describe("cli-commands: /session-delete-all!", () => {
  async function setupSessions() {
    const env = await testEnv();
    const dir = mkdtempSync("./ai-tmp/commands-sessions-");
    const lines = [];
    const agent = new Agent({
      env, model: "fake/m", context: [],
      session: new SessionStore({ id: "live", dir, context: [], origin: env.cwd }),
    });
    for (const id of ["one", "two"]) {
      const store = new SessionStore({ id, dir, origin: env.cwd });
      store.append(USER("q"));
      store.close();
    }
    const commands = createCommands({ agent, log: (l) => lines.push(l) });
    return { agent, commands, lines, dir };
  }

  test("asks for confirmation; only 'Delete all' deletes every session file", async () => {
    const { agent, commands, lines, dir } = await setupSessions();
    agent.setQuestion({ ask: async () => [{ labels: ["Cancel"] }] });
    await commands.handle("/session-delete-all!");
    expect(lines[0]).toContain("cancelled");
    expect(findSessionFile(dir, "one")).not.toBeUndefined();

    agent.setQuestion({ ask: async (qs) => {
      expect(qs[0].header).toBe("Sessions");
      expect(qs[0].question).toContain("ALL 2 session file(s)");
      return [{ labels: ["Delete all"] }];
    } });
    await commands.handle("/session-delete-all!");
    expect(lines.at(-1)).toContain("deleted 2 session file(s)");
    expect(findSessionFile(dir, "one")).toBeUndefined();
    expect(findSessionFile(dir, "two")).toBeUndefined();
  });

  test("an empty folder and a missing bridge report cleanly", async () => {
    const { agent, commands, lines } = await setupSessions();
    agent.setQuestion({ ask: async () => [{ labels: ["Delete all"] }] });
    await commands.handle("/session-delete-all!"); // deletes the two
    await commands.handle("/session-delete-all!"); // nothing left
    expect(lines.at(-1)).toContain("no session files");
    const { commands: bare, lines: bareLines } = await setup([]);
    await bare.handle("/session-delete-all!");
    expect(bareLines[0]).toContain("question bridge");
  });
});
