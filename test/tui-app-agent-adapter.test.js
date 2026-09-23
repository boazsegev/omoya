// test/tui-app-agent-adapter.test.js — proof for the app skeleton's
// agent adapter (Phase 03 step 1): turns as `task` streams, a message
// queued while a turn is already running never starts a second task,
// interrupt is a fire-and-forget agent.cancel() that flows back
// through the SAME turn's own event stream, and the question bridge
// turns an interactive tool's pending Promise into a dispatched
// message — resolved by an effect, abandoned (never left hanging) on
// teardown.
import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { Agent } from "../lib/agent.js";
import { createAgentAdapter } from "../lib/tui-app/agent-adapter.js";
import { createApp, msg } from "../lib/tui-app/app.js";
import { QUESTION_MENU_ID } from "../lib/tui-app/questionnaire-view.js";
import { NAMES } from "../lib/namespace.js";
import { fakeIO, scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

const tick = () => new Promise((resolve) => queueMicrotask(resolve));
async function until(fn, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await Bun.sleep(10);
  }
  return fn();
}

/** A fake IO that blocks until release(), then answers with `events`. */
function pausableIO() {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const io = fakeIO(async (_io, callbacks) => {
    await held;
    const { emitScript } = await import("./fakes.js");
    return emitScript([{ type: "start" }, ...TEXT(0, "answer"), { type: "done" }], callbacks);
  });
  return { io, release: () => release() };
}

/** A fake IO that streams a partial then blocks until kill() — mirrors
 *  test/agent-cancel.test.js's hangingIO. */
function hangingIO(partialText) {
  return fakeIO(async (io, callbacks) => {
    callbacks.onTextStart?.({ contentIndex: 0 });
    callbacks.onTextDelta?.({ contentIndex: 0, text: partialText });
    return new Promise((resolve) => {
      io._onKill = () => resolve({ type: "error", error: "cancelled", kind: "cancelled", cancelled: true });
    });
  });
}

const Q1 = { question: "Pick one?", header: "Choice", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] };

describe("agent adapter: turns as task streams", () => {
  test("submit runs a turn: the view goes running -> idle, and the exchange lands in the agent's context", async () => {
    const env = await testEnv();
    const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "hi there"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent);
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("hi"));
    await tick();
    expect(agent.busy).toBe(true); // the status bar's own rendering is test/tui-app-transcript.test.js's concern

    await until(() => !agent.busy);
    expect(agent.context.map((m) => m.type)).toEqual([2, 3]);
    expect(agent.pending).toEqual([]);

    ui.stop();
    await running;
  });

  test("a message submitted mid-turn is queued, not a second task — the running loop drains it on its own", async () => {
    const env = await testEnv();
    const { io, release } = pausableIO();
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    let cancelCalls = 0;
    const realCancel = agent.cancel.bind(agent);
    agent.cancel = (...args) => { cancelCalls++; return realCancel(...args); };
    const app = createApp(agent);
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("first"));
    await tick();
    expect(agent.busy).toBe(true); // the first request is in flight
    await new Promise((resolve) => setImmediate(resolve));
    expect(memory.snapshot().roles.some((span) => span.role === "input.border.active.top")).toBe(true);
    expect(memory.snapshot().roles.some((span) => span.role === "input.border.active.bottom")).toBe(true);

    ui.dispatch(msg.submit("second")); // arrives WHILE the turn is running
    await tick();
    expect(agent.busy).toBe(true); // no new task, still the same turn

    release(); // the in-flight request settles; the queued message flushes in the SAME loop
    await until(() => !agent.busy);

    expect(cancelCalls).toBe(0); // never treated as an interrupt/second task
    expect(agent.pending).toEqual([]);
    expect(io.writes).toHaveLength(2); // one turn, two requests — the SAME loop drained the queued one
    const userTurns = agent.context.filter((m) => m.type === 2);
    expect(userTurns.map((m) => m.content[0].text)).toEqual(["first", "second"]);

    ui.stop();
    await running;
  });

  test("a thrown turn clears its active claim so a later submit starts", async () => {
    const env = await testEnv();
    let calls = 0;
    const io = fakeIO(async (_io, callbacks) => {
      calls++;
      if (calls === 1) throw new Error("provider exploded");
      return (await import("./fakes.js")).emitScript([{ type: "start" }, ...TEXT(0, "recovered"), { type: "done" }], callbacks);
    });
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const host = GTUI.host.memory();
    const ui = new GTUI({ host });
    const running = ui.run(createApp(agent));
    try {
      ui.dispatch(msg.submit("fails"));
      await until(() => host.snapshot().lines.join("\n").includes("turn failed: provider exploded"));
      ui.dispatch(msg.submit("works"));
      await until(() => !agent.busy && calls === 2);
      expect(host.snapshot().lines.join("\n")).toContain("recovered");
    } finally { ui.stop(); await running; }
  });

  test("Escape from the focused draft cancels a running turn", async () => {
    const env = await testEnv();
    const io = hangingIO("partial");
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(createApp(agent));
    ui.dispatch(msg.submit("go"));
    await until(() => agent.busy);
    memory.send(GTUI.event.key({ key: "escape" }));
    await until(() => !agent.busy);
    expect(io.kills).toBe(1);
    ui.stop();
    await running;
  });

  test("interrupt is a fire-and-forget agent.cancel() — the SAME turn's event stream reports the cancellation", async () => {
    const env = await testEnv();
    const io = hangingIO("partial");
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent);
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("go"));
    await until(() => agent.busy);
    ui.dispatch(msg.interrupt());
    await until(() => !agent.busy);

    expect(io.kills).toBe(1);
    ui.stop();
    await running;
  });
});

describe("agent adapter: real-agent tool hook bridge", () => {
  test("captures the real agent, preserves other subscribers, and unregisters after the task", async () => {
    const seen = [];
    const listeners = Array.from({ length: Object.keys(Agent.EVENT).length }, () => []);
    let nextHandle = 0;
    const real = {
      pending: [], setQuestion() {}, cancel() {},
      onEvent(event, callback) { const handle = ++nextHandle; listeners[event].push([callback, handle]); return handle; },
      offEvent(handle) { for (const entries of listeners) { const index = entries.findIndex((entry) => entry[1] === handle); if (index >= 0) { entries.splice(index, 1); return true; } } return false; },
      emit(event, value) { for (const [callback] of listeners[event]) callback(value); },
      async run() {
        this.emit(Agent.EVENT.TOOL_EXECUTE, { callId: "c" });
        const result = { callId: "c", content: [] };
        this.emit(Agent.EVENT.TOOL_RESULT, { result, display: [] });
        this.emit(Agent.EVENT.DONE, { type: "done" });
        return { type: "done" };
      },
    };
    real.onEvent(Agent.EVENT.TOOL_EXECUTE, (call) => seen.push(["prior-execute", call.callId]));
    real.onEvent(Agent.EVENT.TOOL_RESULT, ({ result }) => seen.push(["prior-result", result.callId]));
    const proxy = { pending: [], setQuestion() {}, cancel() {}, [Symbol.for(NAMES.realAgentSymbol)]: real };
    const adapter = createAgentAdapter(proxy);
    const sent = [];
    await adapter.turnEffect().run({ send: (message) => sent.push(message), signal: new AbortController().signal });
    expect(seen).toEqual([["prior-execute", "c"], ["prior-result", "c"]]);
    expect(listeners[Agent.EVENT.TOOL_EXECUTE]).toHaveLength(1);
    expect(listeners[Agent.EVENT.TOOL_RESULT]).toHaveLength(1);
    expect(sent.filter((message) => message.type === "agent.tool.event").map((message) => message.origin)).toEqual([real, real]);
  });
});

describe("agent adapter: the question bridge", () => {
  test("a question toolcall opens a message; answering resolves it and the answer lands in the agent's context", async () => {
    const env = await testEnv();
    await env.loadTools({ dirs: ["./tools"] });
    const io = scriptedIO([
      [{ type: "start" }, ...TOOLCALL(0, "c1", "question", { questions: [Q1] }), { type: "done" }],
      [{ type: "start" }, ...TEXT(0, "answered"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent);
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("go"));
    await until(() => memory.snapshot().lines.includes("Pick one?"));

    ui.dispatch({ type: "menu.select", id: QUESTION_MENU_ID, item: { value: "B" } });
    await tick();
    expect(agent.context.find((m) => m.type === 4)).toBeUndefined();
    ui.dispatch({ type: "menu.submit", id: QUESTION_MENU_ID, item: { value: "B" } });
    await until(() => !agent.busy);

    const result = agent.context.find((m) => m.type === 4);
    expect(result.content[0].text).toBe("Q: Pick one?\nA: B");

    ui.stop();
    await running;
  });

  test("a test/ui-shaped worker permission question resumes with its canonical model selector", async () => {
    const env = await testEnv();
    await env.loadTools({ dirs: ["./tools"] });
    const io = scriptedIO([
      [{ type: "start" }, ...TOOLCALL(0, "c1", "worker", { name: "ui-response-demo", description: "UI response demonstrator", model: "p/ui-response", prompt: "Reply with the child-worker UI demonstration." }), { type: "done" }],
      [{ type: "start" }, ...TEXT(0, "worker started"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent);
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("delegate this"));
    await until(() => memory.snapshot().lines.includes("Allow this Agent to create and control child workers?"));
    ui.dispatch({ type: "menu.select", id: QUESTION_MENU_ID, item: { value: "Allow" } });
    ui.dispatch({ type: "menu.submit", id: QUESTION_MENU_ID, item: { value: "Allow" } });
    await until(() => !agent.busy);

    expect(agent.context.find((message) => message.type === 4 && message.name === "worker").content[0].text).toBe("{}");
    expect(agent.children).toHaveLength(1);
    expect(agent.children[0]).toMatchObject({ name: "ui-response-demo", endpoint: "p", model: "ui-response" });
    ui.stop();
    await running;
  });

  test("a worker permission question resumes the tool call with the selected answer", async () => {
    const env = await testEnv();
    await env.loadTools({ dirs: ["./tools"] });
    const io = scriptedIO([
      [{ type: "start" }, ...TOOLCALL(0, "c1", "worker", { name: "reviewer", prompt: "You are a reviewer. Inspect the task and report findings." }), { type: "done" }],
      [{ type: "start" }, ...TEXT(0, "worker started"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent);
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("delegate this"));
    await until(() => memory.snapshot().lines.includes("Allow this Agent to create and control child workers?"));
    ui.dispatch({ type: "menu.select", id: QUESTION_MENU_ID, item: { value: "Allow" } });
    ui.dispatch({ type: "menu.submit", id: QUESTION_MENU_ID, item: { value: "Allow" } });
    await until(() => !agent.busy);

    expect(agent.context.find((message) => message.type === 4 && message.name === "worker").content[0].text).toBe("{}");
    expect(agent.children).toHaveLength(1);
    expect(agent.children[0]).toMatchObject({ name: "reviewer", endpoint: "p", model: "m" });
    ui.stop();
    await running;
  });

  test("a timed-out worker permission question closes and a late answer cannot spawn a worker", async () => {
    const env = await testEnv();
    await env.loadTools({ dirs: ["./tools"] });
    const io = scriptedIO([
      [{ type: "start" }, ...TOOLCALL(0, "c1", "worker", { name: "timed-out-reviewer", prompt: "You are a reviewer. Inspect the task and report findings." }), { type: "done" }],
      [{ type: "start" }, ...TEXT(0, "continued without a worker"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent);
    const memory = GTUI.host.memory();
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("delegate this"));
    await until(() => memory.snapshot().lines.includes("Allow this Agent to create and control child workers?"));
    agent._question.timeout(); // mirrors Agent's tool timeout boundary
    await until(() => !agent.busy);

    expect(memory.snapshot().lines).not.toContain("Allow this Agent to create and control child workers?");
    ui.dispatch({ type: "menu.select", id: QUESTION_MENU_ID, item: { value: "Allow" } });
    ui.dispatch({ type: "menu.submit", id: QUESTION_MENU_ID, item: { value: "Allow" } });
    expect(agent.children).toHaveLength(0);

    ui.stop();
    await running;
  });

  test("abandonPending resolves every open question with null — a clean exit never hangs a tool call", async () => {
    let capturedBridge;
    const fakeAgent = {
      pending: [], enqueue() {}, cancel() {}, run: () => new Promise(() => {}),
      setQuestion(bridge) { capturedBridge = bridge; },
      _toolContext: () => ({ resetTimeout() {} }),
    };
    const adapter = createAgentAdapter(fakeAgent);
    const sent = [];
    adapter.turnEffect().run({ send: (m) => sent.push(m), signal: new AbortController().signal });

    const answered = capturedBridge.ask([Q1]);
    const opened = sent.filter((message) => message.type === "agent.question.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ type: "agent.question.opened", questions: [Q1] });

    adapter.abandonPending();
    await expect(answered).resolves.toBeNull();
  });
});
