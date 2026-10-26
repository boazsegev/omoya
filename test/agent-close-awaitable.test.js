import { expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { fakeIO, testEnv, USER } from "./fakes.js";
import TestProvider from "../providers/test.js";
import { authSetOf, providerAdd } from "./env-internals.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out awaiting lifecycle transition");
}

async function settlement(promise, ms = 250) {
  return Promise.race([
    Promise.resolve(promise).then(() => "settled", () => "rejected"),
    Bun.sleep(ms).then(() => "pending"),
  ]);
}

async function oauthEnvironment() {
  const env = await testEnv();
  providerAdd(env, "test", TestProvider);
  env.settings.retry = { attempts: 1 };
  env.settings.providers.p.script = [[{ text: "done" }]];
  env.settings.providers.p.oauth = { tokenUrl: "https://oauth.test/token", clientId: "test" };
  authSetOf(env, "p", { auth: { type: "oauth", access: "expired", token: "expired", refresh: "refresh", expires: Date.now() - 1 } });
  return env;
}

function stallOAuthFetch() {
  const originalFetch = globalThis.fetch;
  let refreshStarted;
  let rejectRefresh;
  const stall = {
    started: new Promise((resolve) => { refreshStarted = resolve; }),
    signal: undefined,
    release(message) { rejectRefresh?.(new Error(message)); },
    restore() { globalThis.fetch = originalFetch; },
  };
  globalThis.fetch = (_url, init) => {
    stall.signal = init.signal;
    refreshStarted();
    return new Promise((_, reject) => {
      rejectRefresh = reject;
      if (init.signal?.aborted) reject(init.signal.reason);
      else init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  return stall;
}

function ownedIO(gate, { failure } = {}) {
  const io = fakeIO(async () => ({ type: "done" }));
  io.close = async () => {
    io.closes++;
    await gate.promise;
    io.state = "closed";
    if (failure) throw failure;
  };
  return io;
}

test("cancellation settles a close-marked agent stalled in OAuth refresh", async () => {
  const env = await oauthEnvironment();
  const stall = stallOAuthFetch();
  let agent;
  try {
    agent = await Agent.create({ env, model: "p/test-model" });
    const turn = agent.send(USER("work"));
    expect(await settlement(stall.started)).toBe("settled");
    const closing = agent.close();
    expect(agent).toMatchObject({ busy: true, closeMarked: true, closed: false });
    expect(agent._activeIO.state).toBe("sending");
    expect(env.agents()).toContain(agent);

    const cancelling = agent.cancel();
    const cancelled = await settlement(cancelling);
    // Release a broken implementation too, so the failing regression never leaks a zombie.
    if (cancelled !== "settled") stall.release("test release");
    const [terminal] = await Promise.allSettled([turn, closing, cancelling]);
    expect(cancelled).toBe("settled");
    expect(stall.signal).toBeInstanceOf(AbortSignal);
    expect(terminal.status).toBe("fulfilled");
    expect(terminal.value).toMatchObject({ type: "error", cancelled: true });
    expect(agent).toMatchObject({ busy: false, closeMarked: true, closed: true });
    expect(env.agents()).not.toContain(agent);
  } finally {
    stall.release("test cleanup");
    stall.restore();
    if (agent && !agent.closed) await agent.cancel().catch(() => {});
    if (agent && !agent.closed) await agent.close().catch(() => {});
    await env.close();
  }
});

test("the overall timeout settles graceful close during OAuth refresh", async () => {
  const env = await oauthEnvironment();
  const stall = stallOAuthFetch();
  env.settings.providers.p.timeout = 20;
  let agent;
  try {
    agent = await Agent.create({ env, model: "p/test-model" });
    const turn = agent.send(USER("work"));
    expect(await settlement(stall.started)).toBe("settled");
    const closing = agent.close();
    const closed = await settlement(closing);
    if (closed !== "settled") stall.release("test release");
    const [terminal] = await Promise.allSettled([turn, closing]);
    expect(closed).toBe("settled");
    expect(terminal.status).toBe("fulfilled");
    expect(terminal.value).toMatchObject({ type: "error", error: expect.stringContaining("overall cap") });
    expect(agent).toMatchObject({ busy: false, closeMarked: true, closed: true });
    expect(env.agents()).not.toContain(agent);
  } finally {
    stall.release("test cleanup");
    stall.restore();
    if (agent && !agent.closed) await agent.cancel().catch(() => {});
    if (agent && !agent.closed) await agent.close().catch(() => {});
    await env.close();
  }
});

test("idle close marks immediately but repeated calls wait for owned IO and context release", async () => {
  const env = await testEnv();
  const ioGate = deferred();
  const contextGate = deferred();
  const io = ownedIO(ioGate);
  const agent = await Agent.create({ env, model: "p/m", createIO: () => io });
  void agent.io;
  const originalClose = agent.context.close.bind(agent.context);
  agent.context.close = async () => { await contextGate.promise; await originalClose(); };
  const events = [];
  agent.onEvent(Agent.EVENT.CLOSE_MARKED, () => events.push("marked"));
  agent.onEvent(Agent.EVENT.CLOSED, () => events.push("closed"));
  const first = agent.close();
  const second = agent.close();
  expect(first).toBeInstanceOf(Promise);
  expect(agent.closeMarked).toBe(true);
  expect(agent.closed).toBe(false);
  expect(events).toEqual(["marked"]);
  expect(env.agents()).toContain(agent);
  await expect(agent.send(USER("late"))).rejects.toThrow(/closed/i);
  contextGate.resolve();
  await until(() => io.closes === 1);
  expect(agent.closed).toBe(false);
  ioGate.resolve();
  await Promise.all([first, second, agent.close(), agent._performClose()]);
  expect(events).toEqual(["marked", "closed"]);
  expect(agent.closed).toBe(true);
  expect(env.agents()).not.toContain(agent);
  expect(io.closes).toBe(1);
  await env.close();
});

test("busy close waits for the graceful turn, context persistence, then emits CLOSED", async () => {
  const env = await testEnv();
  const turnGate = deferred();
  const saveGate = deferred();
  const io = fakeIO(async () => { await turnGate.promise; return { type: "done" }; });
  const agent = await Agent.create({ env, model: "p/m", createIO: () => io });
  const flush = agent.context.flushAsync.bind(agent.context);
  let hold = false;
  agent.context.flushAsync = async () => { if (hold) await saveGate.promise; await flush(); };
  const events = [];
  agent.onEvent(Agent.EVENT.CLOSE_MARKED, () => events.push("marked"));
  agent.onEvent(Agent.EVENT.REQUEST_DONE, () => events.push("done"));
  agent.onEvent(Agent.EVENT.CLOSED, () => events.push("closed"));
  const turn = agent.send(USER("work"));
  await until(() => io.writes.length === 1);
  hold = true;
  const completion = agent.close();
  expect(agent.closeMarked).toBe(true);
  expect(agent.closed).toBe(false);
  turnGate.resolve();
  await until(() => io.state === "idle");
  expect(events).toEqual(["marked"]);
  expect(agent.closed).toBe(false);
  saveGate.resolve();
  await turn;
  await completion;
  expect(events).toEqual(["marked", "done", "closed"]);
  expect(io.closes).toBe(1);
  await env.close();
});

test("listener and IO release failures do not skip Context, Env registry, or remaining IO", async () => {
  const env = await testEnv();
  const failure = new Error("provider close failed");
  const first = ownedIO(deferred(), { failure });
  const second = ownedIO(deferred());
  // Replace their close gates with immediately settling implementations below.
  const agent = await Agent.create({ env, model: "p/m", createIO: ({ model }) => model === "p/m" ? first : second });
  void agent.io;
  agent.model = "p/n";
  void agent.io;
  first.close = async () => { first.closes++; throw failure; };
  second.close = async () => { second.closes++; second.state = "closed"; };
  let contextClosed = false;
  const originalClose = agent.context.close.bind(agent.context);
  agent.context.close = async () => { await originalClose(); contextClosed = true; };
  agent.onEvent(Agent.EVENT.CLOSE_MARKED, () => { throw new Error("mark listener failed"); });
  agent.onEvent(Agent.EVENT.CLOSED, () => { throw new Error("closed listener failed"); });
  let rejection;
  try { await agent.close(); } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(AggregateError);
  expect(rejection.errors.map((error) => error.message)).toEqual(expect.arrayContaining([
    "mark listener failed", "closed listener failed", "provider close failed",
  ]));
  expect(first.closes).toBe(1);
  expect(second.closes).toBe(1);
  expect(contextClosed).toBe(true);
  expect(agent.closed).toBe(true);
  expect(env.agents()).not.toContain(agent);
  await expect(agent.close()).rejects.toThrow();
  await env.close();
});

test("one Agent close leaves a borrowed shared Env and sibling usable", async () => {
  const env = await testEnv();
  const a = await Agent.create({ env });
  const b = await Agent.create({ env });
  await a.close();
  expect(env.closed).toBe(false);
  expect(env.agents()).toEqual([b]);
  await b.close();
  expect(env.closed).toBe(false);
  await env.close();
});

test("closing parent refuses both childCreate and direct child construction without registry leaks", async () => {
  const env = await testEnv();
  const parent = await Agent.create({ env });
  const completion = parent.close();
  await expect(parent.childCreate({ name: "late" })).rejects.toThrow(/closing/);
  await expect(Agent.create({ env, parent, name: "direct-late" })).rejects.toThrow(/closing/);
  expect(parent.children).toEqual([]);
  // Idle close may already have removed the parent; failed children must
  // never be registered regardless of cleanup scheduling.
  expect(env.agents().every((member) => member === parent)).toBe(true);
  await completion;
  expect(env.agents()).toEqual([]);
  await env.close();
});

test("closing parent detaches but does not close a child or its shared Env", async () => {
  const env = await testEnv();
  const parent = await Agent.create({ env });
  const child = await Agent.create({ env, parent });
  await parent.close();
  expect(child.parent).toBeUndefined();
  expect(child.closed).toBe(false);
  expect(env.agents()).toContain(child);
  await child.close();
  await env.close();
});
