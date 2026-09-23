// test/agent-session-edit.test.js — proof for session edit semantics:
// edit/rollback/pop go through Context (stale provider/cache
// identifiers dropped) and flush REWRITES the session file with the
// current context — no tombstones, no change log; resume loads the
// rewritten file directly.
import { describe, expect, test, afterEach } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { SessionStore } from "../lib/agent.js";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv, USER, TEXT } from "./fakes.js";

const ROOT = `./ai-tmp/session-edit-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

const lines = (file) => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
  .filter((record) => record?.type !== "session-metadata"); // the first, origin line

function sessionWithHistory(id = "edit") {
  const store = new SessionStore({ id, dir: ROOT });
  store.append(USER("q1"));
  store.append({ type: 3, content: [{ type: "text", text: "a1" }], providerId: "resp-1" });
  store.append(USER("q2"));
  store.append({ type: 3, content: [{ type: "text", text: "a2" }] });
  store.flush();
  return store;
}

describe("session edit/rollback/pop (rewrite-on-flush)", () => {
  test("edit rebuilds the message (stale ids dropped); the file shows the rewrite", () => {
    const store = sessionWithHistory();
    const edited = store.edit(1, {
      type: 3,
      content: [{ type: "text", text: "a1-edited" }],
      providerId: "STALE", // dropped by Context cleanup
      cacheId: "STALE",
    });
    store.flush();

    expect(edited.providerId).toBeUndefined();
    expect(lines(store.file)[1]).toEqual({ type: 3, content: [{ type: "text", text: "a1-edited" }] });

    const resumed = SessionStore.resume({ id: "edit", dir: ROOT });
    expect(resumed.context[1]).toEqual({ type: 3, content: [{ type: "text", text: "a1-edited" }] });
    expect(resumed.context).toHaveLength(4);
  });

  test("editBlock rewrites the containing message", () => {
    const store = sessionWithHistory();
    store.editBlock(1, 0, { type: "text", text: "block-edited" });
    store.flush();
    const record = lines(store.file)[1];
    expect(record.content[0]).toEqual({ type: "text", text: "block-edited" });
    expect(record.providerId).toBeUndefined(); // stale message-level ids dropped
  });

  test("rollback truncates the file itself; resume loads the truncation", () => {
    const store = sessionWithHistory();
    const removed = store.rollback(2);
    store.flush();
    expect(removed).toHaveLength(2);
    expect(lines(store.file)).toEqual([
      USER("q1"),
      { type: 3, content: [{ type: "text", text: "a1" }], providerId: "resp-1" },
    ]);

    const resumed = SessionStore.resume({ id: "edit", dir: ROOT });
    expect(resumed.context).toEqual([
      USER("q1"),
      { type: 3, content: [{ type: "text", text: "a1" }], providerId: "resp-1" },
    ]);
  });

  test("pop drops the tail from the file", () => {
    const store = sessionWithHistory();
    store.pop();
    store.flush();
    expect(lines(store.file)).toHaveLength(3);

    const resumed = SessionStore.resume({ id: "edit", dir: ROOT });
    expect(resumed.context).toHaveLength(3);
    expect(resumed.context.at(-1)).toEqual(USER("q2"));
  });

  test("a mixed sequence persists exactly the live context", () => {
    const store = sessionWithHistory();
    store.edit(0, USER("q1-edited"));
    store.pop();
    store.append(USER("q3"));
    store.rollback(2);
    store.flush();

    const resumed = SessionStore.resume({ id: "edit", dir: ROOT });
    expect(resumed.context).toEqual(store.context);
    expect(resumed.context).toEqual([USER("q1-edited"), { type: 3, content: [{ type: "text", text: "a1" }], providerId: "resp-1" }]);
    expect(lines(store.file)).toEqual(resumed.context); // file == live context
  });

  test("Agent delegates edits to its session (file rewritten), in-memory only without one", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]);
    const agent = new Agent({
      env, model: "p/m", session: "agent-edit", sessionDir: ROOT,
      context: [USER("hi")], createIO: () => io,
    });
    await agent.run();
    agent.edit(0, USER("hi-edited"));
    agent.session.flush();
    const records = lines(agent.session.file);
    expect(records[0]).toEqual(USER("hi-edited"));
    expect(records.every((m) => m.op === undefined)).toBe(true); // no change log
    expect(agent.context[0]).toEqual(USER("hi-edited"));

    const plain = new Agent({ env, model: "p/m", context: [USER("x")] });
    plain.edit(0, USER("x-edited"));
    expect(plain.context[0]).toEqual(USER("x-edited")); // no crash, no file
  });
});
