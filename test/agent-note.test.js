// test/agent-note.test.js — proof for the NOTE tool (tools/note.js):
// the context-OWNED short-memory store behind ONE tool (`note`) with
// an action discriminator. Every call derives the notes by scanning
// the agent's context for its own successful note calls and replaying
// them (failed/unanswered calls apply nothing; a context edit that
// drops the call drops the note). set MERGE-PATCHES (RFC 7386: objects merge
// recursively, null deletes a field, a null patch deletes the note,
// missing notes upsert); get returns a uniform title→note map (all
// fields by default, `only` filters); remove ["*"] clears the store;
// type is free-form data (badges resolve at display). Confirmations
// are terse; the agent-owned sticky message lists every note as a
// badge-headed title. End-to-end through the Agent's tool loop over
// the scripted TEST provider (providers/test.js — zero network, zero
// model).
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { testEnv, USER } from "./fakes.js";
import * as tools from "../tools/note.js";
import TestPlugin from "../providers/test.js";

const { note } = tools;

// a recorded note tool call (assistant message, type 3) + its result (type 4)
const TC = (callId, name, args) => ({ type: 3, content: [{ type: "toolCall", callId, name, arguments: args }] });
const TR = (callId, name, error = false) => ({
  type: 4, callId, name, ...(error ? { error: true } : {}), content: [{ type: "text", text: "x" }],
});
const agentOf = (...messages) => ({
  context: [...messages],
  toolStorage(name) {
    const stores = (this._toolStorage ??= Object.create(null));
    return (stores[name] ??= {});
  },
});

describe("note tool: the store is DERIVED from the context's own note calls", () => {
  test("successful set calls apply in order; patches MERGE, null deletes a field", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { api: { content: "v1", summary: "s1" } } }), TR("c1", "note"),
      TC("c2", "note", { action: "set", notes: { api: { content: "v2", summary: null } } }), TR("c2", "note"),
    );
    expect(note({ action: "get", notes: ["api"] }, { agent })).toBe('{\n "api": {\n  "content": "v2"\n }\n}');
  });

  test("FAILED and UNANSWERED calls apply nothing; remove deletes", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { kept: { content: "yes" } } }), TR("c1", "note"),
      TC("c2", "note", { action: "set", notes: { failed: { content: "no" } } }), TR("c2", "note", true), // error result
      TC("c3", "note", { action: "set", notes: { pending: { content: "no" } } }), // no result at all
      TC("c4", "note", { action: "remove", notes: ["kept"] }), TR("c4", "note"),
    );
    expect(note({ action: "list" }, { agent })).toBe("No notes.");
  });

  test("arguments arriving as JSON TEXT parse the same (provider dialects differ)", () => {
    const agent = agentOf(
      TC("c1", "note", JSON.stringify({ action: "set", notes: { db: { content: "postgres :5432" } } })), TR("c1", "note"),
    );
    expect(note({ action: "get", notes: ["db"] }, { agent })).toContain("postgres :5432");
  });

  test("titles trim consistently between writing and reading", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { "  padded  ": { content: "x" } } }), TR("c1", "note"),
    );
    expect(note({ action: "get", notes: ["padded"] }, { agent })).toContain("x");
  });

  test("a note-store RECORD is the BASELINE; calls replay ON TOP of it", () => {
    const agent = agentOf(
      { type: "note-store", notes: { old: { content: "from the record" }, replaced: { content: "v1" } } },
      { type: 2, content: [{ type: "text", text: "anchor" }] },
      TC("c1", "note", { action: "set", notes: { replaced: { content: "v2" } } }), TR("c1", "note"),
      TC("c2", "note", { action: "remove", notes: ["old"] }), TR("c2", "note"),
    );
    expect(note({ action: "list" }, { agent })).toContain("1 note:");
    expect(note({ action: "get", notes: ["replaced"] }, { agent })).toContain("v2");
  });

  test("every set/remove PERSISTS a snapshot record; the derivation PREFERS a fresh same-context snapshot", () => {
    const agent = agentOf(
      { type: 2, content: [{ type: "text", text: "anchor" }] },
      TC("c1", "note", { action: "set", notes: { temp: { content: "survives" } } }), TR("c1", "note"),
    );
    expect(note({ action: "list" }, { agent })).toContain("temp"); // derives from the replay
    expect(agent.context.some((m) => m?.type === "note-store")).toBe(false); // reads persist nothing
    expect(note({ action: "set", notes: { temp: { content: "v2" } } }, { agent })).toBe("note saved");
    const record = agent.context.find((m) => m?.type === "note-store");
    expect(record.notes).toEqual({ temp: { content: "v2" } }); // the snapshot joined the context
    expect(note({ action: "list" }, { agent })).toContain("temp"); // the fresh snapshot answers directly
  });

  test("the owner guard: a NEW context (new/resumed session) starts clean — no snapshot leak", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { "old session": { content: "x" } } }), TR("c1", "note"),
    );
    expect(note({ action: "list" }, { agent })).toContain("old session");
    agent.context = []; // a new session's fresh array: the snapshot's owner no longer matches
    expect(note({ action: "list" }, { agent })).toContain("No notes");
  });

  test("an EMPTY context (no numeric-type message) RESETS the store", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { kept: { content: "x" } } }), TR("c1", "note"),
    );
    expect(note({ action: "list" }, { agent })).toContain("kept");
    agent.context.length = 0; // a full clear in place (the same array)
    expect(note({ action: "list" }, { agent })).toBe("No notes."); // reset, not resurrected
    expect(agent.toolStorage("note").snapshot).toBeUndefined(); // the cache cleared too
  });

  test("deleting the LAST note STAYS deleted — the empty snapshot persists (no resurrection)", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { a: { content: "1" }, b: { content: "2" } } }), TR("c1", "note"),
      TC("c2", "note", { action: "remove", notes: ["a"] }), TR("c2", "note"),
    );
    expect(note({ action: "list" }, { agent })).toBe("1 note:\n- b");
    expect(note({ action: "remove", notes: ["b"] }, { agent })).toBe("note removed");
    expect(note({ action: "list" }, { agent })).toBe("No notes."); // the empty snapshot answers
    agent.context.push(TC("c3", "note", { action: "remove", notes: ["b"] }), TR("c3", "note"));
    expect(note({ action: "list" }, { agent })).toBe("No notes."); // even replayed, the snapshot holds
    const records = agent.context.filter((m) => m?.type === "note-store");
    expect(records.at(-1).notes).toEqual({}); // the empty snapshot persisted
    // ["*"] clears the same way
    const wiped = agentOf(TC("d1", "note", { action: "set", notes: { x: { content: "1" }, y: { content: "2" } } }), TR("d1", "note"));
    expect(note({ action: "remove", notes: ["*"] }, { agent: wiped })).toBe("removed all 2 notes");
    expect(note({ action: "list" }, { agent: wiped })).toBe("No notes.");
  });

  test("a context edit that drops note calls wins OUTRIGHT — deliberate edits stay authoritative", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { kept: { content: "1" } } }), TR("c1", "note"),
      TC("c2", "note", { action: "set", notes: { "edited away": { content: "2" } } }), TR("c2", "note"),
    );
    expect(note({ action: "list" }, { agent })).toContain("2 notes:");
    agent.context.splice(2, 2); // only the SECOND note's call+result dropped
    const out = note({ action: "list" }, { agent });
    expect(out).toContain("1 note:");
    expect(out).toContain("kept");
    expect(out).not.toContain("edited away"); // the edit won
  });
});

describe("note tool: set — merge-patch upsert/delete in one call", () => {
  test("one call upserts, patches and deletes several notes", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { a: { content: "1" }, b: { content: "2", type: "todo" } } }), TR("c1", "note"),
      TC("c2", "note", { action: "set", notes: { a: { type: "done" }, b: null } }), TR("c2", "note"),
    );
    expect(note({ action: "get", notes: ["a"] }, { agent })).toBe('{\n "a": {\n  "content": "1",\n  "type": "done"\n }\n}');
    expect(note({ action: "list" }, { agent })).toBe("No open notes (+1 done)."); // b deleted, a done
  });

  test("nested objects merge RECURSIVELY; arrays replace wholesale", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { p: { meta: { owner: "ada", prio: 3 }, tags: ["a", "b"] } } }), TR("c1", "note"),
      TC("c2", "note", { action: "set", notes: { p: { meta: { prio: 4 }, tags: ["c"] } } }), TR("c2", "note"),
    );
    const got = JSON.parse(note({ action: "get", notes: ["p"] }, { agent }));
    expect(got.p.meta).toEqual({ owner: "ada", prio: 4 }); // recursive merge
    expect(got.p.tags).toEqual(["c"]); // wholesale replace
  });

  test("set validates the whole map before any of it can apply", () => {
    const agent = agentOf();
    expect(() => note({ action: "set", notes: { ok: {}, "": {} } }, { agent })).toThrow(/non-empty title/);
    expect(() => note({ action: "set", notes: {} }, { agent })).toThrow(/at least one note/);
    expect(() => note({ action: "set", notes: ["x"] }, { agent })).toThrow(/title → patch map/); // a selector is not a payload
    expect(() => note({ action: "set", notes: { x: "nope" } }, { agent })).toThrow(/must be an object/);
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`t${i}`, {}]));
    expect(() => note({ action: "set", notes: tooMany }, { agent })).toThrow(/cap is 20/);
  });

  test("an empty patch creates the note; type is free-form data (no enum)", () => {
    expect(note({ action: "set", notes: { bare: {} } }, { agent: agentOf() })).toBe("note saved");
    expect(note({ action: "set", notes: { t: { type: "urgent" } } }, { agent: agentOf() })).toBe("note saved");
  });

  test("the store cap: an existing title merges even at the cap; a new one refuses", () => {
    const full = Array.from({ length: 100 }, (_, i) => [
      TC(`s${i}`, "note", { action: "set", notes: { [`n${i}`]: { content: "x" } } }), TR(`s${i}`, "note"),
    ]).flat();
    const capped = agentOf(...full);
    expect(() => note({ action: "set", notes: { "one more": { content: "x" } } }, { agent: capped })).toThrow(/store is full \(100\/100\)/);
    expect(note({ action: "set", notes: { n0: { content: "replaced" } } }, { agent: capped })).toBe("note saved");
  });

  test("the note is bounded", () => {
    const agent = agentOf();
    expect(() => note({ action: "set", notes: { ["t".repeat(161)]: {} } }, { agent })).toThrow(/160 or fewer/);
    expect(() => note({ action: "set", notes: { t: { content: "x".repeat(4097) } } }, { agent })).toThrow(/4096 or fewer/);
  });
});

describe("note tool: get — a uniform title → note map", () => {
  const agent = agentOf(
    TC("c1", "note", { action: "set", notes: { full: { type: "todo", summary: "the gist", content: "the whole story" } } }), TR("c1", "note"),
  );
  const ctx = { agent };

  test("default returns EVERY field; `only` filters; missing titles report in-line", () => {
    expect(note({ action: "get", notes: ["full"] }, ctx))
      .toBe('{\n "full": {\n  "type": "todo",\n  "summary": "the gist",\n  "content": "the whole story"\n }\n}');
    expect(note({ action: "get", notes: ["full"], only: ["summary"] }, ctx)).toBe('{\n "full": {\n  "summary": "the gist"\n }\n}');
    expect(note({ action: "get", notes: ["full", "nope"] }, ctx)).toContain('(no note: nope)');
    expect(() => note({ action: "get", notes: ["full"], only: "summary" }, ctx)).toThrow(/array of field names/);
    expect(() => note({ action: "get" }, ctx)).toThrow(/"notes" is required/);
  });

  test('["*"] reads every note; the map form works as a selector (tolerance)', () => {
    const all = note({ action: "get", notes: ["*"] }, ctx);
    expect(all).toContain('"full"');
    expect(note({ action: "get", notes: { full: {} } }, ctx)).toContain('"the gist"'); // keys are the selector
  });
});

describe("note tool: remove — selector deletes, ["*"] wipes", () => {
  test("missing titles report in-line, never an error; ["*"] deletes EVERY note", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { a: { content: "1" }, b: { content: "2" } } }), TR("c1", "note"),
    );
    expect(note({ action: "remove", notes: ["a", "nope"] }, { agent }))
      .toBe("note removed (no note: nope)");
    expect(note({ action: "remove", notes: ["*"] }, { agent })).toBe("removed all 1 note"); // the first remove persisted its snapshot: only b still stands
    expect(note({ action: "remove", notes: ["*"] }, { agent: agentOf() })).toBe("no notes to remove");
  });
});

describe("note tool: list — open notes with badges, done notes counted", () => {
  test("badges show; done notes hide behind the footer; an empty store says so", () => {
    const agent = agentOf(
      TC("c1", "note", { action: "set", notes: { plain: {} } }), TR("c1", "note"),
      TC("c2", "note", { action: "set", notes: { task: { type: "todo" } } }), TR("c2", "note"),
      TC("c3", "note", { action: "set", notes: { hot: { type: "in-focus" }, done1: { type: "done" } } }), TR("c3", "note"),
    );
    expect(note({ action: "list" }, { agent })).toBe("3 notes:\n- plain\n- 🔵 task\n- 🟠 hot\n(+1 done)");
    expect(note({ action: "list" }, { agent: agentOf() })).toBe("No notes.");
  });

  test("an unrecognized type falls back to the 📂 badge", () => {
    const agent = agentOf(
      { type: "note-store", notes: { typed: { type: "milestone", content: "x" }, plain: { type: "info" } } },
      { type: 2, content: [{ type: "text", text: "anchor" }] },
    );
    expect(note({ action: "list" }, { agent })).toBe("2 notes:\n- 📂 typed\n- 📂 plain");
  });
});

describe("note tool: regex search over the title and every field", () => {
  const agent = agentOf(
    TC("c1", "note", { action: "set", notes: { "deploy checklist": { content: "run migrations first" } } }), TR("c1", "note"),
    TC("c2", "note", { action: "set", notes: { "db host": { content: "primary at 10.0.0.8", summary: "MIGRATION window Sundays", type: "info" } } }), TR("c2", "note"),
  );

  test("a pattern matches any field; the matching notes are NAMED", () => {
    expect(note({ action: "search", pattern: "migrations" }, { agent })).toContain("- deploy checklist (matched: content)");
    expect(note({ action: "search", pattern: "^db" }, { agent })).toContain("- db host (matched: title)");
    expect(note({ action: "search", pattern: "sundays" }, { agent })).toContain("- db host (matched: summary)"); // case-insensitive
    expect(note({ action: "search", pattern: "migration" }, { agent })).toContain("2 match(es)");
  });

  test("field limits the search; invalid regex is an ordinary error", () => {
    const limited = note({ action: "search", pattern: "migration", field: "summary" }, { agent });
    expect(limited).toContain("1 match(es)");
    expect(limited).toContain("- db host");
    expect(note({ action: "search", pattern: "zzz" }, { agent })).toBe("No notes match /zzz/.");
    expect(() => note({ action: "search", pattern: "[" }, { agent })).toThrow(/invalid regular expression/);
    expect(() => note({ action: "search" }, { agent })).toThrow(/"search" requires "pattern"/);
  });

  test("a bad action names the enum", () => {
    expect(() => note({ action: "peek" }, { agent })).toThrow(/set, get, list, remove, search \(got "peek"\)/);
    expect(() => note({}, { agent })).toThrow(/"action" must be one of/);
  });
});

describe("note tool: the agent-owned sticky display (badge-headed titles, done trailing)", () => {
  /** A bare agent double carrying the real Agent's message surface. */
  const displayAgent = (...messages) => {
    const agent = agentOf(...messages);
    agent._toolMessages = new Map();
    agent.updateToolMessage = function (name, text) {
      if (text === null || text === undefined || text === "") this._toolMessages.delete(name);
      else this._toolMessages.set(name, String(text));
      return this._toolMessages.get(name) ?? null;
    };
    return agent;
  };
  // reading the message: any note call derives the store and publishes
  const message = (agent) => {
    note({ action: "list" }, { agent });
    return agent._toolMessages.get("note") ?? null;
  };

  test("mutations refresh the message; EVERY note displays (no hidden notes)", () => {
    const agent = displayAgent(
      TC("c1", "note", { action: "set", notes: { "ship it": { type: "todo" } } }), TR("c1", "note"),
      TC("c2", "note", { action: "set", notes: { "api key": { type: "secret", content: "sk-..." } } }), TR("c2", "note"),
      TC("c3", "note", { action: "set", notes: { plain: {} } }), TR("c3", "note"),
    );
    // mutations land as recorded calls (the context IS the store)
    const record = (id, args) => agent.context.push(TC(id, "note", args), TR(id, "note"));
    // transparency: an unrecognized type falls back to the 📂 badge, never hidden
    expect(message(agent)).toBe("🔵 **ship it**\n📂 **api key**\n**plain**");
    record("c4", { action: "remove", notes: ["plain", "api key"] });
    expect(message(agent)).toBe("🔵 **ship it**");
    record("c5", { action: "remove", notes: ["*"] }); // a full clear in ONE call (the restore would resurrect a lone delete)
    expect(message(agent)).toBe(null); // nothing left: cleared
  });

  test("a long list is published in full — the tool never truncates its own message", () => {
    const calls = Array.from({ length: 8 }, (_, i) => [
      TC(`s${i}`, "note", { action: "set", notes: { [`note ${i + 1}`]: {} } }), TR(`s${i}`, "note"),
    ]).flat();
    const agent = displayAgent(...calls);
    const lines = message(agent).split("\n");
    // every note published, no cap and no overflow row (the TUI's own
    // per-tool line cap — lib/tui-helpers/view-rows.js infoLines —
    // decides how much of this actually gets shown)
    expect(lines).toHaveLength(8);
    expect(lines[7]).toBe("**note 8**");
  });

  test("a summary trails the title; DONE notes still publish, but trail every OPEN one", () => {
    const agent = displayAgent(
      TC("c1", "note", { action: "set", notes: { "ship it": { type: "todo", summary: "cut the release" } } }), TR("c1", "note"),
      TC("c2", "note", { action: "set", notes: { "wrapped up": { content: "x" }, "second open one": { type: "active" } } }), TR("c2", "note"),
      TC("c3", "note", { action: "set", notes: { "wrapped up": { type: "done" } } }), TR("c3", "note"),
    );
    expect(message(agent)).toBe("🔵 **ship it** — cut the release\n🟠 **second open one**\n✅ **wrapped up**");
  });
});

describe("note tool: end-to-end through the Agent's tool loop (scripted TEST provider)", () => {
  test("IO filters metadata records from the provider-bound context (the model never sees them)", async () => {
    const env = await testEnv();
    let seen = null;
    class Capturing extends TestPlugin {
      async send(msg) {
        seen = msg[1].messages; // the converted context the provider received
        return super.send(msg);
      }
    }
    env.registerProvider("capturing", Capturing);
    env.endpoints.capturing = { provider: "capturing", url: "test://script", secret: true };
    const { IO } = await import("../lib/io.js");
    const aiio = new IO({ env, model: "capturing/test-model", settings: { script: [[{ text: "ok" }]] } });
    const terminal = await aiio.write([
      { type: "note-store", notes: { a: { content: "hidden" } } },
      { type: 2, content: [{ type: "text", text: "hi" }] },
    ]);
    expect(terminal.type).toBe("done");
    expect(seen).toHaveLength(1); // the record stayed home
    expect(seen[0].type).toBe(2);
  });

  const testProviderAgent = async (script) => {
    const env = await testEnv();
    env.registerProvider("test", TestPlugin);
    env.endpoints.test = { provider: "test", url: "test://script", secret: true };
    await env.loadTools({ dirs: ["./tools"] }); // the real note tool
    const agent = new Agent({
      env, model: "test/test-model", session: "s-note",
      settings: { script }, // the per-invocation script (providers/test.js)
    });
    return { env, agent };
  };

  test("a note saved in one turn is found by list in the NEXT turn (derived mid-run)", async () => {
    const { agent } = await testProviderAgent([
      [{ toolCall: { name: "note", arguments: { action: "set", notes: { goal: { content: "ship the MVP", type: "in-focus" } } } } }],
      [{ toolCall: { name: "note", arguments: { action: "list" } } }],
      [{ text: "noted" }],
    ]);
    const terminal = await agent.run({});
    expect(terminal.type).toBe("done");
    const results = agent.context.filter((m) => m?.type === 4);
    expect(results).toHaveLength(2);
    expect(results[0].error).toBeUndefined(); // set ok
    expect(results[0].content.map((b) => b.text).join("\n")).toBe("note saved");
    // the SECOND turn's list derived the note from the record of the first
    const list = results[1].content.map((b) => b.text).join("\n");
    expect(list).toBe("1 note:\n- 🟠 goal");
    // the sticky display followed (agent-owned)
    expect(agent.toolMessages()).toEqual([{ name: "note", text: "🟠 **goal**" }]);
  });

  test("every set call's snapshot record PERSISTS with the session and re-loads as the baseline", async () => {
    const { env, agent } = await testProviderAgent([
      [{ toolCall: { name: "note", arguments: { action: "set", notes: { durable: { content: "across resume" } } } } }],
      [{ text: "done" }],
    ]);
    agent.enqueue(USER("go"));
    await agent.run({});
    expect(note({ action: "list" }, { agent })).toContain("durable");
    agent._flush(); // persist: the file carries the snapshot record
    const fileText = await Bun.file(agent.session.file).text();
    expect(fileText).toContain('"type":"note-store"');
    expect(fileText).toContain("durable");
    // resume: the record rides back in as the baseline (a FRESH agent —
    // no tool-storage snapshot, so the record is the only source)
    const { Agent: AgentClass } = await import("../lib/agent.js");
    const resumed = new AgentClass({ env, model: "test/test-model", session: agent.session.id });
    expect(note({ action: "list" }, { agent: resumed })).toContain("durable");
  });

  test("a rollback that drops a set call WINS — deliberate edits stay authoritative", async () => {
    const { agent } = await testProviderAgent([
      [{ toolCall: { name: "note", arguments: { action: "set", notes: { scratch: { content: "temporary" } } } } }],
      [{ text: "done" }],
    ]);
    agent.enqueue(USER("go")); // the context keeps a message after the rollback (never empty)
    await agent.run({});
    expect(note({ action: "list" }, { agent })).toContain("scratch");
    const at = agent.context.findIndex((m) =>
      (m?.content ?? []).some((b) => b?.type === "toolCall" && b.name === "note"));
    expect(at).toBeGreaterThanOrEqual(0);
    agent.rollback(at); // the call, its result AND its snapshot record leave the record
    expect(note({ action: "list" }, { agent })).toBe("No notes."); // the edit won
  });

  test("COMPACTION keeps the snapshot records (the store survives)", async () => {
    const { compactContext } = await import("../lib/agent/compact.js");
    const { agent } = await testProviderAgent([
      [{ toolCall: { name: "note", arguments: { action: "set", notes: { kept: { content: "through compaction" } } } } }],
      [{ text: "the summary" }], // the compaction turn's summary
      [{ text: "the summary" }],
    ]);
    agent.enqueue(USER("go"));
    await agent.run({});
    expect(note({ action: "list" }, { agent })).toContain("kept");
    const result = await compactContext(agent);
    expect(result.ok).toBe(true);
    expect(agent.context.some((m) => m?.type === "note-store")).toBe(true); // the record survived the rollback
    expect(note({ action: "list" }, { agent })).toContain("kept"); // the store rebuilt from it
  });

  test("the note tool publishes as a SAFE read-only host tool", async () => {
    const env = await testEnv();
    await env.loadTools({ dirs: ["./tools"] });
    const entry = env.toolEntry("note");
    expect(entry).toBeDefined();
    expect(entry.safe).toBe(true); // available in safe mode and in-process
    expect(env.toolEntry("note-set")).toBeUndefined(); // the six old tools are gone
  });
});
