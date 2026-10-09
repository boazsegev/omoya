// Endpoint/endpoint-model grammar and last-used endpoint selection.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { Env } from "../lib/env.js";
import { listModelCandidates, readLastCombo } from "../lib/app/shared/catalog.js";
import { resolveModelCombo } from "../lib/app/shared/model-select.js";
import CLI, { selectEndpointModel } from "../lib/app/cli.js";

test("CLI does not publish catalog and endpoint-policy projections", async () => {
  const named = await import("../lib/app/cli.js");
  for (const name of ["readLastCombo", "resolveModelCombo", "listModelCandidates", "listEndpoints", "listEndpointModels", "listModels", "endpointPolicies", "endpointPolicySet", "execute"]) {
    expect(Object.hasOwn(CLI, name)).toBe(false);
    expect(Object.hasOwn(named, name)).toBe(false);
  }
});
import { detect, dynamic, providerAdd } from "./env-internals.js";

/** Await the catalog notification that follows an asynchronous history write. */
function rememberPair(env, selector) {
  const previous = env.models(true).get(selector)?.lastUsed;
  return new Promise((resolve) => {
    const handle = env.onEvent(Env.EVENT.MODELS_CHANGED, () => {
      const current = env.models(true).get(selector)?.lastUsed;
      if (current == null || current === previous) return;
      env.offEvent(handle);
      resolve();
    });
    env.connection(selector);
  });
}

/** Read a history fixture through a fresh Env, then await its catalog arrival. */
async function reopenWithHistory({ env, dir, options }, records, expected) {
  await env.close();
  writeFileSync(`${dir}/last-model.json`, JSON.stringify(records));
  const { cwd, ...envOptions } = options;
  const fresh = await Env.open(cwd, envOptions);
  await new Promise((resolve) => {
    const handle = fresh.onEvent(Env.EVENT.MODELS_CHANGED, () => {
      if (readLastCombo(fresh) !== expected) return;
      fresh.offEvent(handle);
      resolve();
    });
    if (readLastCombo(fresh) === expected) { fresh.offEvent(handle); resolve(); }
  });
  return fresh;
}

/** Two wire endpoints over one stub provider; `collect` runs Env's
 *  background model collection (Env.open) and awaits its first pass. */
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
      fake: { provider: "wire", url: "http://fake", models: { shared: null, "cached-1": null } },
      fake2: { provider: "wire", url: "http://fake2", models: { shared: null, "ns/lyricist:latest": null } },
    },
  } };
  const env = await Env.open(dir, { dir, settingsDir: dir, providers: options.providers, settings: options.settings, init: { providers: collect, tools: false, detect: false, models: collect } });
  await env.ready();
  await env.modelsReady;
  return { env, liveCalls, dir, options };
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

  test("without collection an endpoint alone takes its alphabetically first cached model", async () => {
    const { env } = await comboEnv();
    expect(await resolveModelCombo("fake2", env)).toEqual("fake2/ns/lyricist:latest");
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
    expect(() => env.connection("wire/m", { remember: false })).toThrow(/unknown endpoint/);

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
    env.settings.providers.hidden = { provider: "wire", url: "test://hidden", secret: true, models: { "hidden-model": null } };
    expect(env.models(true).get("hidden/hidden-model").secret).toBe(true);
    const candidates = listModelCandidates(env);
    expect(candidates).toEqual(expect.arrayContaining(["fake", "fake2", "shared", "fake/cached-1", "fake2/ns/lyricist:latest"]));
    expect(candidates.join(" ")).not.toContain("hidden");
  });
});

describe("last-used endpoint/model persistence", () => {
  test("round-trips an endpoint/model pair and refreshes its timestamp", async () => {
    const { env } = await comboEnv();
    expect(readLastCombo(env)).toBeNull();
    await rememberPair(env, "fake2/ns/lyricist:latest");
    expect(readLastCombo(env)).toEqual("fake2/ns/lyricist:latest");
    await env.settingsFlush();
    const entries = JSON.parse(readFileSync(`${env._dir}/last-model.json`, "utf8"));
    expect(Object.keys(entries)).toEqual(["fake2/ns/lyricist:latest"]);
    expect(Number.isNaN(Date.parse(entries["fake2/ns/lyricist:latest"]))).toBe(false);
    // a repeated selection refreshes the timestamp instead of duplicating
    await rememberPair(env, "fake2/ns/lyricist:latest");
    await env.settingsFlush();
    const again = JSON.parse(readFileSync(`${env._dir}/last-model.json`, "utf8"));
    expect(Object.keys(again)).toEqual(["fake2/ns/lyricist:latest"]);
    expect(Date.parse(again["fake2/ns/lyricist:latest"])).toBeGreaterThanOrEqual(Date.parse(entries["fake2/ns/lyricist:latest"]));
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
    await rememberPair(env, "fake2/ns/lyricist:latest");
    await rememberPair(env, "ambient/ambient-m");
    expect(readLastCombo(env)).toBe("ambient/ambient-m");
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

  test("Env treats unavailable history exactly like a missing file", async () => {
    const seed = await comboEnv();
    expect(readLastCombo(seed.env)).toBeNull();
    const env = await reopenWithHistory(seed, { "fake/removed": "2026-09-28T12:00:00.000Z" }, null);
    expect(readLastCombo(env)).toBeNull();
    await expect(selectEndpointModel(env, {}, { lastUsed: true })).resolves.toBeUndefined();
  });

  test("startup skips unavailable endpoints and models in history", async () => {
    const seed = await comboEnv();
    expect(readLastCombo(seed.env)).toBeNull();
    const env = await reopenWithHistory(seed, {
      "gone/m1": "2026-09-28T12:00:00.000Z",
      "fake/removed": "2026-09-28T11:00:00.000Z",
      "fake2/shared": "2026-09-28T10:00:00.000Z",
    }, "fake2/shared");
    expect(env.models().get("fake/shared").lastUsed).toBeNull();
    await expect(selectEndpointModel(env, {}, { lastUsed: true })).resolves.toBe("fake2/shared");
  });

  test("does not persist model-only records and ignores history without an endpoint", async () => {
    const seed = await comboEnv();
    const records = { m1: "2026-09-28T12:00:00.000Z", "fake2/shared": "2026-09-28T10:00:00.000Z" };
    const env = await reopenWithHistory(seed, records, "fake2/shared");
    expect(() => env.connection("m1")).toThrow(/<endpoint>\/<model>/);
    expect(JSON.parse(readFileSync(`${seed.dir}/last-model.json`, "utf8"))).toEqual(records);
    expect(readLastCombo(env)).toBe("fake2/shared");
    expect(env.models().get("fake/shared").lastUsed).toBeNull();
  });
});
