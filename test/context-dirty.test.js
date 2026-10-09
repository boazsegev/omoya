// test/context-dirty.test.js — Context.dirty: chain-hash change detection
// that survives appends while stale replay data remains.
import { describe, expect, test } from "bun:test";
import Context from "../lib/context.js";

const user = (text) => ({ type: 2, content: [{ type: "text", text }] });
const reply = (text, signature) => ({ type: 3, content: [
  ...(signature ? [{ type: "thinking", text: "plan", signature }] : []),
  { type: "text", text },
] });
const strip = (message) => ({ ...message, content: message.content.map(({ type, text }) => ({ type, text })) });

describe("Context.dirty", () => {
  test("appends and trailing removals are not changes; seeds are trusted", () => {
    const context = new Context({ messages: [user("a"), reply("b", "S1")] });
    expect(context.dirty).toBe(false);
    context.append(user("c"));
    context.append(reply("d", "S2"));
    expect(context.dirty).toBe(false);
    context.pop();
    context.rollback(2);
    expect(context.dirty).toBe(false);
    context.append(user("c2")); // new entries at previously used indexes
    context.append(reply("again", "S3"));
    expect(context.dirty).toBe(false);
  });

  test("message-level provider replay metadata stays dirty across appends", () => {
    const context = new Context({ messages: [user("a"), { type: 3, content: [{ type: "text", text: "b" }], gemini: { interactionId: "id" } }] });
    context.edit(0, user("changed"));
    context.append(user("c"));
    expect(context.dirty).toBe(1);
    context.update((messages) => { delete messages[1].gemini; return true; });
    context.append(user("d"));
    expect(context.dirty).toBe(false);
  });
  test("a merge into a message with replay data marks it dirty (conservative)", () => {
    const context = new Context({ messages: [user("a"), reply("b", "S1")] });
    context.append(reply("continued", "S2"));
    expect(context.length).toBe(2);
    expect(context.dirty).toBe(1);
  });

  test("an edit marks its index; the next append accepts messages without replay data", () => {
    const context = new Context({ messages: [user("a"), reply("b"), user("c")] });
    context.edit(0, user("A"));
    expect(context.dirty).toBe(0);
    context.append(reply("d"));
    expect(context.dirty).toBe(false);
  });

  test("stale replay data stays dirty across appends until it is removed", () => {
    const context = new Context({ messages: [user("a"), reply("b", "S1"), user("c"), reply("d", "S2")] });
    context.edit(0, user("edited history"));
    expect(context.dirty).toBe(0);
    context.append(user("next prompt")); // the edit must survive this append
    expect(context.dirty).toBe(1);
    // the provider responds: replay data from the dirty index on goes
    context.update((messages) => {
      for (let i = context.dirty; i < messages.length; i++) messages[i] = strip(messages[i]);
      return true;
    });
    context.append(reply("fresh", "S3"));
    expect(context.dirty).toBe(false);
    expect(context.at(-1).content[0].signature).toBe("S3");
  });

  test("insertions, removals and live mutations are detected at their index", () => {
    const context = new Context({ messages: [user("a"), reply("b", "S1"), user("c"), reply("d", "S2")] });
    context.remove([2]);
    expect(context.dirty).toBe(2);
    const other = new Context({ messages: [user("a"), reply("b", "S1"), user("c")] });
    other.prepend([{ type: "io-root", model: "x/y" }]);
    expect(other.dirty).toBe(0);
    const live = new Context({ messages: [user("a"), reply("b", "S1")] });
    live.at(0).content[0].text = "mutated in place";
    expect(live.dirty).toBe(0);
  });

  test("a changed record at the head makes the whole context dirty", () => {
    const context = new Context({ messages: [{ type: "io-root", model: "a/m" }, user("q"), reply("r", "S1")] });
    context.update((messages) => { messages[0] = { type: "io-root", model: "b/m" }; return true; });
    context.append(user("next"));
    expect(context.dirty).toBe(2); // the record itself is accepted; the signed reply is not
  });
});
