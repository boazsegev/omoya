// Provider plugins are standalone classes completed with OpenAI defaults.
import { describe, expect, test } from "bun:test";
import { defineProvider, classifyError, ProviderError } from "../lib/io.js";

class EmptyProtocol {}

describe("defineProvider class completion", () => {
  test("construction replaces connect and missing methods get OpenAI defaults", () => {
    const Protocol = defineProvider(EmptyProtocol, { name: "p1" });
    const aiio = { settings: {}, tools: () => [] };
    const connection = new Protocol("https://example.test/v1", aiio);
    expect(connection.baseUrl).toBe("https://example.test/v1");
    expect(connection.url).toBe("https://example.test/v1/responses");
    for (const method of ["context2msg", "msg2events", "send", "read", "close", "models", "login"]) {
      expect(typeof connection[method], method).toBe("function");
    }
    expect(typeof Protocol.detectEndpoints).toBe("function");
  });

  test("custom constructor and methods are retained", async () => {
    const read = async function () { return this.marker; };
    class CustomProtocol {
      static provider = { label: "Custom", vendor: "acme", capabilities: { tools: true } };
      constructor(url, aiio) { this.baseUrl = url; this.aiio = aiio; this.marker = "custom"; }
      read = read;
      async close() { this.closedByCustom = true; }
    }
    const Protocol = defineProvider(CustomProtocol, { name: "custom" });
    const connection = new Protocol("tcp://host", {});
    expect(await connection.read()).toBe("custom");
    await connection.close();
    expect(connection.closedByCustom).toBe(true);
    expect(Protocol.provider).toEqual({
      name: "custom",
      label: "Custom",
      vendor: "acme",
      capabilities: { tools: true, thinking: false, streaming: false },
    });
  });

  test("metadata defaults to basename and all-false capabilities", () => {
    const Protocol = defineProvider(class {}, { name: "plain" });
    expect(Protocol.provider).toEqual({
      name: "plain",
      label: "plain",
      capabilities: { tools: false, thinking: false, streaming: false },
    });
  });

  test("a missing endpoint detector is a no-op", async () => {
    const Protocol = defineProvider(class {}, { name: "quiet" });
    expect(await Protocol.detectEndpoints({})).toEqual({});
  });

  test("invalid plugins or missing basename are contract errors", () => {
    expect(() => defineProvider({}, { name: "x" })).toThrow(/default-export a class/);
    expect(() => defineProvider(class {})).toThrow(/basename\/name required/);
    expect(() => defineProvider(null, { name: "x" })).toThrow(TypeError);
  });

  test("default models() falls back to the endpoint cache", async () => {
    const Protocol = defineProvider(class {}, { name: "p6" });
    const models = { m1: null };
    const connection = new Protocol("http://127.0.0.1:1/v1", {
      settings: { models },
      requestSignal: AbortSignal.timeout(20),
    });
    expect(await connection.models()).toEqual(models);
  });

  test("default login() is a classified auth error without a token", async () => {
    const Protocol = defineProvider(class {}, { name: "p7" });
    const connection = new Protocol("https://example.test/v1", { settings: {} });
    await expect(connection.login()).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("classifyError taxonomy", () => {
  test("ProviderError passes through unchanged", () => {
    const original = new ProviderError("malformed", "bad");
    expect(classifyError(original)).toBe(original);
  });

  test("HTTP 401/403 -> auth; other statuses -> provider", () => {
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
