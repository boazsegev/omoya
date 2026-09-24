// Endpoint/endpoint-model grammar and last-used endpoint selection.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { Env } from "../lib/env.js";
import { listModelCandidates, readLastCombo, resolveModelCombo, selectEndpointModel, writeLastCombo } from "../lib/cli.js";

async function comboEnv() {
  const dir = mkdtempSync("./ai-tmp/cli-args-");
  const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {
    providers: {
      fake: { provider: "wire", url: "http://fake" },
      fake2: { provider: "wire", url: "http://fake2" },
    },
    fake: { models: { shared: null, "cached-1": null } },
    fake2: { models: { shared: null, "ns/lyricist:latest": null } },
  } });
  const liveCalls = [];
  class Wire {
    static provider = {};
    constructor(url, aiio) { this.url = url; this.aiio = aiio; }
    async models() {
      liveCalls.push(this.aiio);
      return { "live-1": null, "live-2": null };
    }
    async close() {}
  }
  env.registerProvider("wire", Wire);
  return { env, liveCalls };
}

describe("resolveModelCombo", () => {
  test("explicit endpoint/model splits only at the first slash", async () => {
    const { env, liveCalls } = await comboEnv();
    expect(await resolveModelCombo("fake2/x/y:z", env)).toEqual({ endpoint: "fake2", model: "x/y:z" });
    expect(liveCalls).toHaveLength(0);
  });

  test("a cached model selects the first public endpoint that lists it", async () => {
    const { env } = await comboEnv();
    expect(await resolveModelCombo("shared", env)).toEqual({ endpoint: "fake", model: "shared" });
    expect(await resolveModelCombo("ns/lyricist:latest", env)).toEqual({ endpoint: "fake2", model: "ns/lyricist:latest" });
  });

  test("an endpoint alone refreshes its models and empty suffix means endpoint alone", async () => {
    const { env, liveCalls } = await comboEnv();
    expect(await resolveModelCombo("fake2", env)).toEqual({ endpoint: "fake2", model: "live-1" });
    expect(await resolveModelCombo("fake2/", env)).toEqual({ endpoint: "fake2", model: "live-1" });
    expect(liveCalls).toHaveLength(2);
  });

  test("an unknown model remains bare and malformed input is rejected", async () => {
    const { env } = await comboEnv();
    expect(await resolveModelCombo("my-fine-tune", env)).toEqual({ model: "my-fine-tune" });
    await expect(resolveModelCombo("", env)).rejects.toThrow("must not be empty");
    await expect(resolveModelCombo("/x", env)).rejects.toThrow("empty endpoint");
  });
});

describe("selectEndpointModel: explicit provider with invocation-only URL", () => {
  test("keeps suffixes without persisting an endpoint configuration", async () => {
    const { env } = await comboEnv();
    expect(env.endpoint("wire")).toBeUndefined();

    expect(await selectEndpointModel(env, { model: "wire/m", url: "http://temporary" }))
      .toEqual({ endpoint: "wire", model: "m" });
    expect(await selectEndpointModel(env, { model: "wire/org/model", url: "http://temporary" }))
      .toEqual({ endpoint: "wire", model: "org/model" });
    expect(existsSync(`${env.dir}/last-model.json`)).toBe(false);
  });

  test("an empty suffix remains endpoint-only selection", async () => {
    const { env } = await comboEnv();
    expect(await selectEndpointModel(env, { model: "wire/", url: "http://temporary" }))
      .toEqual({ endpoint: "wire", model: "live-1" });
  });
});

describe("published model candidates", () => {
  test("contain public endpoint/model forms but omit secret entries", async () => {
    const { env } = await comboEnv();
    env.endpoints.hidden = { provider: "wire", url: "test://hidden", secret: true };
    env.authSet("hidden", { models: { "hidden-model": null } });
    const candidates = listModelCandidates(env);
    expect(candidates).toEqual(expect.arrayContaining(["fake", "fake2", "shared", "fake/cached-1", "fake2/ns/lyricist:latest"]));
    expect(candidates.join(" ")).not.toContain("hidden");
  });
});

describe("last-used endpoint/model persistence", () => {
  test("round-trips an endpoint/model pair and skips identical writes", async () => {
    const { env } = await comboEnv();
    expect(readLastCombo(env)).toBeNull();
    writeLastCombo(env, { endpoint: "fake2", model: "ns/lyricist:latest" });
    expect(readLastCombo(env)).toEqual({ endpoint: "fake2", model: "ns/lyricist:latest" });
    expect(JSON.parse(readFileSync(`${env.dir}/last-model.json`, "utf8"))).toEqual({ endpoint: "fake2", model: "ns/lyricist:latest" });
    const { statSync } = await import("node:fs");
    const before = statSync(`${env.dir}/last-model.json`).mtimeMs;
    writeLastCombo(env, { endpoint: "fake2", model: "ns/lyricist:latest" });
    expect(statSync(`${env.dir}/last-model.json`).mtimeMs).toBe(before);
  });

  test("Env treats an unavailable last model exactly like a missing file", async () => {
    const { env } = await comboEnv();
    expect(env.lastModel()).toBeNull();
    writeFileSync(`${env.dir}/last-model.json`, JSON.stringify({ endpoint: "fake", model: "removed" }));
    expect(env.lastModel()).toBeNull();
    expect(readLastCombo(env)).toBeNull();
    await expect(selectEndpointModel(env, {}, { lastUsed: true })).resolves.toEqual({ endpoint: undefined, model: undefined });
  });

  test("does not persist model-only records and ignores a record without an endpoint", async () => {
    const { env } = await comboEnv();
    writeFileSync(`${env.dir}/last-model.json`, JSON.stringify({ model: "m1" }));
    expect(readLastCombo(env)).toBeNull(); // invalid state behaves exactly like no saved selection
    writeFileSync(`${env.dir}/last-model.json`, "");
    writeLastCombo(env, { model: "m1" });
    expect(existsSync(`${env.dir}/last-model.json`)).toBe(true); // existing file is never deleted
    expect(readLastCombo(env)).toBeNull();
  });
});
