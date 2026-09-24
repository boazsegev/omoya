// test/agent-trim.test.js — proof for user-message whitespace
// normalization: the Agent trims the latest user message (trailing
// EOLs, tabs, every white space) before a provider request; a
// whitespace-only submission is no turn at all — it behaves exactly
// like /continue (no user message enters the context, the existing
// context runs). lib/agent/trim-user.js owns the transformation;
// enqueue() and the run loop (lib/agent/run.js) own the two call
// sites.
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv, USER, TEXT } from "./fakes.js";

describe("Agent user-message trimming", () => {
  test("a user submission is trimmed of surrounding whitespace before it runs", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    agent.enqueue(USER("  hello agent \t\r\n"));
    await agent.run();
    expect(io.writes[0].context).toEqual([USER("hello agent")]);
    expect(agent.context).toEqual([
      USER("hello agent"),
      { type: 3, content: [{ type: "text", text: "answer" }] },
    ]);
  });

  test("a whitespace-only submission is a /continue: no user message, the context runs", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "continued"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("prior")], createIO: () => io });
    const result = agent.enqueue(USER(" \t\n\r\n "));
    expect(result).toBeNull(); // nothing was queued
    await agent.run();
    // exactly ONE request over the existing context — no empty user turn
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0].context).toEqual([USER("prior")]);
    expect(agent.context).toEqual([
      USER("prior"),
      { type: 3, content: [{ type: "text", text: "continued" }] },
    ]);
  });

  test("a whitespace-only message appended directly (append/resume path) is swept before the request", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("prior")], createIO: () => io });
    agent.append(USER("\n\t  \n")); // bypasses enqueue()'s trim
    await agent.run();
    expect(io.writes[0].context).toEqual([USER("prior")]);
    expect(agent.context.some((m) => m.type === 2 && m.content.length === 0)).toBe(false);
  });

  test("the sweep removes every empty MESSAGE but never a metadata record", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]);
    const agent = new Agent({
      env, model: "p/m",
      context: [
        { type: 3, content: [] }, // an edit hollowed it out: dead weight, sweeps
        { type: 0, content: [] }, // an empty system message sweeps too
        { type: "note-store", notes: { a: { content: "x" } } }, // a metadata record: never the sweep's business
        USER("prior"),
      ],
      createIO: () => io,
    });
    await agent.run();
    expect(agent.context.some((m) => typeof m.type === "number" && m.content.length === 0)).toBe(false);
    expect(agent.context.some((m) => m.type === "note-store")).toBe(true); // the record stayed put
  });

  test("trailing whitespace-only text blocks drop out; attachment blocks keep the message", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]);
    const attached = {
      type: 2,
      content: [
        { type: "text", text: "   \n" },
        { type: "binary", mimetype: "application/octet-stream", data: "AAAA" },
      ],
    };
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    agent.enqueue(attached);
    await agent.run();
    // the whitespace text block dropped out; the attachment survives
    expect(io.writes[0].context).toEqual([{
      type: 2,
      content: [{ type: "binary", mimetype: "application/octet-stream", data: "AAAA" }],
    }]);
  });

  test("a message queued mid-turn is trimmed before it flushes", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TEXT(0, "first"), { type: "done" }],
      [...TEXT(0, "second"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const run = agent.run();
    agent.enqueue(USER("  queued \n"));
    await run;
    expect(io.writes[1].context).toEqual([
      USER("go"),
      { type: 3, content: [{ type: "text", text: "first" }] },
      USER("queued"),
    ]);
  });
});
