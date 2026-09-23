// test/agent-note.test.js — proof for the NOTE tool (tools/note.js):
// the context-OWNED short-memory store — every call derives the notes
// by scanning the agent's context for its own successful note calls
// and replaying them (failed/unanswered calls apply nothing; a
// context edit that drops the call drops the note). A note is a small
// JSON object keyed by its title (type/summary/content the suggested
// convention); note-set MERGES (null deletes a field — `type` merges
// like any other); note-get reads
// selected fields via `only` (default content); note-remove "*" clears
// the store; the type validation guards the recommended display types
// (aliases accepted, an unrecognized one falls back); confirmations are
// terse; and the
// agent-owned sticky message lists the non-secret, badge-headed
// titles. End-to-end through the Agent's tool loop over the scripted
// TEST provider (providers/test.js — zero network, zero model).
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { testEnv, USER } from "./fakes.js";
import * as note from "../tools/note.js";
import TestPlugin from "../providers/test.js";

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
  test("successful note-set calls apply in order; fields MERGE, null deletes", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "api", content: "v1", summary: "s1" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "api", content: "v2", summary: null }), TR("c2", "note-set"),
    );
    expect(note["note-get"]({ title: "api" }, { agent })).toBe("v2");
    expect(note["note-get"]({ title: "api", only: ["summary"] }, { agent })).toBe("(no summary)"); // deleted by the merge
  });

  test("FAILED and UNANSWERED calls apply nothing; note-remove deletes", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "kept", content: "yes" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "failed", content: "no" }), TR("c2", "note-set", true), // error result
      TC("c3", "note-set", { title: "pending", content: "no" }), // no result at all
      TC("c4", "note-remove", { title: "kept" }), TR("c4", "note-remove"),
    );
    expect(note["note-list"]({}, { agent })).toBe("No notes.");
  });

  test("a LEGACY note-type-set call still replays on top (old contexts): it changed only the type", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "task", content: "ship it", type: "todo" }), TR("c1", "note-set"),
      TC("c2", "note-type-set", { title: "task", type: "done" }), TR("c2", "note-type-set"),
    );
    expect(note["note-get"]({ title: "task", only: ["type"] }, { agent })).toBe("done");
    expect(note["note-get"]({ title: "task" }, { agent })).toBe("ship it"); // untouched
  });

  test("arguments arriving as JSON TEXT parse the same (provider dialects differ)", () => {
    const agent = agentOf(
      TC("c1", "note-set", JSON.stringify({ title: "db", content: "postgres :5432" })), TR("c1", "note-set"),
    );
    expect(note["note-get"]({ title: "db" }, { agent })).toContain("postgres :5432");
  });

  test("titles trim consistently between writing and reading", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "  padded  ", content: "x" }), TR("c1", "note-set"),
    );
    expect(note["note-get"]({ title: "padded" }, { agent })).toContain("x");
  });

  test("a note-store RECORD is the BASELINE; calls replay ON TOP of it", () => {
    const agent = agentOf(
      { type: "note-store", notes: { old: { content: "from the record" }, replaced: { content: "v1" } } },
      TC("c1", "note-set", { title: "replaced", content: "v2" }), TR("c1", "note-set"),
      TC("c2", "note-remove", { title: "old" }), TR("c2", "note-remove"),
    );
    expect(note["note-list"]({}, { agent })).toContain("1 note:");
    expect(note["note-get"]({ title: "replaced" }, { agent })).toContain("v2");
  });

  test("a context edit that drops EVERY note call RESTORES from the backup (a fresh record joins the context)", () => {
    const agent = agentOf(
      { type: 2, content: [{ type: "text", text: "anchor" }] }, // the context is never empty after a compaction
      TC("c1", "note-set", { title: "temp", content: "survives" }), TR("c1", "note-set"),
    );
    expect(note["note-list"]({}, { agent })).toContain("temp");
    agent.context.splice(1, 2); // compaction/edit removed the call and its result (messages remain)
    const out = note["note-list"]({}, { agent });
    expect(out).toContain("temp"); // restored, not lost
    const record = agent.context.find((m) => m?.type === "note-store");
    expect(record).toBeDefined(); // the restore record joined the context
    expect(record.notes).toEqual({ temp: { content: "survives" } });
  });

  test("the owner guard: a NEW context (new/resumed session) starts clean — no restore leak", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "old session", content: "x" }), TR("c1", "note-set"),
    );
    expect(note["note-list"]({}, { agent })).toContain("old session");
    agent.context = []; // a new session's fresh array: the backup's owner no longer matches
    expect(note["note-list"]({}, { agent })).toContain("No notes");
    expect(agent.context.some((m) => m?.type === "note-store")).toBe(false); // no record appended
  });

  test("an EMPTY context (no numeric-type message) RESETS the store instead of restoring", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "kept", content: "x" }), TR("c1", "note-set"),
    );
    expect(note["note-list"]({}, { agent })).toContain("kept"); // the backup populated
    agent.context.length = 0; // a full clear in place (the same array — the old restore path would fire)
    expect(note["note-list"]({}, { agent })).toBe("No notes."); // reset, not resurrected
    expect(agent.toolStorage("note").backup.notes.size).toBe(0); // the cache cleared too
    expect(agent.context.some((m) => m?.type === "note-store")).toBe(false); // no restore record
  });

  test("a PARTIAL rebuild wins outright — no merge from the backup (deliberate edits stay authoritative)", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "kept", content: "1" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "edited away", content: "2" }), TR("c2", "note-set"),
    );
    expect(note["note-list"]({}, { agent })).toContain("2 notes:");
    agent.context.splice(2, 2); // only the SECOND note's call+result dropped
    const out = note["note-list"]({}, { agent });
    expect(out).toContain("1 note:");
    expect(out).toContain("kept");
    expect(out).not.toContain("edited away"); // the partial rebuild won
  });
});

describe("note tool: batching (note-set notes[]) and the note-done shortcut", () => {
  test("note-set accepts several notes in one call", () => {
    const agent = agentOf(
      TC("c1", "note-set", { notes: [{ title: "a", content: "1" }, { title: "b", content: "2", type: "todo" }] }),
      TR("c1", "note-set"),
    );
    expect(note["note-list"]({}, { agent })).toBe("2 notes:\n- a\n- 🔵 b");
    expect(note["note-get"]({ title: "b" }, { agent })).toBe("2");
  });

  test("note-set batch validates every item before any of it can apply", () => {
    const agent = agentOf();
    expect(() => note["note-set"]({ notes: [{ title: "ok" }, { title: "" }] }, { agent }))
      .toThrow(/must not be empty/);
    expect(() => note["note-set"]({ notes: [] }, { agent })).toThrow(/at least one note is required/);
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ title: `t${i}` }));
    expect(() => note["note-set"]({ notes: tooMany }, { agent })).toThrow(/cap is 20/);
  });

  test("note-done marks existing notes' type done without touching the rest", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "ship", content: "the thing", type: "todo" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "other", content: "x" }), TR("c2", "note-set"),
      TC("c3", "note-done", { notes: ["ship", "other"] }), TR("c3", "note-done"),
    );
    expect(note["note-get"]({ title: "ship", only: ["type", "content"] }, { agent }))
      .toBe('# ship\n{"type":"done","content":"the thing"}');
    expect(note["note-get"]({ title: "other", only: ["type"] }, { agent })).toBe("done");
  });

  test("note-done refuses (and applies nothing) when any title is unknown", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "known", content: "x" }), TR("c1", "note-set"),
    );
    expect(() => note["note-done"]({ notes: ["known", "missing"] }, { agent })).toThrow(/no note "missing"/);
    expect(() => note["note-done"]({ notes: [] }, { agent })).toThrow(/"notes" is required/);
  });

  test("done notes are hidden from note-list (a footer counts them) but stay searchable/gettable", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "open", content: "1" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "finished", content: "2" }), TR("c2", "note-set"),
      TC("c3", "note-done", { notes: ["finished"] }), TR("c3", "note-done"),
    );
    expect(note["note-list"]({}, { agent })).toBe("1 note:\n- open\n(+1 done)");
    expect(note["note-get"]({ title: "finished" }, { agent })).toBe("2");
    expect(note["note-search"]({ pattern: "finished" }, { agent })).toContain("finished");
  });

  test("an all-done store says so in note-list", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "only", content: "x" }), TR("c1", "note-set"),
      TC("c2", "note-done", { notes: ["only"] }), TR("c2", "note-done"),
    );
    expect(note["note-list"]({}, { agent })).toBe("No open notes (+1 done).");
  });
});

describe("note tool: the JSON store — fields, validation and caps", () => {
  test("only the title is required; the note is bounded", () => {
    const agent = agentOf();
    expect(() => note["note-set"]({ content: "x" }, { agent })).toThrow(/"title" is required/);
    expect(() => note["note-set"]({ title: "  " }, { agent })).toThrow(/must not be empty/);
    expect(note["note-set"]({ title: "bare" }, { agent })).toBe("saved to temporary short memory"); // title alone is fine
    expect(() => note["note-set"]({ title: "t".repeat(161) }, { agent })).toThrow(/cap is 160/);
    expect(() => note["note-set"]({ title: "t", content: "x".repeat(4097) }, { agent })).toThrow(/cap is 4096/);
  });

  test("any field rides along (the note is a JSON store)", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "meta", owner: "ada", prio: 3, flags: { hot: true } }), TR("c1", "note-set"),
    );
    expect(note["note-get"]({ title: "meta", only: ["owner", "prio", "flags"] }, { agent }))
      .toBe('# meta\n{"owner":"ada","prio":3,"flags":{"hot":true}}');
    expect(note["note-get"]({ title: "meta", only: ["prio"] }, { agent })).toBe("3"); // non-string: JSON
  });

  test("the type validates against the recommended set (aliases stay accepted)", () => {
    const agent = agentOf();
    expect(() => note["note-set"]({ title: "t", type: "urgent" }, { agent })).toThrow(/must be one of todo, active, done, info, secret/);
    expect(note["note-set"]({ title: "t", type: "active" }, { agent })).toBe("saved to temporary short memory");
    // the aliases keep working (older notes, other vocabularies) and display the same badge
    const recorded = agentOf(TC("c1", "note-set", { title: "t", type: "in-focus" }), TR("c1", "note-set"));
    expect(note["note-list"]({}, { agent: recorded })).toContain("🟠 t");
  });

  test("note-set MERGES a type change: the rest of the note is never touched", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "task", summary: "s", content: "c", type: "todo" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "task", type: "done" }), TR("c2", "note-set"), // the re-type merge
    );
    expect(note["note-get"]({ title: "task", only: ["type", "summary", "content"] }, { agent }))
      .toBe('# task\n{"type":"done","summary":"s","content":"c"}');
  });

  test("note-remove \"*\" deletes EVERY note (an empty store says so, never an error)", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "a", content: "1" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "b", content: "2" }), TR("c2", "note-set"),
      TC("c3", "note-remove", { title: "*" }), TR("c3", "note-remove"),
    );
    expect(note["note-remove"]({ title: "*" }, { agent: agentOf(
      TC("c1", "note-set", { title: "x", content: "1" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "y", content: "2" }), TR("c2", "note-set"),
    ) })).toBe("removed all 2 notes from temporary short memory");
    expect(note["note-list"]({}, { agent })).toBe("No notes."); // the replay cleared the store
    expect(note["note-remove"]({ title: "*" }, { agent: agentOf() })).toBe("no notes to remove");
  });

  test("the store cap: an existing title merges even at the cap; a new one refuses", () => {
    const full = Array.from({ length: 100 }, (_, i) => [
      TC(`s${i}`, "note-set", { title: `n${i}`, content: "x" }), TR(`s${i}`, "note-set"),
    ]).flat();
    const capped = agentOf(...full);
    expect(() => note["note-set"]({ title: "one more", content: "x" }, { agent: capped })).toThrow(/store is full \(100\/100\)/);
    expect(note["note-set"]({ title: "n0", content: "replaced" }, { agent: capped })).toBe("saved to temporary short memory");
  });

  test("confirmations are terse; unknown titles name the known notes", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "only", content: "x" }), TR("c1", "note-set"),
    );
    expect(note["note-remove"]({ title: "only" }, { agent })).toBe("removed from temporary short memory");
    expect(() => note["note-remove"]({ title: "nope" }, { agent })).toThrow(/no note "nope" \(notes: only\)/);
    expect(() => note["note-remove"]({ title: "nope" }, { agent: agentOf() })).toThrow(/no note "nope" — the store is empty/);
    expect(() => note["note-get"]({ title: "nope" }, { agent })).toThrow(/no note "nope" \(notes: only\)/);
  });

  test("note-get: default content, one field raw, several as JSON, all/keys selectors", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "full", type: "todo", summary: "the gist", content: "the whole story" }), TR("c1", "note-set"),
    );
    const ctx = { agent };
    expect(note["note-get"]({ title: "full" }, ctx)).toBe("the whole story"); // default: content
    expect(note["note-get"]({ title: "full", only: [] }, ctx)).toBe("the whole story"); // empty = default
    expect(note["note-get"]({ title: "full", only: ["summary"] }, ctx)).toBe("the gist");
    expect(note["note-get"]({ title: "full", only: ["type", "summary"] }, ctx))
      .toBe('# full\n{"type":"todo","summary":"the gist"}');
    expect(note["note-get"]({ title: "full", only: ["*"] }, ctx))
      .toBe('# full\n{"type":"todo","summary":"the gist","content":"the whole story"}');
    expect(note["note-get"]({ title: "full", keys: true }, ctx)).toBe('["type","summary","content"]');
    // keys + only: the select group's EXISTENCE test (deadline is absent)
    expect(note["note-get"]({ title: "full", keys: true, only: ["summary", "deadline"] }, ctx)).toBe('["summary"]');
    expect(note["note-get"]({ title: "full", only: ["title"] }, ctx)).toBe("full");
    expect(() => note["note-get"]({ title: "full", only: "summary" }, ctx)).toThrow(/array of field names/);
  });

  test("note-list shows the type badges; an empty store says so", () => {
    const agent = agentOf(
      TC("c1", "note-set", { title: "plain" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "task", type: "todo" }), TR("c2", "note-set"),
      TC("c3", "note-set", { title: "hot", type: "in-focus" }), TR("c3", "note-set"),
    );
    const out = note["note-list"]({}, { agent });
    expect(out).toBe("3 notes:\n- plain\n- 🔵 task\n- 🟠 hot");
    expect(note["note-list"]({}, { agent: agentOf() })).toBe("No notes.");
  });

  test("an unrecognized type falls back to the 📂 badge", () => {
    const agent = agentOf(
      { type: "note-store", notes: { typed: { type: "milestone", content: "x" }, plain: { type: "info" } } },
      { type: 2, content: [{ type: "text", text: "anchor" }] },
    );
    expect(note["note-list"]({}, { agent })).toBe("2 notes:\n- 📂 typed\n- 📂 plain");
  });
});

describe("note tool: regex search over the title and every field", () => {
  const agent = agentOf(
    TC("c1", "note-set", { title: "deploy checklist", content: "run migrations first" }), TR("c1", "note-set"),
    TC("c2", "note-set", { title: "db host", content: "primary at 10.0.0.8", summary: "MIGRATION window Sundays", type: "info" }), TR("c2", "note-set"),
  );

  test("a pattern matches any field; the matching notes are NAMED (note-get reads them)", () => {
    const byContent = note["note-search"]({ pattern: "migrations" }, { agent });
    expect(byContent).toContain("- deploy checklist (matched: content)");
    const byTitle = note["note-search"]({ pattern: "^db" }, { agent });
    expect(byTitle).toContain("- db host (matched: title)");
    const bySummary = note["note-search"]({ pattern: "sundays" }, { agent }); // case-insensitive
    expect(bySummary).toContain("- db host (matched: summary)");
    const byType = note["note-search"]({ pattern: "info" }, { agent });
    expect(byType).toContain("- db host (matched: type)");
    const everywhere = note["note-search"]({ pattern: "migration" }, { agent });
    expect(everywhere).toContain("2 match(es)");
  });

  test("field limits the search; invalid regex is an ordinary error", () => {
    const limited = note["note-search"]({ pattern: "migration", field: "summary" }, { agent });
    expect(limited).toContain("1 match(es)");
    expect(limited).toContain("- db host");
    expect(note["note-search"]({ pattern: "zzz" }, { agent })).toBe("No notes match /zzz/.");
    expect(() => note["note-search"]({ pattern: "[" }, { agent })).toThrow(/invalid regular expression/);
    expect(() => note["note-search"]({}, { agent })).toThrow(/"pattern" is required/);
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
    note["note-list"]({}, { agent });
    return agent._toolMessages.get("note") ?? null;
  };

  test("mutations refresh the message; SECRET notes never display", () => {
    const agent = displayAgent(
      TC("c1", "note-set", { title: "ship it", type: "todo" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "api key", type: "secret", content: "sk-..." }), TR("c2", "note-set"),
      TC("c3", "note-set", { title: "plain" }), TR("c3", "note-set"),
    );
    // mutations land as recorded calls (the context IS the store)
    const record = (id, name, args) => agent.context.push(TC(id, name, args), TR(id, name));
    expect(message(agent)).toBe("🔵 **ship it**\n**plain**"); // the secret stays off
    record("c4", "note-remove", { title: "plain" });
    expect(message(agent)).toBe("🔵 **ship it**");
    record("c5", "note-remove", { title: "ship it" });
    expect(message(agent)).toBe(null); // only the secret remains: cleared
  });

  test("a long list is published in full — the tool never truncates its own message", () => {
    const calls = Array.from({ length: 8 }, (_, i) => [
      TC(`s${i}`, "note-set", { title: `note ${i + 1}` }), TR(`s${i}`, "note-set"),
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
      TC("c1", "note-set", { title: "ship it", type: "todo", summary: "cut the release" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "wrapped up", content: "x" }), TR("c2", "note-set"),
      TC("c3", "note-done", { notes: ["wrapped up"] }), TR("c3", "note-done"),
      TC("c4", "note-set", { title: "second open one", type: "active" }), TR("c4", "note-set"),
    );
    // "wrapped up" (done) trails BOTH open notes, even though it was
    // set before the second one — done notes are always LAST
    expect(message(agent)).toBe("🔵 **ship it** — cut the release\n🟠 **second open one**\n✅ **wrapped up**");
  });

  test("SECRET notes never publish even though DONE ones now do", () => {
    const agent = displayAgent(
      TC("c1", "note-set", { title: "ship it", type: "todo" }), TR("c1", "note-set"),
      TC("c2", "note-set", { title: "api key", type: "secret", content: "sk-..." }), TR("c2", "note-set"),
      TC("c3", "note-done", { notes: ["ship it"] }), TR("c3", "note-done"),
    );
    expect(message(agent)).toBe("✅ **ship it**"); // done, but not secret: still shown
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
    await env.loadTools({ dirs: ["./tools"] }); // the real note tools
    const agent = new Agent({
      env, model: "test/test-model", session: "s-note",
      settings: { script }, // the per-invocation script (providers/test.js)
    });
    return { env, agent };
  };

  test("a note saved in one turn is found by note-list in the NEXT turn (derived mid-run)", async () => {
    const { agent } = await testProviderAgent([
      [{ toolCall: { name: "note-set", arguments: { title: "goal", content: "ship the MVP", type: "in-focus" } } }],
      [{ toolCall: { name: "note-list", arguments: {} } }],
      [{ text: "noted" }],
    ]);
    const terminal = await agent.run({});
    expect(terminal.type).toBe("done");
    const results = agent.context.filter((m) => m?.type === 4);
    expect(results).toHaveLength(2);
    expect(results[0].error).toBeUndefined(); // note-set ok
    expect(results[0].content.map((b) => b.text).join("\n")).toBe("saved to temporary short memory");
    // the SECOND turn's list derived the note from the record of the first
    const list = results[1].content.map((b) => b.text).join("\n");
    expect(list).toBe("1 note:\n- 🟠 goal");
    // the sticky display followed (agent-owned)
    expect(agent.toolMessages()).toEqual([{ name: "note", text: "🟠 **goal**" }]);
  });

  test("a rollback that drops the note-set call RESTORES the store (a fresh record joins the context)", async () => {
    const { agent } = await testProviderAgent([
      [{ toolCall: { name: "note-set", arguments: { title: "scratch", content: "temporary" } } }],
      [{ text: "done" }],
    ]);
    agent.enqueue(USER("go")); // the context keeps a message after the rollback (never empty)
    await agent.run({});
    expect(note["note-list"]({}, { agent })).toContain("scratch");
    const at = agent.context.findIndex((m) =>
      (m?.content ?? []).some((b) => b?.type === "toolCall" && b.name === "note-set"));
    expect(at).toBeGreaterThanOrEqual(0);
    agent.rollback(at); // the call and everything after it leave the record
    const out = note["note-list"]({}, { agent });
    expect(out).toContain("scratch"); // restored from the backup, not lost
    expect(agent.context.some((m) => m?.type === "note-store")).toBe(true);
  });

  test("the restore record PERSISTS with the session and re-loads as the baseline", async () => {
    const { env, agent } = await testProviderAgent([
      [{ toolCall: { name: "note-set", arguments: { title: "durable", content: "across resume" } } }],
      [{ text: "done" }],
    ]);
    agent.enqueue(USER("go")); // the context keeps a message after the rollback (never empty)
    await agent.run({});
    expect(note["note-list"]({}, { agent })).toContain("durable"); // populates the backup
    const at = agent.context.findIndex((m) =>
      (m?.content ?? []).some((b) => b?.type === "toolCall" && b.name === "note-set"));
    agent.rollback(at); // lose the call; the restore record joins the context
    note["note-list"]({}, { agent });
    agent._flush(); // persist: the file now carries the note-store record
    const fileText = await Bun.file(agent.session.file).text();
    expect(fileText).toContain('"type":"note-store"');
    expect(fileText).toContain("durable");
    // resume: the record rides back in as the baseline (a FRESH agent —
    // no tool-storage backup, so the record is the only possible source)
    const { Agent: AgentClass } = await import("../lib/agent.js");
    const resumed = new AgentClass({ env, model: "test/test-model", session: agent.session.id });
    expect(note["note-list"]({}, { agent: resumed })).toContain("durable");
  });

  test("the note tools publish as SAFE read-only host tools", async () => {
    const env = await testEnv();
    await env.loadTools({ dirs: ["./tools"] });
    for (const name of [
      "note-set", "note-done", "note-remove", "note-get", "note-list", "note-search",
    ]) {
      const entry = env.toolEntry(name);
      expect(entry).toBeDefined();
      expect(entry.safe).toBe(true); // available in safe mode and in-process
    }
  });
});
