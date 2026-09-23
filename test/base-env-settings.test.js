// test/base-env-settings.test.js — proof for Env settings scan-and-merge
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { defaultSettingsDir } from "../lib/env/paths.js";
import { join, resolve } from "node:path";
import { Env, deepMerge } from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";

const projectAuth = (name) => `${NAMES.projectAuthPrefix}${name}.json`;

let dir;
beforeEach(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "env-settings-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeJson = (name, value) =>
  writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));

describe("default settings folder", () => {
  const variables = [NAMES.settingsEnv, "OMOYA_SETTINGS", "AI_SETTINGS_DIR", "AI_SETTINGS"];
  const saved = new Map();

  beforeEach(() => {
    for (const name of variables) saved.set(name, process.env[name]);
  });
  afterEach(() => {
    for (const name of variables) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("uses environment settings folders in declared precedence order", () => {
    const locations = variables.map((_, i) => join(dir, `settings-${i}`));
    for (const [i, name] of variables.entries()) process.env[name] = locations[i];

    expect(defaultSettingsDir()).toBe(resolve(locations[0]));
    delete process.env[variables[0]];
    expect(defaultSettingsDir()).toBe(resolve(locations[1]));
    delete process.env[variables[1]];
    expect(defaultSettingsDir()).toBe(resolve(locations[2]));
    delete process.env[variables[2]];
    expect(defaultSettingsDir()).toBe(resolve(locations[3]));
  });
});

describe("scan-and-merge", () => {
  test("all package-folder JSON files merge into one tree", () => {
    writeJson("settings.json", { ollama: { url: "http://localhost:11434" }, theme: "dark" });
    writeJson("extra.json", { kimi: { key: "k" } });
    const env = new Env({ dir, cwd: dir });
    expect(env.settings.ollama.url).toBe("http://localhost:11434");
    expect(env.settings.kimi.key).toBe("k");
    expect(env.settings.theme).toBe("dark");
  });

  test("objects deep-merge recursively across files", () => {
    writeJson("a.json", { ollama: { url: "u1", options: { temperature: 0.5 } } });
    writeJson("b.json", { ollama: { model: "qwen3", options: { top_p: 1 } } });
    const env = new Env({ dir, cwd: dir });
    expect(env.settings.ollama).toEqual({
      url: "u1",
      model: "qwen3",
      options: { temperature: 0.5, top_p: 1 },
    });
  });

  test("arrays concatenate across files", () => {
    writeJson("a.json", { tools: ["./tools-a"] });
    writeJson("b.json", { tools: ["./tools-b", "./tools-c"] });
    const env = new Env({ dir, cwd: dir });
    expect(env.settings.tools).toEqual(["./tools-a", "./tools-b", "./tools-c"]);
  });

  test("settings.json parse failure crashes the load (fail fast)", () => {
    writeJson("settings.json", "{ not json !!");
    expect(() => new Env({ dir, cwd: dir })).toThrow(/settings\.json parse failure/);
  });

  test("settings.json may hold // and /* */ comments (JSONC — see lib/env/jsonc.js)", () => {
    writeJson("settings.json", `{
      // "toolTimeout": 120000,
      "maxActive": 4, /* keep it modest */
      "ollama": { "url": "http://localhost:11434" } // trailing note
    }`);
    const env = new Env({ dir, cwd: dir });
    expect(env.settings).toEqual({ maxActive: 4, ollama: { url: "http://localhost:11434" } });
  });

  test("other files' parse failures are ignored", () => {
    writeJson("settings.json", { ok: true });
    writeJson("auth-broken.json", "{ not json !!");
    writeJson("notes.json", "also not json");
    const env = new Env({ dir, cwd: dir });
    expect(env.settings.ok).toBe(true);
  });

  test("non-object top-level JSON files are skipped", () => {
    writeJson("array.json", [1, 2, 3]);
    writeJson("scalar.json", "42");
    writeJson("settings.json", { ok: 1 });
    const env = new Env({ dir, cwd: dir });
    expect(env.settings).toEqual({ ok: 1 });
  });

  test("explicit arguments override merged settings", () => {
    writeJson("settings.json", { ollama: { model: "a", url: "u" }, level: 1 });
    const env = new Env({ dir, cwd: dir, settings: { ollama: { model: "b" } } });
    expect(env.settings.ollama).toEqual({ model: "b", url: "u" });
  });
});

describe("deepMerge semantics", () => {
  test("nested objects, array concat, scalar later-wins", () => {
    expect(deepMerge({ a: { x: 1 } }, { a: { y: 2 } })).toEqual({ a: { x: 1, y: 2 } });
    expect(deepMerge({ t: [1] }, { t: [2] })).toEqual({ t: [1, 2] });
    expect(deepMerge({ s: "a" }, { s: "b" })).toEqual({ s: "b" });
    expect(deepMerge(undefined, { x: 1 })).toEqual({ x: 1 });
    expect(deepMerge({ x: 1 }, undefined)).toBeUndefined();
  });
});

describe("the scanning layers (package → settings folder → namespaced project files)", () => {
  const mk = (name) => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    return d;
  };

  test("theme folders load only when Env._loadThemes is enabled", () => {
    const pkg = mk("pkg");
    const user = mk("user");
    mkdirSync(join(pkg, "themes"), { recursive: true });
    mkdirSync(join(user, "themes"), { recursive: true });
    writeFileSync(join(pkg, "themes", "package.json"), JSON.stringify({ tui: { themes: { package: { color: "blue" } } } }));
    writeFileSync(join(user, "themes", "user.json"), JSON.stringify({ tui: { themes: { user: { color: "green" } } } }));

    const original = Env._loadThemes;
    try {
      Env._loadThemes = false;
      expect(new Env({ dir: pkg, settingsDir: user, cwd: pkg }).settings.tui).toBeUndefined();

      Env._loadThemes = true;
      expect(new Env({ dir: pkg, settingsDir: user, cwd: pkg }).settings.tui.themes).toMatchObject({
        package: { color: "blue" },
        user: { color: "green" },
      });
    } finally {
      Env._loadThemes = original;
    }
  });

  test("the settings folder scans ALL its JSON files, after the package", () => {
    const pkg = mk("pkg");
    const user = mk("user");
    const project = mk("project");
    writeFileSync(join(pkg, "settings.json"), JSON.stringify({ a: 1, shared: { p: 1 } }));
    writeFileSync(join(user, "settings.json"), JSON.stringify({ b: 2, shared: { u: 2 } }));
    writeFileSync(join(user, "auth-ep.json"), JSON.stringify({ ep: { token: "t" } }));
    const env = new Env({ dir: pkg, settingsDir: user, cwd: project });
    expect(env.settingsDir).toBe(user);
    expect(env.settings.a).toBe(1);
    expect(env.settings.b).toBe(2);
    expect(env.settings.shared).toEqual({ p: 1, u: 2 }); // deep-merged across layers
    expect(env.settings.ep.token).toBe("t");
  });

  test("the project folder contributes only namespaced settings/auth files (never a full scan)", () => {
    const pkg = mk("pkg");
    const project = mk("project");
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ local: true, providers: { lp: { provider: "x", url: "u" } } }));
    writeFileSync(join(project, projectAuth("lp")), JSON.stringify({ lp: { token: "lt" } }));
    writeFileSync(join(project, "settings.json"), JSON.stringify({ ignored: true })); // NOT scanned
    writeFileSync(join(project, "auth-lp.json"), JSON.stringify({ lp: { token: "legacy" } })); // NOT scanned
    writeFileSync(join(project, "notes.json"), JSON.stringify({ ignored2: true })); // NOT scanned
    const env = new Env({ dir: pkg, settingsDir: null, cwd: project });
    expect(env.settings.local).toBe(true);
    expect(env.settings.lp.token).toBe("lt");
    expect(env.settings.ignored).toBeUndefined();
    expect(env.settings.ignored2).toBeUndefined();
    expect(env.endpointScope("lp")).toBe("local"); // project settings scope is local
  });

  test("JSON scanning is NEVER recursive — nested settings/auth files are private data, never loaded", () => {
    const pkg = mk("pkg");
    const user = mk("user");
    const project = mk("project");
    // nested look-alikes in EVERY layer: a sub-folder's JSON (even
    // ai-*-named) is never scanned — designated top-level files only
    mkdirSync(join(pkg, "nested"), { recursive: true });
    writeFileSync(join(pkg, "nested", "settings.json"), JSON.stringify({ leak1: true }));
    mkdirSync(join(user, "nested"), { recursive: true });
    writeFileSync(join(user, "nested", "auth-ep.json"), JSON.stringify({ ep: { token: "leak" } }));
    mkdirSync(join(project, "nested"), { recursive: true });
    writeFileSync(join(project, "nested", NAMES.projectSettings), JSON.stringify({ leak2: true }));
    writeFileSync(join(project, "nested", projectAuth("lp")), JSON.stringify({ lp: { token: "leak" } }));
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ ok: 1 }));
    const env = new Env({ dir: pkg, settingsDir: user, cwd: project });
    expect(env.settings.ok).toBe(1);
    expect(env.settings.leak1).toBeUndefined();
    expect(env.settings.leak2).toBeUndefined();
    expect(env.settings.ep).toBeUndefined();
    expect(env.settings.lp).toBeUndefined();
  });

  test("project-scoped `tools`, `mcp` and `providerPaths` are STRIPPED at load (executable trust)", () => {
    // SECURITY: the project's settings file is agent-writable — it
    // must never name tool roots, unsandboxed server commands or
    // provider classes (the same keys in package/settings scope are
    // honored; constructor settings are programmatic, also honored)
    const pkg = mk("pkg");
    const project = mk("project");
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({
      tools: ["./x"],
      mcp: { evil: { command: "curl" } },
      providerPaths: ["./y"],
      other: 1,
    }));
    const env = new Env({ dir: pkg, settingsDir: null, cwd: project });
    expect(env.settings.tools).toBeUndefined();
    expect(env.settings.mcp).toBeUndefined();
    expect(env.settings.providerPaths).toBeUndefined();
    expect(env.settings.other).toBe(1); // the rest merges normally
  });

  test("project auth files cannot add tool/provider paths or MCP commands", () => {
    const pkg = mk("pkg");
    const project = mk("project");
    writeFileSync(join(project, projectAuth("evil")), JSON.stringify({
      evil: { provider: "openai", url: "https://example.test" },
      tools: ["./evil-tools"],
      providerPaths: ["./evil-providers"],
      mcp: { evil: { command: "evil-command" } },
    }));
    const env = new Env({ dir: pkg, settingsDir: null, cwd: project });
    expect(env.endpoint("evil")).toMatchObject({ provider: "openai", url: "https://example.test" });
    expect(env.settings.tools).toBeUndefined();
    expect(env.settings.providerPaths).toBeUndefined();
    expect(env.settings.mcp).toBeUndefined();
  });

  test("settingsDir: null disables the user layer", () => {
    const pkg = mk("pkg");
    const env = new Env({ dir: pkg, settingsDir: null, cwd: pkg });
    expect(env.settingsDir).toBe(null);
  });

  test("a folder already scanned under an earlier layer is never scanned twice", () => {
    const pkg = mk("pkg");
    // an ARRAY proves single scanning: merging the same file twice
    // would concatenate it ([1] → [1, 1])
    writeFileSync(join(pkg, "settings.json"), JSON.stringify({ arr: [1] }));
    const env = new Env({ dir: pkg, settingsDir: pkg, cwd: pkg });
    expect(env.settings.arr).toEqual([1]);
  });

  test("project settings parse failure crashes the load; project auth failures are ignored", () => {
    const pkg = mk("pkg");
    const project = mk("project");
    writeFileSync(join(project, NAMES.projectSettings), "{ not json !!");
    expect(() => new Env({ dir: pkg, settingsDir: null, cwd: project })).toThrow(new RegExp(`${NAMES.projectSettings.replace(".", "\\.")} parse failure`));
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ ok: 1 }));
    writeFileSync(join(project, projectAuth("broken")), "{ not json !!");
    const env = new Env({ dir: pkg, settingsDir: null, cwd: project });
    expect(env.settings.ok).toBe(1);
  });

  test("dynamic writes land in the settings folder, never the package folder", () => {
    const pkg = mk("pkg");
    const user = mk("user");
    const env = new Env({ dir: pkg, settingsDir: user, cwd: pkg });
    env.authSet("ep", { token: "t" });
    expect(existsSync(join(user, "auth-ep.json"))).toBe(true);
    expect(existsSync(join(pkg, "auth-ep.json"))).toBe(false);
    env.saveEndpoint("ep2", { provider: "x", url: "u" });
    expect(existsSync(join(user, "auth-ep2.json"))).toBe(true);
    expect(existsSync(join(pkg, "settings.json"))).toBe(false);
    // a LOCAL scope write uses the project's namespaced files
    env.authSet("lp", { token: "lt" }, { scope: "local" });
    expect(existsSync(join(pkg, projectAuth("lp")))).toBe(true); // cwd === pkg here
    env.saveEndpoint("lp2", { provider: "x", url: "u" }, { scope: "local" });
    expect(existsSync(join(pkg, NAMES.projectSettings))).toBe(true);
  });

  test("saveEndpoint preserves unrelated settings and all endpoints across a batch", async () => {
    const pkg = mk("pkg");
    const user = mk("user");
    writeFileSync(join(user, "settings.json"), JSON.stringify({ keep: { value: 1 }, providers: { existing: { provider: "x", url: "http://old" } } }));
    const env = new Env({ dir: pkg, settingsDir: user, cwd: pkg });
    await env.batch(() => {
      env.saveEndpoint("first", { provider: "x", url: "http://first" });
      env.saveEndpoint("second", { provider: "x", url: "http://second" });
    });
    expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8"))).toEqual({
      keep: { value: 1 },
      providers: {
        existing: { provider: "x", url: "http://old" },
        first: { provider: "x", url: "http://first" },
        second: { provider: "x", url: "http://second" },
      },
    });
  });
});
