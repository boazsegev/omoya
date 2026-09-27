// Provider plugins are standalone classes: Env completes their static
// catalog side (lib/env/provider.js), IO their wire side (lib/io/provider.js).
import { describe, expect, test } from "bun:test";
import { ProviderError } from "../lib/io.js";
import { defineProvider } from "../lib/env/provider.js";
import { classifyError } from "../lib/io/provider-error.js";
import { providerClass } from "./fakes.js";

class EmptyProtocol {}

describe("provider completion", () => {
  test("IO completes missing wire methods with the OpenAI defaults", async () => {
    const Protocol = await providerClass(EmptyProtocol, "p1");
    const connection = new Protocol("https://example.test/v1", { settings: {}, tools: () => [] });
    expect(connection.baseUrl).toBe("https://example.test/v1");
    expect(connection.url).toBe("https://example.test/v1/responses");
    for (const method of ["context2msg", "msg2events", "send", "read", "close", "reportPlanUsage", "classifyError", "depletionError"]) {
      expect(typeof connection[method], method).toBe("function");
    }
    for (const method of ["detect", "models", "testConnection", "login"]) {
      expect(typeof Protocol[method], method).toBe("function");
    }
  });

  test("custom constructor and methods are retained", async () => {
    const read = async function () { return this.marker; };
    class CustomProtocol {
      static provider = { label: "Custom", vendor: "acme", capabilities: { tools: true } };
      constructor(url, aiio) { this.baseUrl = url; this.aiio = aiio; this.marker = "custom"; }
      read = read;
      async close() { this.closedByCustom = true; }
    }
    const Protocol = await providerClass(CustomProtocol, "custom");
    const connection = new Protocol("tcp://host", {});
    expect(await connection.read()).toBe("custom");
    await connection.close();
    expect(connection.closedByCustom).toBe(true);
    expect(Protocol.provider).toEqual({
      name: "custom",
      label: "Custom",
      vendor: "acme",
      capabilities: { tools: true, thinking: [], streaming: false },
    });
  });

  test("metadata defaults to the basename, no thinking, and no tool calling", () => {
    expect(defineProvider(class {}, { name: "plain" }).provider).toEqual({
      name: "plain",
      label: "plain",
      capabilities: { tools: false, thinking: [], streaming: false },
    });
  });

  test("native thinking modes keep their order; the tool map keeps callable tools only", () => {
    const search = async () => "found";
    const Protocol = defineProvider(class {
      static provider = { capabilities: { thinking: ["none", "low", 3, "high"], tools: { "web-search": { function: search }, broken: {} } } };
    }, { name: "rich" });
    expect(Protocol.provider.capabilities.thinking).toEqual(["none", "low", "high"]);
    expect(Object.keys(Protocol.provider.capabilities.tools)).toEqual(["web-search"]);
    expect(Protocol.provider.capabilities.tools["web-search"].function).toBe(search);
  });

  test("a missing endpoint detector is a no-op", async () => {
    expect(await defineProvider(class {}, { name: "quiet" }).detect({})).toEqual({});
  });

  test("invalid plugins or missing basename are contract errors", () => {
    expect(() => defineProvider({}, { name: "x" })).toThrow(/default-export a class/);
    expect(() => defineProvider(class {})).toThrow(/basename\/name required/);
    expect(() => defineProvider(null, { name: "x" })).toThrow(TypeError);
  });

  test("default static models() throws when the listing fails (Env keeps its cache)", async () => {
    const Protocol = defineProvider(class {}, { name: "p6" });
    await expect(Protocol.models({ url: "http://127.0.0.1:1/v1", settings: {}, signal: AbortSignal.timeout(200) })).rejects.toBeDefined();
  });

  test("default login() is a classified auth error without a token, an api-key record with one", () => {
    const Protocol = defineProvider(class {}, { name: "p7" });
    expect(() => Protocol.login({}, { settings: {} })).toThrow(expect.objectContaining({ kind: "auth" }));
    expect(Protocol.login({ token: "t" })).toEqual({ type: "api_key", token: "t" });
  });

  test("a provider send receives the plain HTTP transport as `base`", async () => {
    const sent = [];
    const Protocol = await providerClass(class {
      async send(message, base) { sent.push(message); return typeof base; }
    }, "wrapper");
    expect(await new Protocol("https://example.test/v1", {}).send(["h", "b"])).toBe("function");
    expect(sent).toEqual([["h", "b"]]);
  });

  test("classifyError/depletionError refine the shared verdict (`base`)", async () => {
    const Protocol = await providerClass(class {
      classifyError(err, base) {
        if (err.status === 403) base.kind = "provider";
        return base;
      }
      depletionError(classified, base) { return classified.status === 403 || base; }
    }, "refined");
    const connection = new Protocol("https://example.test/v1", { name: "ep" });
    const verdict = connection.classifyError(Object.assign(new Error("HTTP 403"), { status: 403 }));
    expect(verdict).toBeInstanceOf(ProviderError);
    expect(verdict.kind).toBe("provider");
    expect(connection.classifyError(Object.assign(new Error("HTTP 401"), { status: 401 })).kind).toBe("auth");
    expect(connection.depletionError({ kind: "provider", status: 403, message: "" })).toBe(true);
    expect(connection.depletionError({ kind: "provider", status: 429, message: "" })).toBe(true);
    expect(connection.depletionError({ kind: "provider", status: 500, message: "" })).toBe(false);
  });
});

describe("provider error taxonomy", () => {
  test("ProviderError passes through unchanged", () => {
    const original = new ProviderError("malformed", "bad");
    expect(classifyError(original)).toBe(original);
  });

  test("an explicit kind wins; HTTP 401/403 -> auth; other statuses -> provider", () => {
    expect(classifyError(Object.assign(new Error("bad body"), { kind: "malformed" })).kind).toBe("malformed");
    expect(classifyError(Object.assign(new Error("quota"), { kind: "provider", status: 403 })).kind).toBe("provider");
    expect(classifyError({ status: 401, message: "unauthorized" }).kind).toBe("auth");
    expect(classifyError({ status: 403, message: "forbidden" }).kind).toBe("auth");
    expect(classifyError({ status: 500, message: "boom" }).kind).toBe("provider");
    expect(classifyError({ status: 429, message: "slow down" }).kind).toBe("provider");
  });

  test("fetch TypeError -> network", () => {
    expect(classifyError(new TypeError("fetch failed")).kind).toBe("network");
  });

  test("abort/timeout -> network", () => {
    const abort = new Error("aborted"); abort.name = "AbortError";
    expect(classifyError(abort).kind).toBe("network");
    const timeout = new Error("timed out"); timeout.name = "TimeoutError";
    expect(classifyError(timeout).kind).toBe("network");
  });

  test("SyntaxError -> malformed", () => {
    expect(classifyError(new SyntaxError("Unexpected token")).kind).toBe("malformed");
  });

  test("anything else -> provider; provider name decorates the message", () => {
    const err = classifyError(new Error("weird"), "ollama");
    expect(err.kind).toBe("provider");
    expect(err.message).toContain("[ollama]");
  });
});
