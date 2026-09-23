// Outgoing request sanitizer and normalized response validation.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { IO, sanitizeRequest, ProviderError } from "../lib/io.js";

let dir, env;
beforeEach(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-sv-")));
  env = new Env({ dir, cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sanitizeRequest", () => {
  test("headers are plain string values and junk is dropped", () => {
    expect(sanitizeRequest([{ "content-type": "application/json", "x-num": 42, drop: undefined, fn: () => {}, nil: null }, {}])[0])
      .toEqual({ "content-type": "application/json", "x-num": "42" });
  });
  test("non-object headers and circular bodies are malformed", () => {
    expect(() => sanitizeRequest(["bad", {}])).toThrow(ProviderError);
    const circular = {}; circular.self = circular;
    expect(() => sanitizeRequest([{}, circular])).toThrow(/not JSON-serializable/);
  });
  test("body passes through and a bare body gets empty headers", () => {
    const body = { model: "m" };
    expect(sanitizeRequest([{}, body])).toEqual([{}, body]);
    expect(sanitizeRequest([{}, undefined])).toEqual([{}, null]);
    expect(sanitizeRequest({ raw: true })).toEqual([{}, { raw: true }]);
  });
});

function providerWithEvents(events) {
  return class FakeProvider {
    static provider = {};
    constructor(url, aiio) { this.url = url; this.aiio = aiio; this.sent = false; }
    context2msg() { return [{}, {}]; }
    msg2events() { return events; }
    async send() {}
    async read() { if (this.sent) return null; this.sent = true; return {}; }
    async close() {}
  };
}
function makeIO(events) {
  env.registerProvider("fake", providerWithEvents(events));
  env.endpoints.fake = { provider: "fake", url: "test://fake" };
  return new IO({ env, model: "fake/m" });
}

describe("response validator", () => {
  test("invalid events become classified malformed terminals", async () => {
    const terminal = await makeIO([{ type: "bogus" }]).write([{ type: 2, content: [] }]);
    expect(terminal).toMatchObject({ type: "error", kind: "malformed" });
    expect(terminal.error).toMatch(/invalid connector event/);
  });
  test("indexed events require contentIndex", async () => {
    const terminal = await makeIO([{ type: "text_delta", text: "x" }]).write([{ type: 2, content: [] }]);
    expect(terminal.kind).toBe("malformed");
  });
  test("metadata passes through valid events", async () => {
    const seen = [];
    const terminal = await makeIO([
      { type: "text_delta", contentIndex: 0, text: "ok", native: { id: "msg_1" } },
      { type: "done", providerTag: "xyz", usage: { inputTokens: 1, outputTokens: 1 } },
    ]).write([{ type: 2, content: [] }], { onTextDelta: (event) => seen.push(event) });
    expect(seen[0].native).toEqual({ id: "msg_1" });
    expect(terminal.providerTag).toBe("xyz");
    expect(terminal.usage.source).toBe("provider");
  });
  test("nil translator results are skipped", async () => {
    expect((await makeIO([null, false, undefined]).write([{ type: 2, content: [] }])).type).toBe("done");
  });
});
