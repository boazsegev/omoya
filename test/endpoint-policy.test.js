// Endpoint `disabled` switch and the shared endpoint/model maxActive policy editor.
import { describe, expect, test } from "bun:test";
import { Context } from "../lib/context.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";
import { endpointPolicies, endpointPolicySet } from "../lib/app/shared/endpoint-policy.js";
import { listEndpointModels, listEndpoints, readLastCombo } from "../lib/app/shared/catalog.js";
import "../lib/agent.js"; // the Agent plugin publishes maxActive
import { buildMenuItems } from "../lib/app/tui/menu-data.js";
import { masterMenuOptions } from "../lib/app/tui/menu-sources.js";
import { resolveMenuAction } from "../lib/app/tui/menu-actions.js";
import { pushMenu, popMenu, refreshMenus } from "../lib/app/tui/overlay-controller.js";

/** Two endpoints over one stub provider, settings persisted in a temp folder. */
async function policyEnv(extra = {}) {
  const dir = mkdtempSync("./ai-tmp/endpoint-policy-");
  const packageDir = join(dir, "package");
  const settingsDir = join(dir, "settings");
  const projectDir = join(dir, "project");
  for (const folder of [packageDir, settingsDir, projectDir]) mkdirSync(folder);
  class Wire { static provider = {}; static async models() { return {}; } }
  writeFileSync(join(packageDir, "catalog.json"), JSON.stringify({
    maxActive: 5,
    providers: {
      one: { provider: "wire", url: "http://one", models: { a: { contextWindow: 1000 }, b: null }, ...extra },
      two: { provider: "wire", url: "http://two", models: { c: null } },
    },
  }));
  const env = await Env.open(projectDir, { dir: packageDir, settingsDir, providers: { wire: Wire } });
  await env.ready();
  return { env, dir: settingsDir };
}

/** Read the persisted user settings file after queued writes drain. */
async function persisted(env, dir) {
  await env.settingsFlush();
  return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
}

describe("endpoint disabled", () => {
  test("hides the endpoint's pairs, flags them in models(true), and refuses connections", async () => {
    const { env } = await policyEnv({ disabled: true });
    expect([...env.models().keys()]).toEqual(["two/c"]);
    expect(env.models(true).get("one/a").disabled).toBe(true);
    expect(env.models(true).get("two/c").disabled).toBe(false);
    expect(() => env.connection("one/a")).toThrow(/disabled/);
    expect(listEndpointModels(env).map((entry) => entry.name)).toEqual(["two"]);
    expect(listEndpoints(env)).toEqual(["one", "two"]); // logout still reaches it
  });

  test("endpoint and model menus sort alphabetically while retaining disabled settings endpoints", async () => {
    const dir = mkdtempSync("./ai-tmp/endpoint-order-");
    class Wire { static provider = {}; static async models() { return {}; } }
    const env = await Env.open(dir, { dir, settingsDir: dir, providers: { wire: Wire }, settings: {
      providers: {
        zebra: { provider: "wire", url: "http://zebra", disabled: true, models: { z: null, a: null } },
        alpha: { provider: "wire", url: "http://alpha", models: { z: null, a: null } },
      },
    } });
    await env.ready();
    expect(listEndpoints(env)).toEqual(["alpha", "zebra"]);
    expect(listEndpointModels(env)).toEqual([{ name: "alpha", models: ["a", "z"] }]);
  });

  test("the last-used pair on a disabled endpoint is skipped", async () => {
    const { env } = await policyEnv();
    await new Promise((resolve) => {
      const handle = env.onEvent(Env.EVENT.MODELS_CHANGED, () => {
        if (readLastCombo(env) !== "one/a") return;
        env.offEvent(handle);
        resolve();
      });
      env.connection("one/a");
    });
    expect(readLastCombo(env)).toBe("one/a");
    endpointPolicySet(env, "one", { disabled: true });
    expect(readLastCombo(env)).toBe(null);
  });

  test("an open IO refuses to write once its endpoint is disabled", async () => {
    const { env } = await policyEnv();
    const io = new IO({ env, model: "one/a", remember: false });
    endpointPolicySet(env, "one", { disabled: true });
    await expect(io.write(new Context({ messages: [{ type: "user", content: [{ type: "text", text: "hi" }] }] }), {})).rejects.toThrow(/disabled/);
  });

  test("toggles persist only the changed path; enabling removes the key", async () => {
    const { env, dir } = await policyEnv();
    endpointPolicySet(env, "one", { disabled: true });
    expect((await persisted(env, dir)).providers.one).toEqual({ disabled: true });
    expect(endpointPolicies(env).find((entry) => entry.name === "one").disabled).toBe(true);
    endpointPolicySet(env, "one", { disabled: false });
    await env.settingsFlush();
    expect(existsSync(join(dir, "settings.json"))).toBe(false); // last owned field deletes the file
    expect(env.connection("one/a", { remember: false }).endpoint).toBe("one");
    expect(() => endpointPolicySet(env, "one/a", { disabled: true })).toThrow(/endpoint, not a model/);
  });
});

describe("maxActive policy", () => {
  test("endpoint and model overrides persist, feed capacity, and keep model metadata", async () => {
    const { env, dir } = await policyEnv();
    endpointPolicySet(env, "one", { maxActive: 3 });
    endpointPolicySet(env, "one/a", { maxActive: 1 });
    expect((await persisted(env, dir)).providers.one).toEqual({ maxActive: 3, models: { a: { maxActive: 1 } } });
    const one = endpointPolicies(env).find((entry) => entry.name === "one");
    expect(one.maxActive).toBe(3);
    expect(one.models.find((model) => model.id === "a")).toEqual({ id: "a", maxActive: 1, effective: 1 });
    expect(env.models().get("one/b").maxActive).toBe(3);
    expect(env.connection("one/a", { remember: false }).settings.models.a).toEqual({ contextWindow: 1000, maxActive: 1 });
    endpointPolicySet(env, "one/b", { maxActive: false });
    expect(env.models().get("one/b").maxActive).toBe(0);
  });

  test("inherit deletes the override and prunes emptied model entries", async () => {
    const { env, dir } = await policyEnv();
    endpointPolicySet(env, "one/a", { maxActive: 2 });
    endpointPolicySet(env, "one/a", { maxActive: undefined });
    await env.settingsFlush();
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(endpointPolicies(env).find((entry) => entry.name === "one").models.find((model) => model.id === "a").maxActive).toBeUndefined();
  });

  test("TUI menu: Settings > Endpoints drills into toggles and max-active choices that rebuild in place", async () => {
    const { env } = await policyEnv();
    const row = buildMenuItems(masterMenuOptions({ thinking: undefined, can: { write: true, delegate: undefined } }, env, "one/a", { catalog: { sessions: [], prompts: [] } }))
      .find((item) => item.value?.type === "endpoint-policies");
    expect(row.label).toBe("Endpoints | disable · max active (2 endpoints)");
    const list = resolveMenuAction(row.value, env);
    expect(list.items.map((item) => item.label)).toContain("one | enabled · max active: inherit (5)");
    const endpoint = resolveMenuAction(list.items.find((item) => item.label.startsWith("one ")).value, env);
    let overlay = pushMenu(pushMenu(null, list.title, list.items, list.source), endpoint.title, endpoint.items, endpoint.source);
    const rebuild = (source) => resolveMenuAction(source, env).items;
    // toggle disabled: the action carries the change, the app applies it and rebuilds
    const toggle = resolveMenuAction(endpoint.items.find((item) => item.label.startsWith("disabled:")).value, env);
    expect(toggle).toEqual({ kind: "endpoint-policy", selector: "one", change: { disabled: true }, pop: false });
    endpointPolicySet(env, toggle.selector, toggle.change);
    overlay = refreshMenus(overlay, rebuild);
    expect(overlay.stack[0].items.map((item) => item.label)).toContain("one | disabled · max active: inherit (5)");
    expect(overlay.stack[1].items.find((item) => item.label.startsWith("disabled:")).label).toBe("disabled: on (hidden, refuses requests)  (toggle)");
    // model max active: choose 2, the choice level pops and the endpoint level shows it
    const modelRow = overlay.stack[1].items.find((item) => item.label.startsWith("a |"));
    const choices = resolveMenuAction(modelRow.value, env);
    overlay = pushMenu(overlay, choices.title, choices.items);
    const pick = resolveMenuAction(choices.items.find((item) => item.label === "2").value, env);
    expect(pick.pop).toBe(true);
    endpointPolicySet(env, pick.selector, pick.change);
    overlay = refreshMenus(popMenu(overlay), rebuild);
    expect(overlay.stack).toHaveLength(2);
    expect(overlay.stack[1].items.map((item) => item.label)).toContain("a | 2");
  });

  test("invalid values and unknown endpoints are refused", async () => {
    const { env } = await policyEnv();
    expect(() => endpointPolicySet(env, "one", { maxActive: -1 })).toThrow(/non-negative integer/);
    expect(() => endpointPolicySet(env, "one", { maxActive: 1.5 })).toThrow(/non-negative integer/);
    expect(() => endpointPolicySet(env, "nope", { maxActive: 1 })).toThrow(/unknown endpoint/);
    expect(() => endpointPolicySet(env, "one", { maxActive: 1, disabled: true })).toThrow(/exactly one/);
  });
});
