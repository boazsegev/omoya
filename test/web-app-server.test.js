// test/web-app-server.test.js — the web front end's server/session/protocol,
// over the real public Agent/Env surfaces (never GTUI). The SPA is a client
// of these packets; every check here drives the wire, not the DOM.
import { expect, test } from "bun:test";
import { serve, MAX_WS_PAYLOAD_LENGTH } from "../lib/web-app/server.js";
import { parseClientMessage } from "../lib/web-app/protocol.js";
import { AgentSession } from "../lib/web-app/session.js";
import Agent from "../lib/agent.js";
import Context from "../lib/context.js";
import { TEXT, TOOLCALL, scriptedIO, testEnv } from "./fakes.js";

const { userMessage } = Context;

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = (web) => `http://127.0.0.1:${web.port}`;
function connect(web, received = []) {
  const socket = new WebSocket(`ws://127.0.0.1:${web.port}/ws`, { headers: { Origin: origin(web) } });
  socket.onmessage = (event) => received.push(JSON.parse(event.data));
  return new Promise((resolve, reject) => { socket.onopen = () => resolve(socket); socket.onerror = reject; });
}
const scripted = (env, lines, reply) => {
  const io = scriptedIO([[{ type: "start" }, ...TEXT(0, reply), { type: "done" }]]);
  return new Agent({ env, model: "p/m", context: [], createIO: () => io });
};

test("protocol validates client packets and rejects malformed input", () => {
  expect(parseClientMessage(JSON.stringify({ type: "chat.submit", text: "hi" }))).toEqual({ type: "chat.submit", text: "hi" });
  expect(parseClientMessage(JSON.stringify({ type: "chat.submit", text: "", attachments: ["a"] }))).toEqual({ type: "chat.submit", text: "", attachments: ["a"] });
  expect(() => parseClientMessage(JSON.stringify({ type: "chat.submit", text: "hi", attachments: ["a", "a"] }))).toThrow();
  expect(parseClientMessage(JSON.stringify({ type: "chat.unqueue" }))).toEqual({ type: "chat.unqueue" });
  expect(parseClientMessage(JSON.stringify({ type: "settings.safe", on: true })).on).toBe(true);
  expect(parseClientMessage(JSON.stringify({ type: "question.answer", requestId: "q1", answers: null })).answers).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "session.fork", id: "branch" }))).toEqual({ type: "session.fork", id: "branch" });
  expect(parseClientMessage(JSON.stringify({ type: "session.close", agentId: "agent-1" }))).toEqual({ type: "session.close", agentId: "agent-1" });
  expect(parseClientMessage(JSON.stringify({ type: "context.edit-text", messageIndex: 0, blockIndex: 0, text: "revised" }))).toMatchObject({ type: "context.edit-text", text: "revised" });
  expect(parseClientMessage(JSON.stringify({ type: "tool.call", name: "read", args: { path: "README.md" } }))).toMatchObject({ type: "tool.call", name: "read" });
  expect(() => parseClientMessage("{}")).toThrow();
  expect(() => parseClientMessage(JSON.stringify({ type: "chat.submit" }))).toThrow();
  expect(() => parseClientMessage(JSON.stringify({ type: "nope" }))).toThrow();
  expect(() => parseClientMessage(JSON.stringify({ type: "question.answer", requestId: "q1", answers: "x" }))).toThrow();
});

test("uploads are origin and connection bound, bounded, and consumed as text-first binary blocks", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "uploaded");
  const web = await serve({ port: 0, env, uploadLimits: { fileBytes: 8, totalBytes: 16 }, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received); await tick();
    const key = received.find((m) => m.type === "hello")?.uploadKey;
    expect(key).toMatch(/^[0-9a-f]{48}$/);
    const form = new FormData(); form.append("file", new File(["data"], "note.txt", { type: "text/plain" }));
    expect((await fetch(`${origin(web)}/upload`, { method: "POST", body: form })).status).toBe(403);
    const response = await fetch(`${origin(web)}/upload`, { method: "POST", headers: { Origin: origin(web), "X-Omoya-Upload": key }, body: form });
    expect(response.status).toBe(200);
    const upload = await response.json();
    socket.send(JSON.stringify({ type: "chat.submit", text: "read this", attachments: [upload.id] }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !agent.context.some((message) => message.type === 2 && message.content.length === 2)) await tick();
    const user = agent.context.findLast((message) => message.type === 2);
    expect(user.content.map((block) => block.type)).toEqual(["text", "binary"]);
    expect(Buffer.from(user.content[1].content, "base64").toString()).toBe("data");
    socket.close();
  } finally { web.stop(); }
});

test("server enforces origin, frame size, and serves the SPA with CSP", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  try {
    const home = await fetch(origin(web));
    expect(home.status).toBe(200);
    expect(home.headers.get("content-security-policy")).toContain("default-src");
    expect((await fetch(`${origin(web)}/app.js`)).headers.get("content-type")).toContain("javascript");
    const logo = await fetch(`${origin(web)}/logo.svg`);
    expect(logo.headers.get("content-type")).toContain("image/svg+xml");
    expect(await logo.text()).toContain("Omoya logo");
    expect((await fetch(`${origin(web)}/ws`)).status).toBe(403);
    expect((await fetch(`${origin(web)}/ws`, { headers: { Origin: "http://evil.invalid" } })).status).toBe(403);
    const socket = await connect(web);
    const closed = new Promise((resolve) => { socket.onclose = (event) => resolve(event.code); });
    socket.send("x".repeat(MAX_WS_PAYLOAD_LENGTH + 1));
    expect([1009, 1006]).toContain(await closed);
  } finally { web.stop(); }
});

test("an agent is ready at connection time so settings work before chat, and chat streams turn deltas", async () => {
  const env = await testEnv();
  let created = 0;
  const web = await serve({ port: 0, env, createSession: async () => { created++; return { agent: scripted(env, 0, "web scripted reply") }; } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    expect(created).toBe(1); // Ghost-mode agent is ready before the first message.
    socket.send(JSON.stringify({ type: "settings.safe", on: true }));
    await tick();
    expect(received.findLast((m) => m.type === "settings")?.safe).toBe(true);
    socket.send(JSON.stringify({ type: "chat.submit", text: "hello" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "turn.end")) await tick();
    const text = JSON.stringify(received);
    expect(created).toBe(1);
    expect(received.some((m) => m.type === "hello")).toBe(true);
    expect(received.some((m) => m.type === "chat.user")).toBe(true);
    expect(received.some((m) => m.type === "turn.delta" && m.kind === "text" && m.text.includes("web scripted reply"))).toBe(true);
    expect(text).toContain("web scripted reply");
    socket.close();
  } finally { web.stop(); }
});

test("tool-call response events stream as distinct wire packets", async () => {
  const env = await testEnv();
  const io = {
    state: "idle",
    async write(_context, callbacks) {
      callbacks.onStart?.({ type: "start" });
      callbacks.onThinkingDelta?.({ type: "thinking", text: "reasoning" });
      callbacks.onToolcallStart?.({ type: "toolCall", text: "read" });
      callbacks.onToolcallDelta?.({ type: "toolCall", delta: " README.md" });
      callbacks.onToolcallEnd?.({ type: "toolCall" });
      callbacks.onDone?.({ type: "done" });
      return { type: "done" };
    },
    async kill() { this.state = "closed"; },
  };
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "hello" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "turn.end")) await tick();
    expect(received.filter((m) => m.type.startsWith("tool.call.")).map((m) => [m.type, m.text])).toEqual([
      ["tool.call.start", "read"], ["tool.call.delta", " README.md"], ["tool.call.end", ""],
    ]);
    expect(received.some((m) => m.type === "turn.delta" && m.kind === "thinking")).toBe(true);
    socket.close();
  } finally { web.stop(); }
});

test("the web server uses an explicit theme background and otherwise preserves system fallback", async () => {
  const env = await testEnv();
  env.settings.tui = { themes: {
    night: { background: { bg: "#101820" }, text: { fg: "#eeeeee" } },
    inherited: { text: { fg: "#222222" } },
  } };
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  try {
    const css = await (await fetch(`${origin(web)}/themes.css`)).text();
    expect(css).toContain(':root[data-theme="night"]{--page:#101820');
    expect(css).toContain(':root[data-theme="night"]{--page:#101820;--surface:#101820');
    expect(css).toContain(':root[data-theme="inherited"]{--fg:#222222}');
    expect(css).not.toContain(':root[data-theme="inherited"]{--page:');
  } finally { web.stop(); }
});

test("the web server publishes loaded theme CSS and initial usage status", async () => {
  const env = await testEnv();
  env.settings.tui = { themes: { ember: { text: { fg: "#123456" }, accent: { fg: "#abcdef" }, "status.busy": { animation: { type: "wave", period: 720 } }, "input.border.active.bottom": { animation: { type: "comet", crossing: 1300 } } } } };
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  const received = [];
  try {
    const css = await (await fetch(`${origin(web)}/themes.css`)).text();
    expect(css).toContain('[data-theme="ember"]');
    expect(css).toContain("#123456");
    expect(css).toContain("--working-animation-name:web-wave");
    expect(css).toContain("--working-duration:720ms");
    expect(css).toContain("--input-border-animation-name:web-comet");
    expect(css).toContain("--input-border-duration:1300ms");
    const socket = await connect(web, received);
    await tick();
    const hello = received.find((m) => m.type === "hello");
    expect(hello.status).toMatchObject({ input: 0, output: 0, used: expect.any(Number), available: expect.any(Number) });
    expect(received.find((m) => m.type === "settings")?.prefs.themes).toContain("ember");
    socket.close();
  } finally { web.stop(); }
});

test("statusSnapshot() carries the provider's plan/quota report (mirrors tui-app's planUsage readout)", async () => {
  const env = await testEnv();
  const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "hi"), { type: "done" }]]);
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const session = new AgentSession(agent);
  expect(session.statusSnapshot().plan).toBeNull();
  agent.enqueue(userMessage("hi"));
  io.planUsage = { quotas: { requests: { total: 500, remaining: 470 } } };
  await agent.run();
  expect(session.statusSnapshot().plan).toEqual({ quotas: { requests: { total: 500, remaining: 470 } } });
});

test("the settings packet carries settings.web display prefs (defaults + overrides)", async () => {
  const env = await testEnv();
  env.settings.web = { toolLines: 3, theme: "dark", collapse: { thinking: false } };
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick(60);
    const packet = received.find((m) => m.type === "settings");
    expect(packet).toBeDefined();
    expect(packet.prefs.toolLines).toBe(3);
    expect(packet.prefs.theme).toBe("dark");
    expect(packet.prefs.collapse.thinking).toBe(false);
    expect(packet.prefs.collapse.tools).toBe(true); // untouched default
    expect(packet.prefs.autocomplete).toBe(true);   // untouched default
    expect(packet.prefs.thinkingLevels).toContain("xhigh");
    socket.close();
  } finally { web.stop(); }
});

test("queued web messages can be unqueued for editing before the active turn settles", async () => {
  const env = await testEnv();
  let release;
  const io = {
    state: "idle",
    async write(_context, callbacks) {
      callbacks.start?.({ type: "start" });
      return await new Promise((resolve) => { release = () => resolve({ type: "done" }); });
    },
    async kill() { this.state = "closed"; },
  };
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "active" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !agent.busy) await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "revise me" }));
    while (Date.now() < deadline && !received.findLast((m) => m.type === "chat.queue")) await tick();
    expect(agent.pending).toHaveLength(1);
    expect(received.findLast((m) => m.type === "chat.queue")?.messages).toEqual(["revise me"]);
    socket.send(JSON.stringify({ type: "chat.unqueue" }));
    while (Date.now() < deadline && agent.pending.length !== 0) await tick();
    expect(received.findLast((m) => m.type === "chat.queue")?.messages).toEqual([]);
    release();
    socket.close();
  } finally { web.stop(); }
});

test("queued messages clear and enter the stream when the active turn delivers them", async () => {
  const env = await testEnv();
  let release;
  let writes = 0;
  const io = {
    state: "idle",
    async write(_context, callbacks) {
      callbacks.onStart?.({ type: "start" });
      if (++writes === 1) return await new Promise((resolve) => { release = () => resolve({ type: "done" }); });
      callbacks.onDone?.({ type: "done" });
      return { type: "done" };
    },
    async kill() { this.state = "closed"; },
  };
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "active" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !agent.busy) await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "delivered later" }));
    while (Date.now() < deadline && agent.pending.length !== 1) await tick();
    release();
    while (Date.now() < deadline && (agent.pending.length || !received.some((m) => m.type === "chat.user" && m.message?.text === "delivered later"))) await tick();
    expect(agent.pending).toHaveLength(0);
    expect(received.findLast((m) => m.type === "chat.queue")?.messages).toEqual([]);
    expect(received.some((m) => m.type === "chat.user" && m.message?.text === "delivered later")).toBe(true);
    socket.close();
  } finally { web.stop(); }
});

test("context inspection separates viewer block types and tool display", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "idle");
  agent.context.push(
    { type: 1, content: [{ type: "text", text: "system" }] },
    { type: 2, content: [{ type: "text", text: "user" }] },
    { type: 3, content: [{ type: "thinking", text: "thought" }, { type: "text", text: "reply" }, { type: "toolCall", name: "read", arguments: {} }] },
    { type: 4, name: "read", content: [{ type: "text", text: "answer" }], display: ["display"] },
  );
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "context.inspect" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "context")) await tick();
    const types = received.findLast((m) => m.type === "context").blocks.flatMap((message) => message.content.map((block) => block.viewerType));
    expect(types).toEqual(expect.arrayContaining(["system", "user", "thinking", "assistant", "tool call", "tool answer", "tool display"]));
    socket.close();
  } finally { web.stop(); }
});

test("context deletion removes selected messages through the web protocol", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "idle");
  agent.context.push(
    { type: 2, content: [{ type: "text", text: "first" }] },
    { type: 2, content: [{ type: "text", text: "second" }] },
    { type: 2, content: [{ type: "text", text: "third" }] },
  );
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "context.delete", messageIndexes: [0, 2] }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && agent.context.length !== 1) await tick();
    expect(agent.context.map((message) => message.content[0].text)).toEqual(["second"]);
    expect(received.findLast((m) => m.type === "context")?.blocks).toHaveLength(1);
    socket.close();
  } finally { web.stop(); }
});

test("the web protocol exposes context inspection/editing and direct tool calls", async () => {
  const env = await testEnv();
  env.registerTool("echo", async ({ value }) => ({ content: [{ type: "text", text: String(value) }] }), {
    description: "Returns the supplied value.", inputSchema: { type: "object", properties: { value: { type: "string" } } }, safe: true,
  });
  const agent = scripted(env, 0, "idle");
  agent.append({ type: 2, content: [{ type: "text", text: "before" }] });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "context.inspect" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "context")) await tick();
    expect(received.findLast((m) => m.type === "context")?.blocks[0].content[0].text).toBe("before");
    socket.send(JSON.stringify({ type: "context.edit-text", messageIndex: 0, blockIndex: 0, text: "after" }));
    while (Date.now() < deadline && agent.context[0].content[0].text !== "after") await tick();
    expect(agent.context[0].content[0].text).toBe("after");
    socket.send(JSON.stringify({ type: "tool.call", name: "echo", args: { value: "tool result" } }));
    while (Date.now() < deadline && !JSON.stringify(received).includes("tool result")) await tick();
    expect(JSON.stringify(received)).toContain("tool result");
    socket.close();
  } finally { web.stop(); }
});

test("the model menu lists clean endpoint/model combos, never completion noise", async () => {
  const env = await testEnv();
  env.endpoints.acme = { provider: "test", url: "test://script" };
  env.authSet("acme", { token: "t", models: { "acme-pro": null, "acme-mini": null } });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick(60);
    const models = received.find((m) => m.type === "settings")?.models ?? [];
    // Only concrete combos — never a bare endpoint or a bare model id.
    expect(models).toContain("acme/acme-pro");
    expect(models).toContain("acme/acme-mini");
    expect(models).not.toContain("acme");
    expect(models).not.toContain("acme-pro");
    expect(models.every((m) => m.includes("/"))).toBe(true);
    socket.close();
  } finally { web.stop(); }
});

test("session.fork turns Ghost mode into a saved branch", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env, 0, "idle") }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    expect(received.find((m) => m.type === "hello")?.agent?.session).toBeNull();
    socket.send(JSON.stringify({ type: "session.fork", id: "web-branch" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.findLast((m) => m.type === "hello")?.agent?.session) await tick();
    expect(received.findLast((m) => m.type === "hello")?.agent?.session).toBe("web-branch");
    socket.close();
  } finally { web.stop(); }
});

test("session.new replaces the viewed agent with a fresh Ghost agent", async () => {
  const env = await testEnv();
  const agents = [];
  const web = await serve({ port: 0, env, createSession: async () => {
    const agent = scripted(env, 0, "idle");
    agents.push(agent);
    return { agent };
  } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    const first = agents[0];
    socket.send(JSON.stringify({ type: "session.new" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && agents.length < 2) await tick();
    expect(first.closed).toBe(true);
    expect(agents[1].session).toBeNull();
    expect(received.findLast((m) => m.type === "hello")?.agent?.id).toBe(agents[1].name);
    socket.close();
  } finally { web.stop(); }
});

test("resuming a saved session replaces the viewed agent", async () => {
  const env = await testEnv();
  const agents = [];
  const web = await serve({ port: 0, env, createSession: async () => {
    const agent = scripted(env, 0, "idle");
    agents.push(agent);
    return { agent };
  } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    const originalList = Agent.SessionStore.listAsync;
    Agent.SessionStore.listAsync = async () => [{ id: "saved", preview: "saved", messages: 0 }];
    try {
      socket.send(JSON.stringify({ type: "session.resume", id: "saved" }));
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && agents.length < 2) await tick();
      expect(agents[0].closed).toBe(true);
      expect(received.findLast((m) => m.type === "hello")?.agent?.id).toBe(agents[1].name);
    } finally { Agent.SessionStore.listAsync = originalList; }
    socket.close();
  } finally { web.stop(); }
});

test("session.add creates an additional agent while keeping the current one", async () => {
  const env = await testEnv();
  let created = 0;
  const web = await serve({ port: 0, env, createSession: async () => { created++; return { agent: scripted(env, 0, `reply-${created}`) }; } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "first" }));
    const d1 = Date.now() + 4000;
    while (Date.now() < d1 && !received.some((m) => m.type === "turn.end")) await tick();
    expect(created).toBe(1);
    socket.send(JSON.stringify({ type: "session.add" }));
    const d2 = Date.now() + 4000;
    while (Date.now() < d2 && created < 2) await tick();
    expect(created).toBe(2); // an ADDITIONAL agent, not a replacement
    socket.close();
  } finally { web.stop(); }
});

test("session.close closes an open agent and replaces its attached view", async () => {
  const env = await testEnv();
  const agents = [];
  const web = await serve({ port: 0, env, createSession: async () => {
    const agent = scripted(env, 0, "idle");
    agents.push(agent);
    return { agent };
  } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    const first = agents[0];
    socket.send(JSON.stringify({ type: "session.close", agentId: first.name }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && agents.length < 2) await tick();
    expect(first.closed).toBe(true);
    expect(env.agents()).not.toContain(first);
    expect(agents).toHaveLength(2);
    expect(received.findLast((m) => m.type === "hello")?.agent?.id).toBe(agents[1].name);
    socket.close();
  } finally { web.stop(); }
});

test("attaching to an agent replays its stored context as history blocks", async () => {
  const env = await testEnv();
  const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "seeded reply"), { type: "done" }]]);
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    // Drive one turn so the context holds a user + assistant exchange.
    socket.send(JSON.stringify({ type: "chat.submit", text: "seeded question" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "turn.end")) await tick();
    // A second connection switching to the same agent replays the history.
    const bMsgs = [];
    const b = await connect(web, bMsgs);
    await tick();
    b.send(JSON.stringify({ type: "session.switch", agentId: agent.name }));
    const sw = Date.now() + 4000;
    let hello;
    while (Date.now() < sw && !(hello = bMsgs.find((m) => m.type === "hello"))) await tick();
    expect(hello).toBeDefined();
    const history = JSON.stringify(hello.history ?? []);
    expect(history).toContain("seeded question");
    expect(history).toContain("seeded reply");
    socket.close(); b.close();
  } finally { web.stop(); }
});

test("re-entering an agent replays a response streamed while it was in the background", async () => {
  const env = await testEnv();
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const firstIO = {
    state: "idle",
    async kill() {},
    async write(_context, callbacks) {
      callbacks.onStart?.({ type: "start" });
      callbacks.onTextDelta?.({ type: "text", text: "before switch " });
      await paused;
      callbacks.onTextDelta?.({ type: "text", text: "after switch" });
      callbacks.onDone?.({ type: "done" });
      return { type: "done" };
    },
  };
  const first = new Agent({ env, model: "p/m", context: [], createIO: () => firstIO });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: first }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "background me" }));
    const started = Date.now() + 4000;
    while (Date.now() < started && !JSON.stringify(received).includes("before switch")) await tick();
    socket.send(JSON.stringify({ type: "session.add" }));
    await tick();
    release();
    await tick(60);
    socket.send(JSON.stringify({ type: "session.switch", agentId: first.name }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.findLast((m) => m.type === "hello")?.history?.some((block) => block.text?.includes("after switch"))) await tick();
    const hello = received.findLast((m) => m.type === "hello");
    expect(hello.history.map((block) => block.text).join("")).toContain("before switch after switch");
    socket.close();
  } finally { web.stop(); }
});

test("connections are isolated: one connection's turn never leaks to another", async () => {
  const env = await testEnv();
  let created = 0;
  const web = await serve({ port: 0, env, createSession: async () => { const n = ++created; return { agent: scripted(env, 0, `reply-${n}`) }; } });
  const aMsgs = []; const bMsgs = [];
  try {
    const a = await connect(web, aMsgs);
    const b = await connect(web, bMsgs);
    await tick();
    a.send(JSON.stringify({ type: "chat.submit", text: "A" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !aMsgs.some((m) => m.type === "turn.end")) await tick();
    await tick(60);
    expect(JSON.stringify(aMsgs)).toContain("reply-1");
    expect(JSON.stringify(bMsgs)).not.toContain("reply-1");
    a.close(); b.close();
  } finally { web.stop(); }
});

// The question bridge is the AgentSession's seam for interactive tools. We
// drive it through the PUBLIC setQuestion surface (an interactive tool calls
// exactly this) rather than the full tool-sandbox e2e — the latter is the
// Agent's concern and covered by agent-question tests.
test("a timed-out bridge question closes over the wire and rejects a late answer", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "idle");
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    const question = agent._question.ask([{ question: "Allow?", header: "Worker", options: [{ label: "Allow", description: "yes" }] }]);
    let opened;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !(opened = received.find((m) => m.type === "question.open"))) await tick();
    agent._question.timeout(); // mirrors Agent's timeout boundary
    while (Date.now() < deadline && !received.some((m) => m.type === "question.close")) await tick();
    await expect(question).resolves.toBeNull();
    socket.send(JSON.stringify({ type: "question.answer", requestId: opened.requestId, answers: [{ labels: ["Allow"] }] }));
    await tick();
    expect(received.filter((m) => m.type === "question.close")).toHaveLength(1);
    socket.close();
  } finally { web.stop(); }
});

// The question bridge is the AgentSession's seam for interactive tools. We
// drive it through the PUBLIC setQuestion surface (an interactive tool calls
// exactly this) rather than the full tool-sandbox e2e — the latter is the
// Agent's concern and covered by agent-question tests.
test("a question asked through the bridge opens over the wire and an answer resolves it", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "idle");
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    // The connection's ready agent has an AgentSession-installed question
    // bridge. Ask through it (an interactive tool calls exactly this): it must open a
    // question over the wire and resolve with the user's answer.
    let opened;
    const openDeadline = Date.now() + 4000;
    const bridgePromise = agent._question.ask([{ question: "Pick", header: "Choice", options: [{ label: "A", description: "a" }] }]);
    while (Date.now() < openDeadline && !(opened = received.find((m) => m.type === "question.open"))) await tick();
    expect(opened).toBeDefined();
    expect(JSON.stringify(opened.questions)).toContain("Pick");
    socket.send(JSON.stringify({ type: "question.answer", requestId: opened.requestId, answers: [{ question: "Pick", answer: "A" }] }));
    await expect(bridgePromise).resolves.toEqual([{ question: "Pick", answer: "A" }]);
    socket.close();
  } finally { web.stop(); }
});
