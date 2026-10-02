// test/context-error.test.js — a FAILED response is its message carrying
// `error`. Regression for agents that "paused" after tool calls: an empty
// reply, or an OpenAI response cut short (`response.incomplete`, ignored so
// the stream just ended), finished the turn as a silent success
// (2026-09-28, session 56262a65 — four web-fetch results, then nothing).
//   Context: a failed response is kept (its error is its payload); a
//            trailing one is retracted on the next submission (errorPop).
//   IO:      every non-cancelled error terminal carries its message with
//            `error`; a `done` that answers nothing is such a failure.
//   Agent:   persists failed responses, retracts an unanswered one before
//            re-submitting; a user reply keeps it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Context } from "../lib/context.js";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";
import { Agent } from "../lib/agent.js";
import { msg2events } from "../lib/io/openai.js";
import { scriptedIO, testEnv, USER, TEXT } from "./fakes.js";
import { providerAdd } from "./env-internals.js";

const ASSISTANT = (text) => ({ type: 3, content: [{ type: "text", text }] });
const FAILED = (error, content = []) => ({ type: 3, content, error });

describe("Context: a failed response is a message carrying `error`", () => {
  test("a contentless failed response is kept; a contentless plain message is still refused", () => {
    const context = new Context({ messages: [USER("go")] });
    context.append(FAILED("socket hang up"));
    expect(context.messages()).toEqual([USER("go"), FAILED("socket hang up")]);
    expect(() => context.append({ type: 3, content: [] })).toThrow(/empty message/);
  });

  test("a failed response never merges into the plain reply before it", () => {
    const context = new Context({ messages: [USER("go"), ASSISTANT("part one")] });
    context.append(FAILED("cut", [{ type: "text", text: "part two" }]));
    expect(context.length).toBe(3);
  });

  test("errorPop retracts only a trailing failed response", () => {
    const failed = FAILED("boom", [{ type: "text", text: "partial" }]);
    const context = new Context({ messages: [USER("go"), ASSISTANT("ok"), USER("more"), failed] });
    expect(context.errorPop()).toEqual(failed);
    expect(context.messages()).toEqual([USER("go"), ASSISTANT("ok"), USER("more")]);
    expect(context.errorPop()).toBeUndefined(); // nothing else is ever taken
  });

  test("errorPop keeps a failed response the user replied to, and a tool's own error", () => {
    const replied = new Context({ messages: [USER("go"), FAILED("boom"), USER("why?")] });
    expect(replied.errorPop()).toBeUndefined();
    expect(replied.length).toBe(3);
    const toolError = { type: 4, callId: "c1", name: "t", error: true, content: [{ type: "text", text: "tool failed" }] };
    const tool = new Context({ messages: [USER("go"), toolError] });
    expect(tool.errorPop()).toBeUndefined();
  });
});

describe("IO: every failed response carries its message with `error`", () => {
  let dir, env;
  beforeEach(() => {
    dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-error-")));
    env = new Env({ dir, cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function scripted(frames, sent = []) {
    providerAdd(env, "fake", class {
      constructor() { this.queue = frames.map((events) => ({ events })); }
      context2msg(context) { sent.push(context); return [{}, {}]; }
      msg2events(native) { return native.events; }
      async send() {}
      async read() { return this.queue.shift() ?? null; }
      async close() {}
    });
    env._endpoints.fake = { provider: "fake", url: "http://fake" };
    return new IO({ env, model: "fake/m" });
  }
  const write = (io, context = [USER("go")]) => io.write(context);

  test("a done that answers nothing is a failed response naming the stop reason", async () => {
    const terminal = await write(scripted([[{ type: "done", doneReason: "completed" }]]));
    expect(terminal).toMatchObject({ type: "error", kind: "provider", error: "the provider returned an empty response (completed)" });
    expect(terminal.message).toEqual({ type: 3, content: [], error: terminal.error });
  });

  test("reasoning alone answers nothing; the reasoning stays on the failed message", async () => {
    const terminal = await write(scripted([[
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, text: "hmm" },
      { type: "done" },
    ]]));
    expect(terminal.type).toBe("error");
    expect(terminal.message.content[0]).toMatchObject({ type: "thinking", text: "hmm" });
    expect(terminal.message.error).toBe("the provider returned an empty response");
  });

  test("an answer is a plain done", async () => {
    const terminal = await write(scripted([[...TEXT(0, "hi"), { type: "done" }]]));
    expect(terminal.type).toBe("done");
    expect(terminal.message.error).toBeUndefined();
  });

  test("a provider error keeps what arrived before it, marked with the error", async () => {
    const terminal = await write(scripted([[...TEXT(0, "half"), { type: "error", error: "stream reset" }]]));
    expect(terminal.message).toEqual({ type: 3, content: [{ type: "text", text: "half" }], error: "stream reset" });
  });

  test("a contentless failed response the user replied to never reaches the provider", async () => {
    const sent = [];
    await write(scripted([[...TEXT(0, "ok"), { type: "done" }]], sent), [USER("go"), FAILED("boom"), USER("again")]);
    expect(sent[0]).toEqual([USER("go"), USER("again")]);
  });
});

describe("OpenAI Responses: the provider names how a response ended", () => {
  const io = { set contextUsage(value) {} };
  test("response.completed carries its status as doneReason", () => {
    const [event] = msg2events({ type: "response.completed", response: { id: "r1", status: "completed" } }, {}, io);
    expect(event).toMatchObject({ type: "done", doneReason: "completed" });
  });
  test("response.incomplete is an error naming the reason", () => {
    const [event] = msg2events({
      type: "response.incomplete",
      response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    }, {}, io);
    expect(event).toMatchObject({ type: "error", error: "OpenAI response incomplete (max_output_tokens)" });
  });
});

describe("Agent: failed responses persist until retracted or answered", () => {
  // scriptedIO stands in for IO: its terminals carry the normalized message
  const failure = (error, content = []) => ({ type: "error", error, kind: "network", message: FAILED(error, content) });

  async function agentWith(script, context = [USER("go")]) {
    const env = await testEnv({ retry: { attempts: 1 } });
    const io = scriptedIO(script);
    return { io, agent: new Agent({ env, model: "p/m", context, createIO: () => io }) };
  }

  test("a failed response is stored — content and error — and ends the turn", async () => {
    const { agent } = await agentWith([[failure("socket hang up", [{ type: "text", text: "half" }])]]);
    expect((await agent.run()).type).toBe("error");
    expect(agent.context.messages()).toEqual([USER("go"), FAILED("socket hang up", [{ type: "text", text: "half" }])]);
  });

  test("continuing without a reply retracts it and re-attempts the request", async () => {
    const { agent, io } = await agentWith([[failure("socket hang up")], [...TEXT(0, "answer"), { type: "done" }]]);
    await agent.run();
    expect(await agent.run()).toMatchObject({ type: "done" }); // /continue
    expect(io.writes[1].context).toEqual([USER("go")]); // the failure never went out
    expect(agent.context.messages()).toEqual([USER("go"), ASSISTANT("answer")]);
  });

  test("a user reply keeps the failed response in the conversation", async () => {
    const { agent } = await agentWith([[failure("socket hang up")], [...TEXT(0, "answer"), { type: "done" }]]);
    await agent.run();
    agent.send(USER("what happened?"));
    while (agent.busy) await Bun.sleep(1);
    expect(agent.context.messages()).toEqual([USER("go"), FAILED("socket hang up"), USER("what happened?"), ASSISTANT("answer")]);
  });
});
