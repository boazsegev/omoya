// Endpoint `disabled` switch and the shared endpoint/model maxActive policy editor.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";
import { endpointPolicies, endpointPolicySet, listEndpointModels, listEndpoints, readLastCombo } from "../lib/cli.js";
import "../lib/agent.js"; // the Agent plugin publishes maxActive
import { buildMenuItems } from "../lib/app/tui/menu-data.js";
import { masterMenuOptions } from "../lib/app/tui/menu-sources.js";
import { resolveMenuAction } from "../lib/app/tui/menu-actions.js";
import { pushMenu, popMenu, refreshMenus } from "../lib/app/tui/overlay-controller.js";

/** Two endpoints over one stub provider, settings persisted in a temp folder. */
function policyEnv(extra = {}) {
  const dir = mkdtempSync("./ai-tmp/endpoint-policy-");
  class Wire { static provider = {}; static async models() { return {}; } }
  const env = new Env({ dir, cwd: dir, settingsDir: dir, providers: { wire: Wire }, settings: {
    maxActive: 5,
    providers: {
      one: { provider: "wire", url: "http://one", ...extra },
      two: { provider: "wire", url: "http://two" },
    },
    one: { models: { a: { contextWindow: 1000 }, b: null } },
    two: { models: { c: null } },
  } });
  return { env, dir };
}

/** Read the persisted user settings file after the coalesced write lands. */
function persisted(env, dir) {
  env._writeQueue.drain();
  return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
}

describe("endpoint disabled", () => {
  test("hides the endpoint's pairs, flags them in models(true), and refuses connections", () => {
    const { env } = policyEnv({ disabled: true });
    expect([...env.models().keys()]).toEqual(["two/c"]);
    expect(env.models(true).get("one/a").disabled).toBe(true);
    expect(env.models(true).get("two/c").disabled).toBe(false);
    expect(() => env.connection("one/a")).toThrow(/disabled/);
    expect(listEndpointModels(env).map((entry) => entry.name)).toEqual(["two"]);
    expect(listEndpoints(env)).toEqual(["one", "two"]); // logout still reaches it
  });

  test("the last-used pair on a disabled endpoint is skipped", () => {
    const { env } = policyEnv();
    env.connection("one/a"); // remember
    expect(readLastCombo(env)).toBe("one/a");
    endpointPolicySet(env, "one", { disabled: true });
    expect(readLastCombo(env)).toBe(null);
  });

  test("an open IO refuses to write once its endpoint is disabled", async () => {
    const { env } = policyEnv();
    const io = new IO({ env, model: "one/a", remember: false });
    endpointPolicySet(env, "one", { disabled: true });
    await expect(io.write([{ type: "user", content: [{ type: "text", text: "hi" }] }], {})).rejects.toThrow(/disabled/);
  });

  test("toggles persist only the changed path; enabling removes the key", () => {
    const { env, dir } = policyEnv();
    endpointPolicySet(env, "one", { disabled: true });
    expect(persisted(env, dir).providers.one).toEqual({ disabled: true });
    expect(endpointPolicies(env).find((entry) => entry.name === "one").disabled).toBe(true);
    endpointPolicySet(env, "one", { disabled: false });
    expect(persisted(env, dir).providers.one).toEqual({});
    expect(env.connection("one/a", { remember: false }).endpoint).toBe("one");
    expect(() => endpointPolicySet(env, "one/a", { disabled: true })).toThrow(/endpoint, not a model/);
  });
});

describe("maxActive policy", () => {
  test("endpoint and model overrides persist, feed capacity, and keep model metadata", () => {
    const { env, dir } = policyEnv();
    endpointPolicySet(env, "one", { maxActive: 3 });
    endpointPolicySet(env, "one/a", { maxActive: 1 });
    expect(persisted(env, dir).providers.one).toEqual({ maxActive: 3, models: { a: { maxActive: 1 } } });
    const one = endpointPolicies(env).find((entry) => entry.name === "one");
    expect(one.maxActive).toBe(3);
    expect(one.models.find((model) => model.id === "a")).toEqual({ id: "a", maxActive: 1, effective: 1 });
    expect(env.models().get("one/b").maxActive).toBe(3);
    expect(env.connection("one/a", { remember: false }).settings.models.a).toEqual({ contextWindow: 1000, maxActive: 1 });
    endpointPolicySet(env, "one/b", { maxActive: false });
    expect(env.models().get("one/b").maxActive).toBe(0);
  });

  test("inherit deletes the override and prunes emptied model entries", () => {
    const { env, dir } = policyEnv();
    endpointPolicySet(env, "one/a", { maxActive: 2 });
    endpointPolicySet(env, "one/a", { maxActive: undefined });
    expect(persisted(env, dir).providers.one).toEqual({});
    expect(endpointPolicies(env).find((entry) => entry.name === "one").models.find((model) => model.id === "a").maxActive).toBeUndefined();
  });

  test("TUI menu: Settings > Endpoints drills into toggles and max-active choices that rebuild in place", () => {
    const { env } = policyEnv();
    const row = buildMenuItems(masterMenuOptions({ thinking: undefined, safe: false }, env, "one/a", { catalog: { sessions: [], prompts: [] } }))
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

  test("invalid values and unknown endpoints are refused", () => {
    const { env } = policyEnv();
    expect(() => endpointPolicySet(env, "one", { maxActive: -1 })).toThrow(/non-negative integer/);
    expect(() => endpointPolicySet(env, "one", { maxActive: 1.5 })).toThrow(/non-negative integer/);
    expect(() => endpointPolicySet(env, "nope", { maxActive: 1 })).toThrow(/unknown endpoint/);
    expect(() => endpointPolicySet(env, "one", { maxActive: 1, disabled: true })).toThrow(/exactly one/);
  });
});
