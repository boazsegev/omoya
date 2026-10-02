// Endpoint/endpoint-model grammar and last-used endpoint selection.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { Env } from "../lib/env.js";
import { listModelCandidates, readLastCombo, resolveModelCombo, selectEndpointModel } from "../lib/cli.js";
import { authSetOf, detect, dynamic, endpointOf, lastPair, providerAdd, remember } from "./env-internals.js";

/** Two wire endpoints over one stub provider; `collect` runs Env's
 *  background model collection (Env.create) and awaits its first pass. */
async function comboEnv({ collect = false } = {}) {
  const dir = mkdtempSync("./ai-tmp/cli-args-");
  const liveCalls = [];
  class Wire {
    static provider = {};
    static async models(options) {
      liveCalls.push(options);
      return { "live-1": null, "live-2": null };
    }
  }
  const options = { dir, cwd: dir, settingsDir: dir, providers: { wire: Wire }, settings: {
    providers: {
      fake: { provider: "wire", url: "http://fake" },
      fake2: { provider: "wire", url: "http://fake2" },
    },
    fake: { models: { shared: null, "cached-1": null } },
    fake2: { models: { shared: null, "ns/lyricist:latest": null } },
  } };
  const env = collect ? await Env.create(options, { tools: false, detect: false }) : new Env(options);
  await env.modelsReady;
  return { env, liveCalls };
}

describe("resolveModelCombo", () => {
  test("explicit endpoint/model retains slash-containing model IDs unchanged", async () => {
    const { env, liveCalls } = await comboEnv();
    expect(await resolveModelCombo("fake2/x/y:z", env)).toEqual("fake2/x/y:z");
    expect(liveCalls).toHaveLength(0);
  });

  test("a cached model selects the first public endpoint that lists it", async () => {
    const { env } = await comboEnv();
    expect(await resolveModelCombo("shared", env)).toEqual("fake/shared");
    expect(await resolveModelCombo("ns/lyricist:latest", env)).toEqual("fake2/ns/lyricist:latest");
  });

  test("an endpoint alone takes its first collected model; an empty suffix means endpoint alone", async () => {
    const { env, liveCalls } = await comboEnv({ collect: true });
    expect(liveCalls).toHaveLength(2); // the background collection asked each endpoint once
    expect(await resolveModelCombo("fake2", env)).toEqual("fake2/live-1");
    expect(await resolveModelCombo("fake2/", env)).toEqual("fake2/live-1");
    expect(liveCalls).toHaveLength(2); // selection reads the catalog, never drives a refresh
  });

  test("without collection an endpoint alone takes its first cached model", async () => {
    const { env } = await comboEnv();
    expect(await resolveModelCombo("fake2", env)).toEqual("fake2/shared");
  });

  test("an unknown model remains unresolved and malformed input is rejected", async () => {
    const { env } = await comboEnv();
    expect(await resolveModelCombo("my-fine-tune", env)).toBeUndefined();
    await expect(resolveModelCombo("", env)).rejects.toThrow("must not be empty");
    await expect(resolveModelCombo("/x", env)).rejects.toThrow("empty endpoint");
  });
});

describe("selectEndpointModel: explicit provider with invocation-only URL", () => {
  test("keeps suffixes without persisting an endpoint configuration", async () => {
    const { env } = await comboEnv();
    expect(endpointOf(env, "wire")).toBeUndefined();

    expect(await selectEndpointModel(env, { model: "wire/m", url: "http://temporary" }))
      .toEqual("wire/m");
    expect(await selectEndpointModel(env, { model: "wire/org/model", url: "http://temporary" }))
      .toEqual("wire/org/model");
    expect(existsSync(`${env._dir}/last-model.json`)).toBe(false);
  });

  test("an empty suffix remains endpoint-only selection", async () => {
    const { env } = await comboEnv();
    // an invocation-only endpoint (an in-memory login): its list is fetched on demand
    expect(await selectEndpointModel(env, { model: "wire/", url: "http://temporary" }))
      .toEqual("wire/live-1");
  });
});

describe("published model candidates", () => {
  test("contain public endpoint/model forms but omit secret entries", async () => {
    const { env } = await comboEnv();
    env._endpoints.hidden = { provider: "wire", url: "test://hidden", secret: true };
    authSetOf(env, "hidden", { models: { "hidden-model": null } });
    const candidates = listModelCandidates(env);
    expect(candidates).toEqual(expect.arrayContaining(["fake", "fake2", "shared", "fake/cached-1", "fake2/ns/lyricist:latest"]));
    expect(candidates.join(" ")).not.toContain("hidden");
  });
});

describe("last-used endpoint/model persistence", () => {
  test("round-trips an endpoint/model pair and refreshes its timestamp", async () => {
    const { env } = await comboEnv();
    expect(readLastCombo(env)).toBeNull();
    remember(env, { endpoint: "fake2", model: "ns/lyricist:latest" });
    expect(readLastCombo(env)).toEqual("fake2/ns/lyricist:latest");
    const entries = JSON.parse(readFileSync(`${env._dir}/last-model.json`, "utf8"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ endpoint: "fake2", model: "ns/lyricist:latest" });
    expect(Number.isNaN(Date.parse(entries[0].ts))).toBe(false);
    // a repeated selection refreshes the timestamp instead of duplicating
    remember(env, { endpoint: "fake2", model: "ns/lyricist:latest" });
    const again = JSON.parse(readFileSync(`${env._dir}/last-model.json`, "utf8"));
    expect(again).toHaveLength(1);
    expect(Date.parse(again[0].ts)).toBeGreaterThanOrEqual(Date.parse(entries[0].ts));
  });

  test("startup walks history when endpoints disappear or return", async () => {
    const { env } = await comboEnv();
    let isDetected = true;
    class AmbientWire {
      static provider = {};
      static async detect() {
        return isDetected ? {
          ambient: { provider: "ambientwire", url: "http://ambient", dynamic: true, models: { "ambient-m": null } },
        } : {};
      }
    }
    providerAdd(env, "ambientwire", AmbientWire);
    await detect(env);
    expect(dynamic(env, "ambient")).toBe(true);
    writeFileSync(`${env._dir}/last-model.json`, JSON.stringify([
      { endpoint: "removed", model: "old-m", ts: "2026-09-28T12:00:00.000Z" },
      { endpoint: "ambient", model: "ambient-m", ts: "2026-09-28T11:00:00.000Z" },
      { endpoint: "fake2", model: "ns/lyricist:latest", ts: "2026-09-28T10:00:00.000Z" },
    ]));
    expect(lastPair(env)).toBe("ambient/ambient-m");
    await expect(selectEndpointModel(env, {}, { lastUsed: true }))
      .resolves.toEqual("ambient/ambient-m");
    isDetected = false;
    await detect(env);
    await expect(selectEndpointModel(env, {}, { lastUsed: true }))
      .resolves.toEqual("fake2/ns/lyricist:latest");
    isDetected = true;
    await detect(env);
    await expect(selectEndpointModel(env, {}, { lastUsed: true }))
      .resolves.toEqual("ambient/ambient-m");
  });

  test("Env treats an unavailable last model exactly like a missing file", async () => {
    const { env } = await comboEnv();
    expect(lastPair(env)).toBeNull();
    writeFileSync(`${env._dir}/last-model.json`, JSON.stringify({ endpoint: "fake", model: "removed" }));
    expect(lastPair(env)).toBeNull();
    expect(readLastCombo(env)).toBeNull();
    await expect(selectEndpointModel(env, {}, { lastUsed: true })).resolves.toBeUndefined();
  });

  test("does not persist model-only records and ignores a record without an endpoint", async () => {
    const { env } = await comboEnv();
    writeFileSync(`${env._dir}/last-model.json`, JSON.stringify({ model: "m1" }));
    expect(readLastCombo(env)).toBeNull(); // invalid state behaves exactly like no saved selection
    writeFileSync(`${env._dir}/last-model.json`, "");
    remember(env, { model: "m1" });
    expect(existsSync(`${env._dir}/last-model.json`)).toBe(true); // existing file is never deleted
    expect(readLastCombo(env)).toBeNull();
  });
});
