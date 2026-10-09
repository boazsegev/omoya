import { describe, expect, test } from "bun:test";
import { buildAccessRoot, buildAccessItems, buildActionSearch, terminalSettingAllowed } from "../lib/app/tui/access-menu.js";
import { cursorStyle } from "../lib/app/gtui/term.js";
import { resolveMenuAction } from "../lib/app/tui/menu-actions.js";

function actions(items) {
  return items.filter((row) => row.kind === "action" && row.value.type !== "back");
}

function values(items, type) {
  return actions(items).filter((row) => row.value.type === type).map((row) => row.value);
}

function fixture() {
  const env = { folder: "/work/alpha", name: "alpha", settings: { tui: { alt: false, mouse: false, osc52: true, scroll: { show: true }, cursor: { shape: "block", blink: 900 } } } };
  const agent = { name: "same", env, context: { id: "session-alpha", save: true }, can: { write: true, delegate: undefined, request: false } };
  const other = { name: "same", env: { folder: "/work/beta", name: "beta" } };
  const sessions = [
    { id: "session-alpha", name: "Alpha chat", preview: "A design conversation", mtime: "2026-10-24T12:30:00Z", messages: 4, project: env.folder, projectName: "alpha", env, live: agent },
    { id: "session-beta", preview: "An offline conversation", mtime: "2026-10-23T08:15:00Z", messages: 7, project: "/work/beta", projectName: "beta" },
  ];
  return {
    agent, currentEnv: env,
    personalSettings: { tui: { alt: true, mouse: undefined, osc52: false, scroll: { show: false }, cursor: { shape: "line", blink: 610 } } },
    projects: [
      { path: env.folder, name: "alpha", description: "Current project", groups: ["shared"], pinned: true, open: true, current: true },
      { path: "/work/beta", name: "beta", description: "Other project", groups: ["other"], pinned: false, open: false, current: false },
    ],
    agents: [{ agent, name: "alpha/same", current: true }, { agent: other, name: "beta/same", child: true, busy: true, description: "Other worker" }],
    savedSessions: sessions,
    providers: [{ name: "provider", models: ["fast", "provider/deep"] }, { name: "locked", models: [], loginRequired: true }],
    endpoints: ["provider"], currentModel: "provider/fast",
    thinkingLevels: ["default", "low", "high"], thinkingLevel: "low",
    themes: ["default", "night"], theme: "night",
    commands: ["/help", "/context-edit"], prompts: ["review"],
    tools: [{ name: "tool-read", schema: { description: "Read a path", type: "object", required: ["path"], properties: { path: { type: "string" } } } }],
    endpointPolicies: [{ name: "provider", disabled: false, maxActive: 3, effective: 3, models: [{ id: "fast", effective: 3 }] }],
  };
}

describe("declarative access root", () => {
  test("puts themes, live agents and endpoint selection directly on the root", () => {
    const options = fixture();
    const root = buildAccessRoot(options);
    expect(values(root, "themes")).toEqual([{ type: "themes", themes: ["default", "night"], value: "night" }]);
    expect(values(root, "agent.switch").map(({ agent }) => agent)).toEqual(options.agents.map(({ agent }) => agent));
    expect(values(root, "provider")).toEqual([{ type: "provider", value: "provider", models: ["fast", "provider/deep"] }]);
    expect(root.find((row) => row.value?.type === "themes").note).toContain("night");
    expect(root.find((row) => row.value?.type === "provider").note).toContain("current");
    expect(values(root, "access.add.form")).toEqual([{ type: "access.add.form", path: "/work/alpha" }]);
    for (const type of ["access.models", "access.projects", "access.sessions", "access.tools.list", "prompts", "access.settings.agent", "access.settings.terminal"]) {
      expect(values(root, type)).toHaveLength(1);
    }
    for (const type of ["access.settings", "access.agents", "access.tools", "access.add"]) expect(values(root, type)).toHaveLength(0);
  });

  test("keeps routine choices within two menus and rare administration within three", () => {
    const options = fixture();
    const depths = new Map();
    const visit = (items, depth, ancestors = []) => {
      expect(depth).toBeLessThanOrEqual(3);
      for (const row of actions(items)) {
        const value = row.value;
        const key = `${value.type}:${value.path ?? value.endpoint ?? value.selector ?? value.value ?? ""}`;
        depths.set(value.type, Math.min(depths.get(value.type) ?? Infinity, depth));
        if (ancestors.includes(key)) continue;
        // Filters replace their existing list instead of adding a menu layer.
        if (["access.projects", "access.sessions"].includes(value.type) && ancestors.some((ancestor) => ancestor.startsWith(`${value.type}:`))) continue;
        const own = buildAccessItems(value, options);
        const legacy = own ? undefined : resolveMenuAction(value);
        const child = own?.items ?? (legacy?.kind === "push" ? legacy.items : undefined);
        if (child) visit(child, depth + 1, [...ancestors, key]);
      }
    };
    visit(buildAccessRoot(options), 1);
    for (const type of ["theme.set", "agent.switch", "model", "access.add.form", "agent.close", "access.project.select", "access.session.resume", "access.tool", "insert", "thinking", "safe", "session-save", "access.terminal.set"]) {
      expect({ type, depth: depths.get(type) }).toEqual({ type, depth: expect.any(Number) });
      expect(depths.get(type)).toBeLessThanOrEqual(2);
    }
  });

  test("indexes read-only and unlogged replacement variants without adding root clutter", () => {
    const search = buildActionSearch();
    const variants = search.filter((row) => row.label.startsWith("New chat,"));
    expect(variants.map((row) => row.value)).toEqual([
      { type: "command", lines: ["/session-new", "/agent-safe on"] },
      { type: "command", lines: ["/session-new false"] },
      { type: "command", lines: ["/session-new false", "/agent-safe on"] },
    ]);
    expect(variants.every((row) => row.note === "Actions › New chat" && row.hint.includes("Replace"))).toBe(true);
    expect(buildAccessRoot().some((row) => row.label.startsWith("New chat,"))).toBe(false);
    variants[0].value.lines.push("/changed");
    expect(buildActionSearch().find((row) => row.label === "New chat, read-only").value.lines).toEqual(["/session-new", "/agent-safe on"]);
  });

  test("returns fresh action values without leaking mutations into subsequent roots", () => {
    const root = buildAccessRoot();
    root.find((row) => row.label === "New chat").value.lines.push("/changed");
    root.find((row) => row.label === "Projects").value.type = "changed";
    expect(values(buildAccessRoot(), "command")[0].lines).toEqual(["/session-new"]);
    expect(values(buildAccessRoot(), "access.projects")).toHaveLength(1);
  });

  test("returns undefined for executable leaves and unsupported sources", () => {
    expect(buildAccessItems({ type: "access.agent.add", path: "/work/alpha" })).toBeUndefined();
    expect(buildAccessItems({ type: "unrecognized" })).toBeUndefined();
    expect(buildAccessItems(undefined)).toBeUndefined();
  });
});

describe("project navigation and creation", () => {
  test("shows known group filters, project metadata, select and details actions", () => {
    const options = fixture();
    const { items } = buildAccessItems({ type: "access.projects" }, options);
    expect(items[0].value).toEqual({ type: "back" });
    expect(values(items, "access.projects")).toEqual([{ type: "access.projects" }, { type: "access.projects", group: "other" }, { type: "access.projects", group: "shared" }]);
    expect(values(items, "access.project.select").map((value) => value.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(values(items, "access.project.details").map((value) => value.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(values(items, "access.project.open")).toHaveLength(1);
    const alpha = items.find((row) => row.value?.type === "access.project.select" && row.value.path === "/work/alpha");
    expect(alpha.note).toContain("pinned");
    expect(alpha.note).toContain("current");
    expect(alpha.note).not.toContain("/work/alpha"); // folder paths are noise, never shown
    expect(alpha.role).toContain("menu.project"); // names carry the title style, staying selectable
    expect(alpha.description).toBe("Current project");
    expect(alpha.preview.description).toBe("Current project");
    const filtered = buildAccessItems({ type: "access.projects", group: "shared" }, options);
    expect(values(filtered.items, "access.project.select")).toEqual([{ type: "access.project.select", path: "/work/alpha" }]);
    const empty = buildAccessItems({ type: "access.projects", group: "missing" }, options);
    expect(empty.items.some((row) => row.kind === "info" && row.label.includes("no projects"))).toBe(true);
  });

  test("details capture pin state and only offer close for an open project", () => {
    const options = fixture();
    const alpha = buildAccessItems({ type: "access.project.details", path: "/work/alpha" }, options);
    expect(values(alpha.items, "access.project.pin")).toEqual([{ type: "access.project.pin", path: "/work/alpha", pinned: false }]);
    expect(values(alpha.items, "access.project.close")).toEqual([{ type: "access.project.close", path: "/work/alpha" }]);
    expect(values(alpha.items, "access.project.description")).toEqual([{ type: "access.project.description", path: "/work/alpha" }]);
    const beta = buildAccessItems({ type: "access.project.details", path: "/work/beta" }, options);
    expect(values(beta.items, "access.project.pin")[0].pinned).toBe(true);
    expect(values(beta.items, "access.project.close")).toEqual([]);
    const removed = buildAccessItems({ type: "access.project.details", path: "/missing" }, options);
    expect(removed.items.some((row) => row.kind === "info" && row.label.includes("no longer"))).toBe(true);
  });

  test("group rows toggle membership and explain pinning and shared resources", () => {
    const { items } = buildAccessItems({ type: "access.project.details", path: "/work/alpha" }, fixture());
    expect(values(items, "access.project.group")).toEqual([
      { type: "access.project.group", path: "/work/alpha", group: "other", member: true },
      { type: "access.project.group", path: "/work/alpha", group: "shared", member: false },
    ]);
    expect(values(items, "access.project.group.new")).toEqual([{ type: "access.project.group.new", path: "/work/alpha" }]);
    expect(items.some((row) => /pins this project and lets its agents reach/.test(row.label))).toBe(true);
  });

  test("opens the current-project add form directly and exposes other projects on their list", () => {
    const options = fixture();
    expect(values(buildAccessRoot(options), "access.add.form")).toEqual([{ type: "access.add.form", path: "/work/alpha" }]);
    const projects = buildAccessItems({ type: "access.projects" }, options);
    expect(values(projects.items, "access.add.form").map((value) => value.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(values(buildAccessRoot(), "access.add.form")).toEqual([]);
    expect(buildAccessItems({ type: "access.add" })).toBeUndefined();
  });

  test("captures live agents by identity even when display names match", () => {
    const options = fixture();
    const items = buildAccessRoot(options);
    const switches = values(items, "agent.switch");
    expect(switches[0].agent).toBe(options.agents[0].agent);
    expect(switches[1].agent).toBe(options.agents[1].agent);
    options.agents.reverse();
    expect(switches[0].agent).toBe(options.agent);
    const close = values(items, "session-close-menu")[0];
    expect(close.agents[0].agent).toBe(options.agent);
  });
});

describe("scoped settings", () => {
  test("exposes scoped settings directly without a generic settings parent", () => {
    const options = fixture();
    const items = buildAccessRoot(options);
    expect(values(items, "access.settings.agent")).toHaveLength(1);
    expect(values(items, "access.settings.endpoints")).toHaveLength(1);
    expect(items.find((row) => row.label === "Terminal settings").note).toBe("Personal · next launch");
    expect(buildAccessItems({ type: "access.settings" }, options)).toBeUndefined();
    const agentMenu = buildAccessItems({ type: "access.settings.agent" }, options);
    expect(values(agentMenu.items, "access.agent.rename")[0].agent).toBe(options.agent);
    expect(values(agentMenu.items, "access.session.rename")[0].session).toBe(options.savedSessions[0]);
    expect(values(agentMenu.items, "thinking").map((value) => value.value)).toEqual(["default", "low", "high"]);
    expect(values(agentMenu.items, "safe")).toEqual([{ type: "safe", value: "on" }]);
    expect(values(agentMenu.items, "session-save")).toEqual([{ type: "session-save", value: false }]);
  });

  test("exposes Allow, Deny and Ask while linked agents cannot discover permission edits", () => {
    const options = fixture();
    const search = buildActionSearch(options);
    for (const type of ["agent.can.delegate", "agent.can.request"]) {
      expect(values(search, type).map((value) => value.value)).toEqual([true, false, undefined]);
    }
    options.agent.parent = {};
    options.linked = false;
    const locked = buildAccessItems({ type: "access.settings.agent" }, options);
    expect(locked.items.filter((row) => row.kind === "info" && row.label.includes("linked agent"))).toHaveLength(2);
    expect(actions(locked.items).some((row) => row.value.type.startsWith("agent.can."))).toBe(false);
    expect(buildActionSearch(options).some((row) => row.value.type.startsWith("agent.can."))).toBe(false);
  });

  test("reads personal/effective terminal values, whitelists keys and offers explicit reset", () => {
    const options = fixture();
    const { items } = buildAccessItems({ type: "access.settings.terminal" }, options);
    const setters = values(items, "access.terminal.set");
    expect([...new Set(setters.map((value) => value.key))]).toEqual(["tui.alt", "tui.mouse", "tui.osc52", "tui.scroll.show", "tui.cursor.shape", "tui.cursor.blink"]);
    for (const key of new Set(setters.map((value) => value.key))) {
      expect(setters.some((value) => value.key === key && Object.hasOwn(value, "value") && value.value === undefined)).toBe(true);
    }
    const alt = items.find((row) => row.value?.key === "tui.alt");
    expect(alt.note).toContain("Personal: true");
    expect(alt.note).toContain("Effective: false (project override)");
    const blink = items.find((row) => row.value?.key === "tui.cursor.blink");
    expect(blink.note).toContain("Personal: 610");
    expect(blink.note).toContain("Effective: 900");
    expect(items.filter((row) => row.value?.type === "access.terminal.set").every((row) => row.hint === "Personal · next launch")).toBe(true);
    options.personalSettings.tui.cursor.blink = 123;
    expect(buildAccessItems({ type: "access.settings.terminal" }, options).items.find((row) => row.value?.key === "tui.cursor.blink").note).toContain("Personal: 123");
  });

  test("offers the line, block and underline cursor shapes supported by the terminal host", () => {
    const { items } = buildAccessItems({ type: "access.settings.terminal" });
    const shapes = values(items, "access.terminal.set").filter(({ key, value }) => key === "tui.cursor.shape" && value !== undefined).map(({ value }) => value);
    expect(shapes).toEqual(["line", "block", "underline"]);
    expect(shapes.map((shape) => cursorStyle(shape, false))).toEqual(["\u001b[6 q", "\u001b[2 q", "\u001b[4 q"]);
  });

  test("validates executor terminal writes using the menu's exact key and value allowlist", () => {
    const { items } = buildAccessItems({ type: "access.settings.terminal" }, fixture());
    for (const { key, value } of values(items, "access.terminal.set")) expect(terminalSettingAllowed(key, value)).toBe(true);
    expect(terminalSettingAllowed("tui.alt", "false")).toBe(false);
    expect(terminalSettingAllowed("tui.cursor.shape", "triangle")).toBe(false);
    expect(terminalSettingAllowed("tui.cursor.blink", 123)).toBe(false);
    expect(terminalSettingAllowed("providers.secret", undefined)).toBe(false);
    expect(terminalSettingAllowed("__proto__", true)).toBe(false);
    expect(terminalSettingAllowed(undefined, false)).toBe(false);
  });

  test("opens endpoint and model capacity forms without a fourth preset menu", () => {
    const options = fixture();
    const endpoint = buildAccessItems({ type: "endpoint-policy", endpoint: "provider" }, options);
    const max = values(endpoint.items, "access.endpoint.max");
    expect(max.map((value) => value.selector)).toEqual(["provider", "provider/fast"]);
    expect(values(endpoint.items, "max-active-menu")).toEqual([]);
    expect(values(endpoint.items, "endpoint-policy.set")).toHaveLength(1);
    const search = buildActionSearch(options);
    expect(values(search, "access.endpoint.max").map((value) => value.selector)).toEqual(["provider", "provider/fast"]);
    expect(search.find((row) => row.value.type === "access.endpoint.max").note).toContain("Endpoint settings");
  });

  test("reuses endpoint policy, login and logout vocabulary", () => {
    const { items } = buildAccessItems({ type: "access.settings.endpoints" }, fixture());
    expect(values(items, "endpoint-policy")).toEqual([{ type: "endpoint-policy", endpoint: "provider" }]);
    expect(values(buildAccessRoot(fixture()), "login")).toContainEqual({ type: "login" });
    expect(values(items, "logout")).toEqual([{ type: "logout", endpoint: "provider" }]);
  });
});

describe("saved-session browsing and tool guidance", () => {
  test("keeps loading and empty states navigable, including legacy sessions input", () => {
    const loading = buildAccessItems({ type: "access.sessions" }, { sessionsLoading: true });
    expect(loading.items[0].value).toEqual({ type: "back" });
    expect(loading.items.some((row) => row.label.includes("Loading"))).toBe(true);
    expect(loading.items.some((row) => row.label.includes("no saved"))).toBe(false);
    expect(buildAccessItems({ type: "access.sessions" }).items.some((row) => row.label.includes("no saved"))).toBe(true);
    expect(values(buildAccessItems({ type: "access.sessions" }, { sessions: [{ id: "legacy", messages: 0 }] }).items, "access.session.resume")).toHaveLength(1);
  });

  test("offers all-project and per-project navigation and filters by exact captured project path", () => {
    const options = fixture();
    options.savedSessions.push({ id: "archived", project: "/archive/old", projectName: "old", messages: 1 });
    options.savedSessions.push({ id: "env-only", env: { folder: "/work/beta", name: "beta" }, messages: 2 });
    const all = buildAccessItems({ type: "access.sessions" }, options);
    expect(values(all.items, "access.sessions")).toEqual([
      { type: "access.sessions" },
      { type: "access.sessions", project: "/work/alpha" },
      { type: "access.sessions", project: "/work/beta" },
      { type: "access.sessions", project: "/archive/old" },
    ]);
    const filtered = buildAccessItems({ type: "access.sessions", project: "/work/beta" }, options);
    expect(filtered.title).toBe("Saved sessions / beta");
    expect(values(filtered.items, "access.session.resume").map((value) => value.session.id)).toEqual(["session-beta", "env-only"]);
    expect(filtered.items.find((row) => row.value?.project === "/work/beta").note).toContain("current filter");
    const empty = buildAccessItems({ type: "access.sessions", project: "/missing" }, options);
    expect(empty.items.some((row) => row.label === "(no saved sessions for this project)")).toBe(true);
    const loading = buildAccessItems({ type: "access.sessions", project: "/missing" }, { ...options, sessionsLoading: true });
    expect(loading.items.some((row) => row.label.includes("Loading"))).toBe(true);
    expect(loading.items.some((row) => row.label.includes("no saved"))).toBe(false);
    const search = buildActionSearch(options);
    expect(values(search, "access.sessions").some((value) => value.project === "/archive/old")).toBe(true);
    expect(values(search, "access.session.delete")).toHaveLength(4);
  });

  test("shows preview, full ID, project, UTC date, count and captures exact session action targets", () => {
    const options = fixture();
    const { items } = buildAccessItems({ type: "access.sessions" }, options);
    const row = items.find((item) => item.value?.session === options.savedSessions[0]);
    expect(row.description).toBe("A design conversation");
    for (const part of ["session-alpha", "alpha", "2026-10-24 12:30", "4 messages", "live"]) expect(row.note).toContain(part);
    const captured = row.value.session;
    expect(row.value.type).toBe("access.session.resume");
    const manage = items.find((item) => item.value?.type === "access.session.actions" && item.value.session === captured);
    const submenu = buildAccessItems(manage.value, options);
    for (const type of ["access.session.resume", "access.session.rename", "access.session.delete"]) expect(values(submenu.items, type)[0].session).toBe(captured);
    options.savedSessions = [];
    expect(values(submenu.items, "access.session.delete")[0].session.id).toBe("session-alpha");
    expect(submenu.items.find((item) => item.value?.type === "access.session.resume").label).toContain("live agent");
  });

  test("offers tools and prompts without executing tools and includes required JSON guidance", () => {
    const options = fixture();
    const top = buildAccessRoot(options);
    expect(values(top, "access.tools.list")).toHaveLength(1);
    expect(values(top, "prompts")).toEqual([{ type: "prompts", prompts: ["review"] }]);
    const tools = buildAccessItems({ type: "access.tools.list" }, options);
    const row = tools.items.find((item) => item.value?.type === "access.tool");
    expect(row.value).toEqual({ type: "access.tool", name: "tool-read", schema: options.tools[0].schema });
    expect(row.value.schema).toBe(options.tools[0].schema);
    expect(row.description).toBe("Read a path");
    expect(row.hint).toContain("Required arguments: path");
    expect(row.hint).toContain("JSON");
    expect(buildAccessItems({ type: "access.tools.list" }).items.some((item) => item.label.includes("no tools"))).toBe(true);
  });
});

describe("flat action search", () => {
  test("finds nested actions, settings choices, tools, prompts, models, agents and sessions", () => {
    const options = fixture();
    const search = buildActionSearch(options);
    for (const type of [
      "access.settings.agent", "access.settings.terminal", "access.settings.endpoints", "access.agent.rename", "access.add.form",
      "access.project.pin", "access.project.group", "access.project.description", "access.project.close", "access.session.resume", "access.session.rename", "access.session.delete",
      "agent.switch", "agent.close", "thinking", "safe", "session-save", "agent.can.request", "agent.can.delegate", "theme.set", "access.terminal.set", "endpoint-policy.set", "access.tool", "model", "logout",
    ]) expect(values(search, type).length).toBeGreaterThan(0);
    expect(values(search, "model").map((value) => value.value)).toEqual(["provider/fast", "provider/deep"]);
    expect(values(search, "insert").map((value) => value.text)).toEqual(expect.arrayContaining(["/review ", "/help ", "/context-edit "]));
    expect(search.find((row) => row.value.type === "model").note).toContain("Actions › Models");
    expect(search.find((row) => row.value.type === "access.session.resume").note).toContain("Saved sessions");
    expect(search.every((row) => row.kind === "action" && typeof row.value === "object" && typeof row.value.type === "string" && row.value.type !== "back" && row.note && row.hint)).toBe(true);
  });

  test("does not call environment methods, mutate snapshots or serialize cyclic target references", () => {
    const options = fixture();
    options.currentEnv.owner = options.agent;
    options.currentEnv.agents = () => { throw new Error("must not gather live facts"); };
    const before = options.projects.map((project) => ({ ...project, groups: [...project.groups] }));
    const first = buildActionSearch(options);
    const second = buildActionSearch(options);
    expect(first).toEqual(second);
    expect(options.projects).toEqual(before);
    expect(values(first, "agent.switch")[0].agent).toBe(options.agent);
    expect(values(first, "access.session.delete")[1].session).toBe(options.savedSessions[1]);
    expect(values(first, "access.project.select")).toHaveLength(2);
    expect(values(first, "access.project.pin")).toHaveLength(2);
  });
});
