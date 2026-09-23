import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import Agent from "../lib/agent.js";
import { createApp, msg } from "../lib/tui-app/app.js";
import { fakeIO, testEnv, emitScript, TOOLCALL } from "./fakes.js";

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); }

test("tool result and display become visible before the next provider request completes", async () => {
  const env = await testEnv();
  env.registerTool("preview", () => ({ result: "RESULT VISIBLE", display: "DISPLAY VISIBLE" }), { description: "fixture", inputSchema: { type: "object" }, sandbox: false });
  const secondStarted = deferred();
  const release = deferred();
  let request = 0;
  const io = fakeIO(async (_, callbacks) => {
    if (request++ === 0) return emitScript([{ type: "start" }, ...TOOLCALL(0, "call", "preview", {}), { type: "done" }], callbacks);
    // No next start event is necessary to discover a completed tool result.
    secondStarted.resolve();
    await release.promise;
    return emitScript([{ type: "start" }, { type: "done" }], callbacks);
  });
  const agent = new Agent({ env, model: "p/m", context: [], tools: ["preview"], toolCall: { fork: false }, createIO: () => io });
  const host = GTUI.host.memory({ width: 80, height: 24 });
  const ui = new GTUI({ host });
  const run = ui.run(createApp(agent, { env, sources: {} }));
  try {
    ui.dispatch(msg.submit("go"));
    await secondStarted.promise;
    await settle();
    expect(host.snapshot().lines.join("\n")).toContain("RESULT VISIBLE");
    expect(host.snapshot().lines.join("\n")).toContain("DISPLAY VISIBLE");
  } finally { release.resolve(); await settle(); ui.stop(); await run; }
});

test("structured display content is rendered as text rather than object coercion", async () => {
  const env = await testEnv();
  const agent = new Agent({ env, model: "p/m", context: [{ type: 4, callId: "call", name: "preview", content: [{ type: "text", text: "ok" }], display: [{ type: "text", text: "DISPLAY CONTENT" }] }] });
  const host = GTUI.host.memory({ width: 80, height: 24 });
  const ui = new GTUI({ host });
  const run = ui.run(createApp(agent, { env, sources: {} }));
  try { expect(host.snapshot().lines.join("\n")).toContain("DISPLAY CONTENT"); }
  finally { ui.stop(); await run; }
});

test("tool result callback observes the appended result and display in Agent context", async () => {
  const env = await testEnv();
  env.registerTool("preview", () => ({ result: "done", display: "shown" }), { description: "fixture", inputSchema: { type: "object" }, sandbox: false });
  let round = 0;
  const io = fakeIO(async (_, callbacks) => emitScript(round++ === 0 ? [{ type: "start" }, ...TOOLCALL(0, "call", "preview", {}), { type: "done" }] : [{ type: "done" }], callbacks));
  let appendedAtNotification = false;
  const agent = new Agent({ env, model: "p/m", context: [], toolCall: { fork: false }, createIO: () => io });
  agent.onEvent(Agent.EVENT.TOOL_RESULT, ({ result }) => { appendedAtNotification = agent.context.includes(result); });
  await agent.run();
  expect(appendedAtNotification).toBe(true);
});

test("bash-style live output renders in the transcript with tool-result styling", async () => {
  const env = await testEnv();
  const streamed = deferred();
  const release = deferred();
  env.registerTool("streamer", async (_args, context) => {
    context.onData("LIVE BASH OUTPUT");
    streamed.resolve();
    await release.promise;
    return "final output";
  }, { description: "fixture", inputSchema: { type: "object" }, sandbox: false });
  let round = 0;
  const io = fakeIO(async (_, callbacks) => emitScript(round++ === 0
    ? [{ type: "start" }, ...TOOLCALL(0, "call", "streamer", {}), { type: "done" }]
    : [{ type: "done" }], callbacks));
  const agent = new Agent({ env, model: "p/m", context: [], tools: ["streamer"], toolCall: { fork: false }, createIO: () => io });
  const host = GTUI.host.memory({ width: 80, height: 24 });
  const ui = new GTUI({ host });
  const run = ui.run(createApp(agent, { env, sources: {} }));
  try {
    ui.dispatch(msg.submit("go")); await streamed.promise; await settle();
    const snapshot = host.snapshot();
    expect(snapshot.lines.join("\n")).toContain("LIVE BASH OUTPUT");
    expect(snapshot.lines.join("\n").indexOf("LIVE BASH OUTPUT")).toBeGreaterThan(snapshot.lines.join("\n").indexOf("streamer"));
    expect(snapshot.lines.join("\n")).toContain("[tool ok] streamer");
    expect(snapshot.roles.map((span) => span.role)).toContain("tool.result");
  } finally { release.resolve(); await settle(); ui.stop(); await run; }
});

test("final tool output immediately replaces its live stream without duplication", async () => {
  const env = await testEnv();
  const streamed = deferred();
  const release = deferred();
  env.registerTool("streamer", async (_args, context) => {
    context.onData("SAME OUTPUT"); streamed.resolve(); await release.promise; return "SAME OUTPUT";
  }, { description: "fixture", inputSchema: { type: "object" }, sandbox: false });
  let round = 0;
  const io = fakeIO(async (_, callbacks) => emitScript(round++ === 0
    ? [{ type: "start" }, ...TOOLCALL(0, "call", "streamer", {}), { type: "done" }]
    : [{ type: "done" }], callbacks));
  const agent = new Agent({ env, model: "p/m", context: [], tools: ["streamer"], toolCall: { fork: false }, createIO: () => io });
  const host = GTUI.host.memory({ width: 80, height: 24 });
  const ui = new GTUI({ host });
  const run = ui.run(createApp(agent, { env, sources: {} }));
  try {
    ui.dispatch(msg.submit("go")); await streamed.promise; release.resolve(); await settle();
    expect(host.snapshot().lines.join("\n").split("SAME OUTPUT")).toHaveLength(2);
  } finally { release.resolve(); await settle(); ui.stop(); await run; }
});

test("tool-call argument deltas render before their end event", async () => {
  const env = await testEnv();
  const streamed = deferred();
  const release = deferred();
  const io = fakeIO(async (_, callbacks) => {
    emitScript([{ type: "start" }], { ...callbacks, onDone: () => {} });
    callbacks.onToolcallStart({ type: "toolcall_start", contentIndex: 0, callId: "call", name: "read", arguments: "" });
    callbacks.onToolcallDelta({ type: "toolcall_delta", contentIndex: 0, arguments: '{"path":"STREAMING' });
    streamed.resolve();
    await release.promise;
    return { type: "done" };
  });
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const host = GTUI.host.memory({ width: 80, height: 24 });
  const ui = new GTUI({ host });
  const run = ui.run(createApp(agent, { env, sources: {} }));
  try {
    ui.dispatch(msg.submit("go")); await streamed.promise; await settle();
    expect(host.snapshot().lines.join("\n")).toContain("STREAMING");
  } finally { release.resolve(); await settle(); ui.stop(); await run; }
});
