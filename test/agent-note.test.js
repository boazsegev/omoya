// test/agent-note.test.js — proof for the NOTE tools (tools/note.js):
// note-list / note-read / note-write share `storage: "note"` (one storage
// box, one sticky message). The store is DERIVED from the context's own
// successful note-write calls (failed/unanswered calls apply nothing; a
// context edit that drops the call drops the note). note-write
// MERGE-PATCHES (RFC 7386: objects merge recursively, null deletes a
// field, a null patch deletes the note, missing notes upsert); note-read
// returns a uniform title→note map (omit titles for all); note-list shows
// every title with its badge, done notes last. End-to-end through the
// Agent's tool loop over the scripted TEST provider.
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { testEnv, USER } from "./fakes.js";
import * as tools from "../tools/note.js";
import { Context } from "../lib/context.js";
import TestPlugin from "../providers/test.js";
import { providerAdd, toolEntry, toolsLoad } from "./env-internals.js";
import { toolStorage } from "../lib/agent/tool-storage.js";
import { updateToolMessage } from "../lib/agent/tool-messages.js";

const ctxOf = (context) => ({
  ...context,
  storage: toolStorage(context.agent, "note"),
  messageSet: (text) => updateToolMessage(context.agent, "note", text),
});
const list = (context) => tools.note_list({}, ctxOf(context));
const read = (titles, context) => tools.note_read(titles === undefined ? {} : { titles }, ctxOf(context));
const write = (notes, context) => tools.note_write({ notes }, ctxOf(context));

// a recorded tool call (assistant message, type 3) + its result (type 4)
const TC = (callId, name, args) => ({ type: 3, content: [{ type: "toolCall", callId, name, arguments: args }] });
const TR = (callId, name, error = false) => ({
  type: 4, callId, name, ...(error ? { error: true } : {}), content: [{ type: "text", text: "x" }],
});
// a recorded successful (or failed) note-write
const W = (callId, notes, error = false) => [TC(callId, "note-write", { notes }), TR(callId, "note-write", error)];
const agentOf = (...messages) => ({ context: new Context({ messages: messages.flat() }) });

describe("note tools: the store is DERIVED from the context's own note-write calls", () => {
  test("successful writes apply in order; patches MERGE, null deletes a field", () => {
    const agent = agentOf(
      W("c1", { api: { content: "v1", summary: "s1" } }),
      W("c2", { api: { content: "v2", summary: null } }),
    );
    expect(read(["api"], { agent })).toBe('{\n "api": {\n  "content": "v2"\n }\n}');
  });

  test("FAILED and UNANSWERED calls apply nothing; a null patch deletes", () => {
    const agent = agentOf(
      W("c1", { kept: { content: "yes" } }),
      W("c2", { failed: { content: "no" } }, true), // error result
      TC("c3", "note-write", { notes: { pending: { content: "no" } } }), // no result at all
      W("c4", { kept: null }),
    );
    expect(list({ agent })).toBe("No notes.");
  });

  test("arguments arriving as JSON TEXT parse the same (provider dialects differ)", () => {
    const agent = agentOf(
      TC("c1", "note-write", JSON.stringify({ notes: { db: { content: "postgres :5432" } } })), TR("c1", "note-write"),
      TC("c2", "note-write", { notes: JSON.stringify({ cache: { content: "redis" } }) }), TR("c2", "note-write"),
    );
    expect(read(["db"], { agent })).toContain("postgres :5432");
    expect(read(["cache"], { agent })).toContain("redis");
  });

  test("titles trim consistently between writing and reading", () => {
    const agent = agentOf(W("c1", { "  padded  ": { content: "x" } }));
    expect(read(["padded"], { agent })).toContain("x");
  });

  test("calls of other tools never apply (the old single `note` tool is not replayed)", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { legacy: { content: "x" } } }), TR("c1", "note"),
    );
    expect(list({ agent })).toBe("No notes.");
  });

  test("a note-store RECORD is the BASELINE; calls replay ON TOP of it", () => {
    const agent = agentOf(
      { type: "note-store", notes: { old: { content: "from the record" }, replaced: { content: "v1" } } },
      { type: 2, content: [{ type: "text", text: "anchor" }] },
      W("c1", { replaced: { content: "v2" } }),
      W("c2", { old: null }),
    );
    expect(list({ agent })).toBe("1 note:\n- replaced");
    expect(read(["replaced"], { agent })).toContain("v2");
  });

  test("every write PERSISTS a snapshot record; the derivation PREFERS a fresh same-context snapshot", () => {
    const agent = agentOf(
      { type: 2, content: [{ type: "text", text: "anchor" }] },
      W("c1", { temp: { content: "survives" } }),
    );
    expect(list({ agent })).toContain("temp"); // derives from the replay
    expect(agent.context.messages().some((m) => m?.type === "note-store")).toBe(false); // reads persist nothing
    expect(write({ temp: { content: "v2" } }, { agent })).toBe("note saved");
    const record = agent.context.messages().find((m) => m?.type === "note-store");
    expect(record.notes).toEqual({ temp: { content: "v2" } }); // the snapshot joined the context
    expect(list({ agent })).toContain("temp"); // the fresh snapshot answers directly
  });

  test("a new Agent starts with its own note storage and context", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env });
    agent.context.append(TC("c1", "note-write", { notes: { "old session": { content: "x" } } }));
    agent.context.append(TR("c1", "note-write"));
    expect(list({ agent })).toContain("old session");
    write({ "old session": { content: "updated" } }, { agent });
    const next = await Agent.create({ env });
    expect(list({ agent: next })).toBe("No notes.");
    expect(toolStorage(next, "note")).not.toBe(toolStorage(agent, "note"));
    next.close();
    agent.close();
    env.close();
  });

  test("an EMPTY context (no numeric-type message) RESETS the store", () => {
    const agent = agentOf(W("c1", { kept: { content: "x" } }));
    expect(list({ agent })).toContain("kept");
    agent.context.update((messages) => { messages.length = 0; return true; }); // a full clear in place (the same Context)
    expect(list({ agent })).toBe("No notes."); // reset, not resurrected
    expect(toolStorage(agent, "note").snapshot).toBeUndefined(); // the cache cleared too
  });

  test("deleting the LAST note STAYS deleted — the empty snapshot persists (no resurrection)", () => {
    const agent = agentOf(
      W("c1", { a: { content: "1" }, b: { content: "2" } }),
      W("c2", { a: null }),
    );
    expect(list({ agent })).toBe("1 note:\n- b");
    expect(write({ b: null }, { agent })).toBe("note saved");
    expect(list({ agent })).toBe("No notes."); // the empty snapshot answers
    agent.context.update((messages) => { messages.push(...W("c3", { b: null })); return true; });
    expect(list({ agent })).toBe("No notes."); // even replayed, the snapshot holds
    const records = agent.context.messages().filter((m) => m?.type === "note-store");
    expect(records.at(-1).notes).toEqual({}); // the empty snapshot persisted
  });

  test("a context edit that drops note calls wins OUTRIGHT — deliberate edits stay authoritative", () => {
    const agent = agentOf(
      W("c1", { kept: { content: "1" } }),
      W("c2", { "edited away": { content: "2" } }),
    );
    expect(list({ agent })).toContain("2 notes:");
    agent.context.update((messages) => { messages.splice(2, 2); return true; }); // only the SECOND note's call+result dropped
    const out = list({ agent });
    expect(out).toContain("1 note:");
    expect(out).toContain("kept");
    expect(out).not.toContain("edited away"); // the edit won
  });
});

describe("note-write — merge-patch upsert/delete in one call", () => {
  test("one call upserts, patches and deletes several notes", () => {
    const agent = agentOf(
      W("c1", { a: { content: "1" }, b: { content: "2", type: "todo" } }),
      W("c2", { a: { type: "done" }, b: null }),
    );
    expect(read(["a"], { agent })).toBe('{\n "a": {\n  "content": "1",\n  "type": "done"\n }\n}');
    expect(list({ agent })).toBe("1 note:\n- ✅ a"); // b deleted, a done
  });

  test("nested objects merge RECURSIVELY; arrays replace wholesale", () => {
    const agent = agentOf(
      W("c1", { p: { meta: { owner: "ada", prio: 3 }, tags: ["a", "b"] } }),
      W("c2", { p: { meta: { prio: 4 }, tags: ["c"] } }),
    );
    const got = JSON.parse(read(["p"], { agent }));
    expect(got.p.meta).toEqual({ owner: "ada", prio: 4 }); // recursive merge
    expect(got.p.tags).toEqual(["c"]); // wholesale replace
  });

  test("the whole map validates before any of it can apply; errors name the valid form", () => {
    const agent = agentOf();
    expect(() => write({ ok: {}, "": {} }, { agent })).toThrow(/non-empty title/);
    expect(() => write({}, { agent })).toThrow(/is empty/);
    expect(() => write(["x"], { agent })).toThrow(/map each title to a patch object/); // titles alone carry no patch
    expect(() => write({ x: "nope" }, { agent })).toThrow(/must be an object/);
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`t${i}`, {}]));
    expect(() => write(tooMany, { agent })).toThrow(/at most 20/);
    expect(list({ agent })).toBe("No notes.");
  });

  test("a JSON-text notes map is accepted (liberal input)", () => {
    const agent = agentOf({ type: 2, content: [{ type: "text", text: "anchor" }] });
    expect(write(JSON.stringify({ j: { content: "parsed" } }), { agent })).toBe("note saved");
    expect(read(["j"], { agent })).toContain("parsed");
  });

  test("an empty patch creates the note; type is free-form data (no enum)", () => {
    expect(write({ bare: {} }, { agent: agentOf() })).toBe("note saved");
    expect(write({ t: { type: "urgent" } }, { agent: agentOf() })).toBe("note saved");
  });

  test("the store cap: an existing title merges even at the cap; a new one refuses", () => {
    const full = Array.from({ length: 100 }, (_, i) => W(`s${i}`, { [`n${i}`]: { content: "x" } }));
    const capped = agentOf(...full);
    expect(() => write({ "one more": { content: "x" } }, { agent: capped })).toThrow(/store is full \(100\/100\)/);
    expect(write({ n0: { content: "replaced" } }, { agent: capped })).toBe("note saved");
  });

  test("the note is bounded", () => {
    const agent = agentOf();
    expect(() => write({ ["t".repeat(161)]: {} }, { agent })).toThrow(/160 or fewer/);
    expect(() => write({ t: { content: "x".repeat(4097) } }, { agent })).toThrow(/4096 or fewer/);
  });
});

describe("note-read — a uniform title → note map", () => {
  const agent = agentOf(
    W("c1", { full: { type: "todo", summary: "the gist", content: "the whole story" } }),
    W("c2", { other: { content: "second" } }),
  );
  const ctx = { agent };

  test("returns every field; missing titles report in-line", () => {
    expect(read(["full"], ctx))
      .toBe('{\n "full": {\n  "type": "todo",\n  "summary": "the gist",\n  "content": "the whole story"\n }\n}');
    expect(read(["full", "nope"], ctx)).toContain("(no note: nope)");
  });

  test("omitted titles, [] or [\"*\"] read every note; a lone string or map infers titles", () => {
    for (const titles of [undefined, [], ["*"], "*"]) {
      const all = JSON.parse(read(titles, ctx));
      expect(Object.keys(all)).toEqual(["full", "other"]);
    }
    expect(read("full", ctx)).toContain('"the gist"');
    expect(read({ full: {} }, ctx)).toContain('"the gist"');
    expect(read(undefined, { agent: agentOf() })).toBe("No notes.");
  });
});

describe("note-list — every title with its badge, done notes last", () => {
  test("badges show; done notes trail the open ones; an empty store says so", () => {
    const agent = agentOf(
      W("c1", { plain: {} }),
      W("c2", { done1: { type: "done" }, task: { type: "todo" } }),
      W("c3", { hot: { type: "in-focus" } }),
    );
    expect(list({ agent })).toBe("4 notes:\n- plain\n- 🔵 task\n- 🟠 hot\n- ✅ done1");
    expect(list({ agent: agentOf() })).toBe("No notes.");
  });

  test("an unrecognized type falls back to the 📂 badge", () => {
    const agent = agentOf(
      { type: "note-store", notes: { typed: { type: "milestone", content: "x" }, plain: { type: "info" } } },
      { type: 2, content: [{ type: "text", text: "anchor" }] },
    );
    expect(list({ agent })).toBe("2 notes:\n- 📂 typed\n- 📂 plain");
  });
});

describe("note tools: the agent-owned sticky display (badge-headed titles, done trailing)", () => {
  /** A bare agent double carrying the real Agent's message surface. */
  const displayAgent = (...messages) => {
    const agent = agentOf(...messages);
    agent._toolMessages = new Map();
    return agent;
  };
  // reading the message: any note call derives the store and publishes
  const message = (agent) => {
    list({ agent });
    return agent._toolMessages.get("note") ?? null;
  };

  test("mutations refresh the message; EVERY note displays (no hidden notes)", () => {
    const agent = displayAgent(
      W("c1", { "ship it": { type: "todo" } }),
      W("c2", { "api key": { type: "secret", content: "sk-..." } }),
      W("c3", { plain: {} }),
    );
    // mutations land as recorded calls (the context IS the store)
    const record = (id, notes) => agent.context.update((messages) => { messages.push(...W(id, notes)); return true; });
    // transparency: an unrecognized type falls back to the 📂 badge, never hidden
    expect(message(agent)).toBe("🔵 **ship it**\n📂 **api key**\n**plain**");
    record("c4", { plain: null, "api key": null });
    expect(message(agent)).toBe("🔵 **ship it**");
    record("c5", { "ship it": null });
    expect(message(agent)).toBe(null); // nothing left: cleared
  });

  test("a long list is published in full — the tool never truncates its own message", () => {
    const calls = Array.from({ length: 8 }, (_, i) => W(`s${i}`, { [`note ${i + 1}`]: {} }));
    const lines = message(displayAgent(...calls)).split("\n");
    expect(lines).toHaveLength(8);
    expect(lines[7]).toBe("**note 8**");
  });

  test("a summary trails the title; DONE notes still publish, but trail every OPEN one", () => {
    const agent = displayAgent(
      W("c1", { "ship it": { type: "todo", summary: "cut the release" } }),
      W("c2", { "wrapped up": { content: "x" }, "second open one": { type: "active" } }),
      W("c3", { "wrapped up": { type: "done" } }),
    );
    expect(message(agent)).toBe("🔵 **ship it** — cut the release\n🟠 **second open one**\n✅ **wrapped up**");
  });
});

describe("note tools: end-to-end through the Agent's tool loop (scripted TEST provider)", () => {
  test("IO filters metadata records from the provider-bound context (the model never sees them)", async () => {
    const env = await testEnv();
    let seen = null;
    class Capturing extends TestPlugin {
      async send(msg) {
        seen = msg[1].messages; // the converted context the provider received
        return super.send(msg);
      }
    }
    providerAdd(env, "capturing", Capturing);
    env.settings.providers.capturing = { provider: "capturing", url: "test://script", secret: true };
    const { IO } = await import("../lib/io.js");
    env.settings.providers.capturing.script = [[{ text: "ok" }]];
    const aiio = new IO({ env, model: "capturing/test-model" });
    const context = new Context({ messages: [
      { type: "note-store", notes: { a: { content: "hidden" } } },
      { type: 2, content: [{ type: "text", text: "hi" }] },
    ] });
    const terminal = await aiio.write(context);
    expect(terminal.type).toBe("done");
    expect(seen).toHaveLength(1); // the record stayed home
    expect(seen[0].type).toBe(2);
    expect(context.messages().some((message) => message.type === "note-store")).toBe(true);
    expect(context.messages().filter((message) => message.type === "io-root")).toHaveLength(1);
  });

  const testProviderAgent = async (script) => {
    const env = await testEnv();
    providerAdd(env, "test", TestPlugin);
    env.settings.providers.test = { provider: "test", url: "test://script", secret: true };
    env.settings.providers.test.script = script;
    await toolsLoad(env, { dirs: ["./tools"] }); // the real note tools
    const agent = await Agent.create({ env, model: "test/test-model", contextId: "s-note" });
    return { env, agent };
  };

  test("a note written in one turn is listed in the NEXT turn; all three tools publish ONE message", async () => {
    const { agent } = await testProviderAgent([
      [{ toolCall: { name: "note-write", arguments: { notes: { goal: { content: "ship the MVP", type: "in-focus" } } } } }],
      [{ toolCall: { name: "note-list", arguments: {} } }],
      [{ toolCall: { name: "note-read", arguments: { titles: ["goal"] } } }],
      [{ text: "noted" }],
    ]);
    const terminal = await agent.run({});
    expect(terminal.type).toBe("done");
    const results = agent.context.messages().filter((m) => m?.type === 4);
    expect(results).toHaveLength(3);
    expect(results[0].error).toBeUndefined();
    expect(results[0].content.map((b) => b.text).join("\n")).toBe("note saved");
    expect(results[1].content.map((b) => b.text).join("\n")).toBe("1 note:\n- 🟠 goal");
    expect(results[2].content.map((b) => b.text).join("\n")).toContain("ship the MVP");
    // the sticky display: keyed by the shared storage name, never per tool
    expect(agent.toolMessages()).toEqual([{ name: "note", text: "🟠 **goal**" }]);
  });

  test("every write's snapshot record PERSISTS with the session and re-loads as the baseline", async () => {
    const { env, agent } = await testProviderAgent([
      [{ toolCall: { name: "note-write", arguments: { notes: { durable: { content: "across resume" } } } } }],
      [{ text: "done" }],
    ]);
    agent.send(USER("go"));
    await agent.run({});
    expect(list({ agent })).toContain("durable");
    agent._flush(); // persist: the file carries the snapshot record
    const fileText = await Bun.file(agent.context.file).text();
    expect(fileText).toContain('"type":"note-store"');
    expect(fileText).toContain("durable");
    // resume: the record rides back in as the baseline (a FRESH agent)
    const resumed = await Agent.create({ env, model: "test/test-model", contextId: agent.context.id });
    // the note-list detector republishes under the shared storage name
    await resumed._toolMessagesDetected;
    expect(resumed.toolMessages()).toEqual([{ name: "note", text: "**durable**" }]);
    expect(list({ agent: resumed })).toContain("durable");
  });

  test("a rollback that drops a write WINS — deliberate edits stay authoritative", async () => {
    const { agent } = await testProviderAgent([
      [{ toolCall: { name: "note-write", arguments: { notes: { scratch: { content: "temporary" } } } } }],
      [{ text: "done" }],
    ]);
    agent.send(USER("go")); // the context keeps a message after the rollback (never empty)
    await agent.run({});
    expect(list({ agent })).toContain("scratch");
    const at = agent.context.messages().findIndex((m) =>
      (m?.content ?? []).some((b) => b?.type === "toolCall" && b.name === "note-write"));
    expect(at).toBeGreaterThanOrEqual(0);
    agent.context.rollback(at); // the call, its result AND its snapshot record leave the record
    expect(list({ agent })).toBe("No notes."); // the edit won
  });

  test("COMPACTION keeps the snapshot records (the store survives)", async () => {
    const { compactContext } = await import("../lib/agent/compact.js");
    const { agent } = await testProviderAgent([
      [{ toolCall: { name: "note-write", arguments: { notes: { kept: { content: "through compaction" } } } } }],
      [{ text: "the summary" }], // the compaction turn's summary
      [{ text: "the summary" }],
    ]);
    agent.send(USER("go"));
    await agent.run({});
    expect(list({ agent })).toContain("kept");
    const result = await compactContext(agent);
    expect(result.ok).toBe(true);
    expect(agent.context.messages().some((m) => m?.type === "note-store")).toBe(true); // the record survived the rollback
    expect(list({ agent })).toContain("kept"); // the store rebuilt from it
  });

  test("manual Env.toolCall with an Agent retains note storage and the shared sticky display", async () => {
    const env = await testEnv();
    await toolsLoad(env, { dirs: ["./tools"] });
    const agent = await Agent.create({ env });
    agent.context.append(USER("manual note"));
    try {
      expect(await env.toolCall("note-write", { notes: { manual: { type: "todo" } } }, { agent })).toBe("note saved");
      expect(await env.toolCall("note-list", {}, { agent })).toContain("manual");
      expect(toolStorage(agent, "note").snapshot?.owner).toBe(agent.context);
      expect(agent.toolMessages()).toEqual([{ name: "note", text: "🔵 **manual**" }]);
    } finally {
      agent.close();
      env.close();
    }
  });

  test("the note tools publish as SAFE host tools sharing one storage; the old `note` is gone", async () => {
    const env = await testEnv();
    await toolsLoad(env, { dirs: ["./tools"] });
    for (const name of ["note-list", "note-read", "note-write"]) {
      const entry = toolEntry(env, name);
      expect(entry?.safe).toBe(true);
      expect(entry.storage).toBe("note");
    }
    expect(toolEntry(env, "note")).toBeUndefined();
  });
});
