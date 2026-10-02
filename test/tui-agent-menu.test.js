import { describe, expect, test } from "bun:test";
import { layoutView } from "../lib/app/gtui/layout.js";
import { createControls } from "../lib/app/gtui/controls.js";
import { activeAgentMenuOptions, addAgentMenuOptions, masterMenuOptions, modelMenuOptions } from "../lib/app/tui/menu-sources.js";
import { buildMenuItems, buildSessionAddItems, buildSessionAddModelItems, buildSessionCloseItems } from "../lib/app/tui/menu-data.js";
import { resolveMenuAction } from "../lib/app/tui/menu-actions.js";
import { openMenu, previewMenu } from "../lib/app/tui/overlay-controller.js";
import { overlayView } from "../lib/app/tui/overlay-view.js";

const agent = (name, parent, { busy = false, description = "" } = {}) => ({
  name, parent, description, ioState: busy ? "working" : "idle",
});

describe("active-agent menu snapshots", () => {
  test("reads Env once, groups children after their parent, and preserves duplicate names by identity", () => {
    const alpha = agent("alpha");
    const alphaFirst = agent("same", alpha, { busy: true, description: "First child." });
    const alphaSecond = agent("same", alpha);
    const beta = agent("beta");
    let reads = 0;
    const env = { agents: () => { reads++; return [beta, alphaSecond, alpha, alphaFirst]; } };

    const options = activeAgentMenuOptions(env, alpha);
    expect(reads).toBe(1);
    expect(options.map(({ agent: item }) => item)).toEqual([alpha, alphaSecond, alphaFirst, beta]);
    expect(options.map(({ current }) => current)).toEqual([true, false, false, false]);
    const items = buildMenuItems({ agents: options });
    expect(items.filter((item) => item.value?.type === "agent.switch")).toEqual([
      expect.objectContaining({ label: "alpha", role: "menu.text menu.current" }),
      expect.objectContaining({ label: "  same" }),
      expect.objectContaining({ label: "  same | 🟠 working", preview: { type: "agent-description", description: "First child." } }),
      expect.objectContaining({ label: "beta" }),
    ]);
  });

  test("sorts the full theme menu alphabetically, including default", () => {
    const env = { settings: { tui: { themes: { zebra: {}, amber: {}, blues: {} } } }, endpointNames: () => [], agents: () => [] };
    const options = masterMenuOptions({ thinking: "default", safe: false }, env, "(none)/(none)", { catalog: { sessions: [], prompts: [] } });
    expect(options.themes).toEqual(["amber", "blues", "default", "zebra"]);
  });

  test("stores the active-agent snapshot in the menu data instead of reading it during redraw", () => {
    const first = agent("first");
    const second = agent("second");
    let next = [first];
    const env = { agents: () => next, prompts: () => new Map(), toolNames: () => [], endpointNames: () => [] };
    const current = { thinking: undefined, safe: false, listSessions: () => [] };
    const options = masterMenuOptions(current, env, "(none)/(none)");
    next = [second];
    expect(buildMenuItems(options).some((item) => item.label === "first")).toBe(true);
    expect(buildMenuItems(options).some((item) => item.label === "second")).toBe(false);
  });

  test("snapshots endpoint and model availability for Add menus", () => {
    // the catalog's pair entries carry capacity (Agent's modelInfo fields)
    const catalog = new Map([
      ["ollama/llama", { endpoint: "ollama", model: "llama", listed: true, maxActive: 3, available: 2 }],
      ["ollama/qwen", { endpoint: "ollama", model: "qwen", listed: true, maxActive: 0, available: 0 }],
    ]);
    const env = { models: () => catalog };
    const providers = addAgentMenuOptions(env);
    expect(providers).toEqual([{
      name: "ollama", available: 2, limit: 3, excluded: false,
      models: [
        { id: "llama", available: 2, limit: 3, excluded: false },
        { id: "qwen", available: 0, limit: 0, excluded: true },
      ],
    }]);
    expect(buildSessionAddItems({ providers })).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "ollama | 2/3 available", value: { type: "session-add-provider", endpoint: "ollama", models: providers[0].models } }),
    ]));
    expect(buildSessionAddModelItems({ endpoint: "ollama", models: providers[0].models })).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "llama | 2/3 available", value: { type: "session-add", endpoint: "ollama", model: "llama" } }),
      expect.objectContaining({ kind: "info", label: "qwen | 0/0 available" }),
    ]));
  });

  test("model menu uses the endpoint portion of a qualified Agent.model", () => {
    const env = { models: () => new Map([["p/group/m", { endpoint: "p", model: "group/m", listed: true }]]) };
    expect(modelMenuOptions({ model: "p/group/m" }, env)).toEqual({ value: "p", models: ["group/m"] });
    expect(modelMenuOptions({ model: undefined }, env)).toBeNull();
  });

  test("offers a Close submenu with a frozen active-agent target list", () => {
    const current = agent("current");
    const other = agent("other", undefined, { busy: true });
    const agents = [{ agent: current, current: true }, { agent: other, current: false, busy: true }];
    const close = buildMenuItems({ agents }).find((entry) => entry.label === "Close | 2 active sessions");
    const submenu = resolveMenuAction(close.value);
    expect(submenu.kind).toBe("push");
    expect(submenu.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "current (current)", value: { type: "agent.close", agent: current } }),
      expect.objectContaining({ label: "other | 🟠 working", value: { type: "agent.close", agent: other } }),
    ]));
    expect(buildSessionCloseItems({ agents })).toEqual(submenu.items);
  });

  test("opens a delegation permission submenu with all three choices", () => {
    const item = buildMenuItems({ spawnPermission: "custom" }).find((entry) => entry.label === "Allow to Delegate | Ask");
    const submenu = resolveMenuAction(item.value);
    expect(submenu.kind).toBe("push");
    expect(submenu.items.map(({ label }) => label)).toEqual(["Allow to Delegate", "← back", "Allow", "Deny", "Ask (current)"]);
    expect(submenu.items.slice(2).map(({ value }) => value.value)).toEqual([true, false, "Ask"]);
  });

  test("dims the current session", () => {
    const current = agent("current");
    const other = agent("other");
    const scene = layoutView(overlayView(openMenu("Menu", buildMenuItems({ agents: [
      { agent: current, current: true }, { agent: other, current: false },
    ] })), []), { width: 80, height: 20, controls: createControls(() => {}) });
    expect(scene.snapshot.roles.some(({ role }) => role === "menu.text menu.current")).toBe(true);
  });

  test("shows a highlighted agent description at the menu top right only", () => {
    const overlay = previewMenu(openMenu("Menu", [{ kind: "action", label: "worker", preview: { type: "agent-description", description: "Owns the database." } }]), { type: "agent-description", description: "Owns the database." });
    const scene = layoutView(overlayView(overlay, []), { width: 80, height: 20 });
    expect(scene.snapshot.lines[1]).toContain("Owns the database.");
    const plain = layoutView(overlayView(openMenu("Menu", [{ kind: "action", label: "worker" }]), []), { width: 80, height: 20 });
    expect(plain.snapshot.lines.join("\n")).not.toContain("Owns the database.");
  });
});
