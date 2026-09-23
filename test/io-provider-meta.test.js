// test/io-provider-meta.test.js — proof for the provider metadata /
// models() / login() export shape, verified against pi's provider/auth
// pattern (auth.json credential store + models-store.json snapshot).
// Fixtures stand in for real connectors; the Ollama contract test
// re-asserts this shape against the real module.
import { describe, expect, test } from "bun:test";

/** Shape assertions shared by every provider module (pi pattern). */
function assertProviderMetaShape(mod) {
  // static id/capability metadata
  expect(mod.provider).toBeObject();
  expect(typeof mod.provider.name).toBe("string");
  expect(mod.provider.name.length).toBeGreaterThan(0);
  expect(typeof mod.provider.label).toBe("string");
  expect(mod.provider.capabilities).toBeObject();
  for (const flag of ["tools", "thinking", "streaming"]) {
    expect(typeof mod.provider.capabilities[flag]).toBe("boolean");
  }
}

function assertModelMapShape(models) {
  // the model list is a MAP: unique model names as keys, optional
  // pi-shaped metadata as values (null = no metadata)
  expect(models).toBeObject();
  expect(Array.isArray(models)).toBe(false);
  for (const [name, m] of Object.entries(models)) {
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
    if (m === null) continue;
    expect(m).toBeObject();
    if (m.label !== undefined) expect(typeof m.label).toBe("string");
    if (m.reasoning !== undefined) expect(typeof m.reasoning).toBe("boolean");
    if (m.input !== undefined) {
      expect(Array.isArray(m.input)).toBe(true);
      for (const modality of m.input) expect(typeof modality).toBe("string");
    }
    if (m.contextWindow !== undefined) {
      expect(typeof m.contextWindow).toBe("number");
    }
    if (m.maxTokens !== undefined) expect(typeof m.maxTokens).toBe("number");
    if (m.cost !== undefined) {
      for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
        if (m.cost[k] !== undefined) expect(typeof m.cost[k]).toBe("number");
      }
    }
  }
}

describe("provider metadata/models()/login() export shape (pi pattern)", () => {
  const fixture = {
    provider: {
      name: "fixture",
      label: "Fixture Provider",
      capabilities: { tools: true, thinking: false, streaming: true },
    },
    async models() {
      return {
        "fixture-1": {
          label: "Fixture One",
          reasoning: false,
          input: ["text"],
          contextWindow: 8192,
          maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      };
    },
    async login(aiio) {
      const auth = { type: "none" };
      aiio?.authSet?.(auth);
      return auth;
    },
  };

  test("static id/capability metadata shape", () => {
    assertProviderMetaShape(fixture);
  });

  test("models() returns a model map keyed by unique model name", async () => {
    expect(typeof fixture.models).toBe("function");
    const models = await fixture.models();
    expect(Object.keys(models).length).toBeGreaterThan(0);
    assertModelMapShape(models);
  });

  test("login(aiio) resolves an auth payload and may route authSet", async () => {
    expect(typeof fixture.login).toBe("function");
    const routed = [];
    const fakeAiio = { authSet: (a) => routed.push(a) };
    const auth = await fixture.login(fakeAiio);
    expect(auth).toEqual({ type: "none" });
    expect(routed).toEqual([{ type: "none" }]);
  });

  test("pi credential shapes are representable in auth payloads", () => {
    // pi auth.json: {type:"api_key",key} / {type:"oauth",access,refresh,expires}
    const apiKey = { type: "api_key", key: "sk-x" };
    const oauth = { type: "oauth", access: "a", refresh: "r", expires: 1 };
    for (const cred of [apiKey, oauth]) {
      expect(typeof cred.type).toBe("string");
      expect(["api_key", "oauth", "none"]).toContain(cred.type);
    }
  });

  test("auth payload and cached model map share the endpoint namespace", () => {
    // pi splits auth.json vs models-store.json; this project namespaces
    // both into auth-${endpoint}.json — assert the combined section shape.
    const section = {
      type: "none",
      models: { m1: { label: "M1" } },
    };
    expect(typeof section.type).toBe("string");
    assertModelMapShape(section.models);
  });
});
