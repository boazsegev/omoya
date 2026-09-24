// test/io-auth-refresh.test.js — the multi-process auth rotation retry:
// a request that fails with an `auth` error before any response data
// makes IO re-read the endpoint's persisted settings/auth record
// (Env.refreshEndpointSettings — another process may have rotated the
// token) and re-send ONCE with the updated credentials; an unchanged
// token, a prior data event, or a kill makes the request final.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env, ProviderError, writeJsonAtomic } from "../lib/env.js";
import { IO } from "../lib/io.js";
import TestPlugin from "../providers/test.js";

let dir;
beforeEach(() => {
  dir = mkdtempSync("./ai-tmp/auth-refresh-");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An Env holding the "stale" in-memory token, persisted to its own folder. */
function staleEnv() {
  const value = new Env({ dir, cwd: dir, settingsDir: dir });
  value.registerProvider("test", TestPlugin);
  value.saveEndpoint("test", { provider: "test", url: "test://script", secret: true });
  value.authSet("test", { auth: { type: "token", token: "stale-token" } });
  return value;
}

/** The OTHER process: overwrite the endpoint's on-disk auth record directly. */
function rotateOnDisk(endpoint, section) {
  writeJsonAtomic(join(dir, `auth-${endpoint}.json`), { [endpoint]: section });
}

/**
 * A scripted connector that fails `auth` on the stale token and succeeds
 * on the fresh one. `onSend` lets a test rotate the on-disk credential
 * from inside the in-flight attempt (the genuine multi-process
 * interleave); every attempt's credential lands in the shared `log`.
 */
function tokenGate({ log, onSend }) {
  return class TokenGatePlugin {
    static provider = { label: "token-gate", capabilities: {}, secret: true };
    constructor(url, aiio) {
      this.url = url;
      this.aiio = aiio;
    }
    // send receives the sanitized [headers, body]; the token it was
    // BUILT with is the current settings view — the credential under test
    async send() {
      const token = this.aiio.settings.auth?.token;
      log.push(token);
      onSend?.();
      if (token !== "fresh-token") {
        throw new ProviderError("auth", "401 Unauthorized (at token-gate)");
      }
    }
    async read() { return null; }
    async close() {}
    msg2events() { return []; }
    async models() { return {}; }
    async login() { return { type: "none" }; }
  };
}

/** A gate-registered Env holding the stale in-memory token. */
function gateEnv(options) {
  const env = staleEnv();
  env.registerProvider("gate", tokenGate(options));
  env.saveEndpoint("gate", { provider: "gate", url: "test://gate" });
  env.authSet("gate", { auth: { type: "token", token: "stale-token" } });
  return env;
}

describe("IO auth refresh: multi-process token rotation", () => {
  test("an auth failure re-reads the auth file and retries once with the fresh token", async () => {
    const log = [];
    const env = gateEnv({
      log,
      // the other process rotates the credential while the first attempt is in flight
      onSend: () => rotateOnDisk("gate", { auth: { type: "token", token: "fresh-token" } }),
    });
    const aiio = new IO({ env, model: "gate/test-model" });
    const events = [];
    const terminal = await aiio.write(
      [{ type: 2, content: [{ type: "text", text: "hi" }] }],
      new Proxy({}, { get: () => (e) => events.push(e) }),
    );
    expect(terminal.type).toBe("done");
    expect(log).toEqual(["stale-token", "fresh-token"]);
    expect(events.filter((e) => e.type === "start").length).toBe(2); // one boundary per attempt
    expect(events.filter((e) => e.type === "error").length).toBe(0); // the auth error is swallowed
    expect(env.endpointSettings("gate").auth.token).toBe("fresh-token");
  });

  test("an unchanged token surfaces the auth error (no retry)", async () => {
    const log = [];
    const env = gateEnv({ log });
    const aiio = new IO({ env, model: "gate/test-model" });
    const terminal = await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(terminal.type).toBe("error");
    expect(terminal.kind).toBe("auth");
    expect(terminal.error).toContain("401");
    expect(log).toEqual(["stale-token"]); // one attempt only
  });

  test("an auth error AFTER response data stays final (no replay over streamed output)", async () => {
    const env = staleEnv();
    const aiio = new IO({ env, model: "test/m", settings: {
      script: [[{ text: "partial" }, { error: "401 Unauthorized" }]],
    } });
    const events = [];
    const terminal = await aiio.write(
      [{ type: 2, content: [{ type: "text", text: "hi" }] }],
      new Proxy({}, { get: () => (e) => events.push(e) }),
    );
    expect(terminal.type).toBe("error");
    expect(events.filter((e) => e.type === "start").length).toBe(1); // never retried
  });

  test("an explicit auth override still follows the rotated file", async () => {
    const log = [];
    const env = gateEnv({
      log,
      onSend: () => rotateOnDisk("gate", { auth: { type: "token", token: "fresh-token" } }),
    });
    const aiio = new IO({ env, model: "gate/test-model", settings: { auth: { type: "token", token: "stale-token" } } });
    const terminal = await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(terminal.type).toBe("done");
    expect(log).toEqual(["stale-token", "fresh-token"]);
  });

  test("a kill during the failing attempt cancels — the refresh never re-sends", async () => {
    const log = [];
    const env = gateEnv({
      log,
      onSend: () => rotateOnDisk("gate", { auth: { type: "token", token: "fresh-token" } }),
    });
    const aiio = new IO({ env, model: "gate/test-model" });
    const write = aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    await aiio.kill();
    const terminal = await write;
    expect(terminal.type).toBe("error");
    expect(terminal.cancelled).toBe(true);
    expect(aiio.state).toBe("closed");
    expect(log.length).toBeLessThanOrEqual(1); // no re-send after kill
  });

  test("a rotated URL is followed by the retry", async () => {
    const log = [];
    const urls = [];
    class UrlGatePlugin extends tokenGate({
      log,
      onSend: () => rotateOnDisk("gate", { url: "test://new", auth: { type: "token", token: "fresh-token" } }),
    }) {
      constructor(url, aiio) {
        super(url, aiio);
        urls.push(url);
      }
    }
    const env = staleEnv();
    env.registerProvider("gate", UrlGatePlugin);
    env.saveEndpoint("gate", { provider: "gate", url: "test://old" });
    env.authSet("gate", { auth: { type: "token", token: "stale-token" } });
    const aiio = new IO({ env, model: "gate/test-model" });
    const terminal = await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(terminal.type).toBe("done");
    expect(urls).toEqual(["test://old", "test://new"]);
  });

  test("a non-auth failure never touches the settings files", async () => {
    const env = staleEnv();
    let refreshed = 0;
    const original = env.refreshEndpointSettings.bind(env);
    env.refreshEndpointSettings = (name) => { refreshed++; return original(name); };
    const aiio = new IO({ env, model: "test/m", settings: { script: [[{ error: "boom" }]] } });
    const terminal = await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(terminal.type).toBe("error");
    expect(terminal.error).toBe("boom");
    expect(refreshed).toBe(0);
  });
});
