// test/base-env-settings.test.js — proof for layered Env settings and graph persistence
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { defaultSettingsDir } from "../lib/env/paths.js";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";
import { authSetOf, endpointOf, scope, toolRoots } from "./env-internals.js";

const projectAuth = (name) => `${NAMES.projectAuthPrefix}${name}.json`;

let dir;
beforeEach(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "env-settings-")));
  mkdirSync(join(dir, "project"));
});
afterEach(async () => {
  await Promise.all(Object.values(Env.envs).filter((env) => env.folder === dir || env.folder.startsWith(`${dir}/`)).map((env) => env.close()));
  rmSync(dir, { recursive: true, force: true });
});

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

describe("source-aware settings layers", () => {
  test("all package-folder JSON files merge into one tree", async () => {
    writeJson("settings.json", { ollama: { url: "http://localhost:11434" }, theme: "dark" });
    writeJson("extra.json", { kimi: { key: "k" } });
    const env = await Env.open(join(dir, "project"), { dir, init: { providers: false, tools: false, models: false } });
    expect(env.settings.ollama.url).toBe("http://localhost:11434");
    expect(env.settings.kimi.key).toBe("k");
    expect(env.settings.theme).toBe("dark");
  });

  test("objects deep-merge recursively across files", async () => {
    writeJson("a.json", { ollama: { url: "u1", options: { temperature: 0.5 } } });
    writeJson("b.json", { ollama: { model: "qwen3", options: { top_p: 1 } } });
    const env = await Env.open(join(dir, "project"), { dir, init: { providers: false, tools: false, models: false } });
    expect(env.settings.ollama).toEqual({
      url: "u1",
      model: "qwen3",
      options: { temperature: 0.5, top_p: 1 },
    });
  });

  test("higher-precedence ordered settings arrays replace lower-precedence arrays", async () => {
    writeJson("a.json", { pluginOptions: { ordered: ["first"] } });
    writeJson("b.json", { pluginOptions: { ordered: ["second", "third"] } });
    const env = await Env.open(join(dir, "project"), { dir, init: { providers: false, tools: false, models: false } });
    expect(env.settings.pluginOptions.ordered).toEqual(["second", "third"]);
  });

  test("settings.json parse failure crashes the load (fail fast)", async () => {
    writeJson("settings.json", "{ not json !!");
    await expect(Env.open(join(dir, "project"), { dir, init: { providers: false, tools: false, models: false } })).rejects.toThrow(/settings\.json parse failure/);
  });

  test("settings.json may hold // and /* */ comments (JSONC — see lib/env/jsonc.js)", async () => {
    writeJson("settings.json", `{
      // "tools": { "timeout": 120000 },
      "maxActive": 4, /* keep it modest */
      "ollama": { "url": "http://localhost:11434" } // trailing note
    }`);
    const env = await Env.open(join(dir, "project"), { dir, init: { providers: false, tools: false, models: false } });
    expect(env.settings).toMatchObject({ maxActive: 4, ollama: { url: "http://localhost:11434" } });
    expect(env.settings.tools.timeout).toBe(120_000); // the commented-out line stays a comment (the default reads)
  });

  test("other files' parse failures are ignored", async () => {
    writeJson("settings.json", { ok: true });
    writeJson("auth-broken.json", "{ not json !!");
    writeJson("notes.json", "also not json");
    const env = await Env.open(join(dir, "project"), { dir, init: { providers: false, tools: false, models: false } });
    expect(env.settings.ok).toBe(true);
  });

  test("non-object top-level JSON files are skipped", async () => {
    writeJson("array.json", [1, 2, 3]);
    writeJson("scalar.json", "42");
    writeJson("settings.json", { ok: 1 });
    const env = await Env.open(join(dir, "project"), { dir, init: { providers: false, tools: false, models: false } });
    expect(env.settings.ok).toBe(1);
    expect(Object.keys(env.settings).filter((key) => /^\d+$/.test(key))).toEqual([]); // the array never merged
  });

  test("explicit arguments override merged settings", async () => {
    writeJson("settings.json", { ollama: { model: "a", url: "u" }, level: 1 });
    const env = await Env.open(join(dir, "project"), { dir, settings: { ollama: { model: "b" } }, init: { providers: false, tools: false, models: false } });
    expect(env.settings.ollama).toEqual({ model: "b", url: "u" });
  });
});

describe("the scanning layers (package → settings folder → namespaced project files)", () => {
  const mk = (name) => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    return d;
  };

  test("theme folders load only with the instance themes option", async () => {
    const pkg = mk("pkg");
    const user = mk("user");
    const project = mk("project");
    mkdirSync(join(pkg, "themes"), { recursive: true });
    mkdirSync(join(user, "themes"), { recursive: true });
    writeFileSync(join(pkg, "themes", "package-theme.json"), JSON.stringify({ package: { color: "blue" } }));
    writeFileSync(join(user, "themes", "user.json"), JSON.stringify({ user: { color: "green" } }));

    const withoutThemes = await Env.open(project, { dir: pkg, settingsDir: user, themes: false });
    expect(withoutThemes.settings.themes).toEqual({});
    await withoutThemes.close();
    expect((await Env.open(project, { dir: pkg, settingsDir: user, themes: true, init: { providers: false, tools: false, models: false } })).settings.themes).toMatchObject({
      package: { color: "blue" },
      user: { color: "green" },
    });
  });

  test("the settings folder scans ALL its JSON files, after the package", async () => {
    const pkg = mk("pkg");
    const user = mk("user");
    const project = mk("project");
    writeFileSync(join(pkg, "settings.json"), JSON.stringify({ a: 1, shared: { p: 1 } }));
    writeFileSync(join(user, "settings.json"), JSON.stringify({ b: 2, shared: { u: 2 } }));
    writeFileSync(join(user, "auth-ep.json"), JSON.stringify({ ep: { token: "t" } }));
    const env = await Env.open(project, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
    expect(env.folders).toContainEqual({ kind: "settings", title: "settings folder", path: user });
    expect(env.settings.a).toBe(1);
    expect(env.settings.b).toBe(2);
    expect(env.settings.shared).toEqual({ p: 1, u: 2 }); // deep-merged across layers
    expect(env.settings.providers.ep.token).toBe("t"); // auth files are mounted at providers
  });

  test("the project folder contributes only namespaced settings/auth files (never a full scan)", async () => {
    const pkg = mk("pkg");
    const project = mk("project");
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ local: true, providers: { lp: { provider: "x", url: "u" } } }));
    writeFileSync(join(project, projectAuth("lp")), JSON.stringify({ lp: { token: "lt" } }));
    writeFileSync(join(project, "settings.json"), JSON.stringify({ ignored: true })); // NOT scanned
    writeFileSync(join(project, "auth-lp.json"), JSON.stringify({ lp: { token: "legacy" } })); // NOT scanned
    writeFileSync(join(project, "notes.json"), JSON.stringify({ ignored2: true })); // NOT scanned
    const env = await Env.open(project, { dir: pkg, settingsDir: null, init: { providers: false, tools: false, models: false } });
    expect(env.settings.local).toBe(true);
    expect(env.settings.providers.lp.token).toBe("lt");
    expect(env.settings.ignored).toBeUndefined();
    expect(env.settings.ignored2).toBeUndefined();
    expect(scope(env, "lp")).toBe("local"); // project settings scope is local
  });

  test("JSON scanning is NEVER recursive — nested settings/auth files are private data, never loaded", async () => {
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
    const env = await Env.open(project, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
    expect(env.settings.ok).toBe(1);
    expect(env.settings.leak1).toBeUndefined();
    expect(env.settings.leak2).toBeUndefined();
    expect(env.settings.providers.ep).toBeUndefined();
    expect(env.settings.providers.lp).toBeUndefined();
  });

  test("project-scoped `tools.folders`, `mcp` and `extensions` are STRIPPED at load (executable trust)", async () => {
    // SECURITY: the project's settings file is agent-writable — it
    // must never name tool roots, unsandboxed server commands or
    // provider classes (the same keys in package/settings scope are
    // honored; constructor settings are programmatic, also honored)
    const pkg = mk("pkg");
    const project = mk("project");
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({
      tools: { folders: ["./x"], timeout: 30_000, timeoutLimit: 90_000, concurrency: 2 },
      mcp: { evil: { command: "curl" } },
      extensions: { "./y": true },
      other: 1,
    }));
    const env = await Env.open(project, { dir: pkg, settingsDir: null, init: { providers: false, tools: false, models: false } });
    expect(env.settings.tools).toMatchObject({ timeout: 30_000, timeoutLimit: 90_000, concurrency: 2 });
    expect(env.settings.tools.folders).toEqual({}); // stripped: only the default reads
    expect(env.settings.mcp).toEqual({}); // stripped: only the default reads
    expect(env.settings.extensions).toEqual({});
    expect(env.settings.other).toBe(1); // the rest merges normally
  });

  test("project auth files cannot add tool/provider paths or MCP commands", async () => {
    const pkg = mk("pkg");
    const project = mk("project");
    writeFileSync(join(project, projectAuth("evil")), JSON.stringify({
      evil: { provider: "openai", url: "https://example.test" },
      tools: { folders: { "./evil-tools": true }, timeout: 25_000 },
      extensions: { "./evil-extension": true },
      mcp: { evil: { command: "evil-command" } },
    }));
    const env = await Env.open(project, { dir: pkg, settingsDir: null, init: { providers: false, tools: false, models: false } });
    expect(endpointOf(env, "evil")).toMatchObject({ provider: "openai", url: "https://example.test" });
    // An auth file is mounted at providers: its other keys never reach root settings.
    expect(env.settings.tools.timeout).toBe(120_000);
    expect(env.settings.tools.folders).toEqual({});
    expect(env.settings.extensions).toEqual({});
    expect(env.settings.mcp).toEqual({}); // stripped: only the default reads
  });

  for (const sourceFile of [NAMES.projectSettings, projectAuth("evil")]) {
    test(`${sourceFile} preserves trusted folders while applying project tool policy`, async () => {
      const pkg = mk("pkg");
      const user = mk("user");
      const project = mk("project");
      writeFileSync(join(pkg, "settings.json"), JSON.stringify({ tools: { folders: { "./package-tools": true }, timeout: 120_000 } }));
      writeFileSync(join(user, "settings.json"), JSON.stringify({ tools: { folders: { "./user-tools": true }, concurrency: 3 } }));
      writeFileSync(join(project, sourceFile), JSON.stringify({ tools: { folders: { "./evil-tools": true }, timeout: 30_000, concurrency: 2 } }));
      const env = await Env.open(project, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
      // Project settings apply tool policy; an auth file (mounted at providers) cannot touch tools.
      expect(env.settings.tools).toMatchObject(sourceFile === NAMES.projectSettings
        ? { folders: { "./package-tools": true, "./user-tools": true }, timeout: 30_000, concurrency: 2 }
        : { folders: { "./package-tools": true, "./user-tools": true }, timeout: 120_000, concurrency: 3 });
    });

    for (const tools of [null, false, "./evil", ["./evil"], { folders: null }, JSON.parse('{"__proto__":{"folders":["./evil"]},"constructor":{"prototype":{"folders":["./evil"]}}}')]) {
      test(`${sourceFile} cannot replace or prototype-smuggle trusted folders via ${JSON.stringify(tools)}`, async () => {
        const pkg = mk("pkg");
        const project = mk("project");
        writeFileSync(join(pkg, "settings.json"), JSON.stringify({ tools: { folders: { "./trusted": true }, timeout: 120_000 } }));
        writeFileSync(join(project, sourceFile), JSON.stringify({ tools }));
        const env = await Env.open(project, { dir: pkg, settingsDir: null, init: { providers: false, tools: false, models: false } });
        expect(env.settings.tools).toMatchObject({ folders: { "./trusted": true }, timeout: 120_000 });
        expect(toolRoots(env)).not.toContain("./evil");
      });
    }
  }

  test("top-level prototype keys in project settings cannot smuggle tool folders", async () => {
    const pkg = mk("pkg");
    const project = mk("project");
    writeFileSync(join(project, NAMES.projectSettings), '{"__proto__":{"tools":{"folders":["./evil"]}}}');
    const env = await Env.open(project, { dir: pkg, settingsDir: null, init: { providers: false, tools: false, models: false } });
    expect(env.settings.tools.folders).toEqual({}); // only the default
    expect(toolRoots(env)).not.toContain("./evil");
  });

  test("settingsDir: null disables the user layer", async () => {
    const pkg = mk("pkg");
    const env = await Env.open(pkg, { dir: pkg, settingsDir: null, init: { providers: false, tools: false, models: false } });
    expect(env.folders.some(({ kind }) => kind === "settings")).toBe(false);
  });

  test("a folder already scanned under an earlier layer is never scanned twice", async () => {
    const pkg = mk("pkg");
    // An overlapping package/user/project path must not duplicate a source.
    writeFileSync(join(pkg, "settings.json"), JSON.stringify({ arr: [1] }));
    const env = await Env.open(pkg, { dir: pkg, settingsDir: pkg, init: { providers: false, tools: false, models: false } });
    expect(env.settings.arr).toEqual([1]);
  });

  test("project settings parse failure crashes the load; project auth failures are ignored", async () => {
    const pkg = mk("pkg");
    const project = mk("project");
    writeFileSync(join(project, NAMES.projectSettings), "{ not json !!");
    await expect(Env.open(project, { dir: pkg, settingsDir: null, init: { providers: false, tools: false, models: false } })).rejects.toThrow();
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ ok: 1 }));
    writeFileSync(join(project, projectAuth("broken")), "{ not json !!");
    const env = await Env.open(project, { dir: pkg, settingsDir: null, init: { providers: false, tools: false, models: false } });
    expect(env.settings.ok).toBe(1);
  });

  test("dynamic writes land in the settings folder, never the package folder", async () => {
    const pkg = mk("pkg");
    const user = mk("user");
    const env = await Env.open(pkg, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
    authSetOf(env, "ep", { token: "t" }); // no auth file yet: memory only
    await env.settingsFlush();
    expect(existsSync(join(user, "auth-ep.json"))).toBe(false);
    expect(existsSync(join(pkg, "auth-ep.json"))).toBe(false);
    (await env._sourceGraph.authFileCreate("ep")).assign(["ep"], { auth: { token: "t" } }); // what login does
    env.settings.providers.ep2 = { provider: "x", url: "u" };
    await env.settingsFlush();
    expect(existsSync(join(user, "auth-ep.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8")).providers.ep2).toEqual({ provider: "x", url: "u" });
    expect(existsSync(join(pkg, "settings.json"))).toBe(false);
    // a LOCAL scope login uses the project's namespaced files
    (await env._sourceGraph.authFileCreate("lp", { scope: "project" })).assign(["lp"], { auth: { token: "lt" } });
    await env.settingsFlush();
    expect(existsSync(join(pkg, projectAuth("lp")))).toBe(true); // cwd === pkg here
  });

  test("settings writes preserve unrelated settings and all endpoints after flush", async () => {
    const pkg = mk("pkg");
    const user = mk("user");
    writeFileSync(join(user, "settings.json"), JSON.stringify({ keep: { value: 1 }, providers: { existing: { provider: "x", url: "http://old" } } }));
    const env = await Env.open(pkg, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
    env.settings.providers.first = { provider: "x", url: "http://first" };
    env.settings.providers.second = { provider: "x", url: "http://second" };
    await env.settingsFlush();
    expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8")).providers.first).toEqual({ provider: "x", url: "http://first" });
    expect(endpointOf(env, "second")).toEqual({ provider: "x", url: "http://second" }); // the live registry is the same record
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

describe("the settings view: defaults, derived values, and delta persistence", () => {
  let root;
  beforeEach(() => { root = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "settings-view-"))); });
  afterEach(async () => {
    await Promise.all(Object.values(Env.envs).filter((env) => env.folder === root || env.folder.startsWith(`${root}/`)).map((env) => env.close()));
    rmSync(root, { recursive: true, force: true });
  });
  const layers = () => {
    const pkg = join(root, "pkg"), user = join(root, "user"), project = join(root, "project");
    for (const dir of [pkg, user, project]) mkdirSync(dir, { recursive: true });
    return { pkg, user, project };
  };

  test("a nested write changes only that key in the owning file; other layers stay byte-identical", async () => {
    const { pkg, user, project } = layers();
    writeFileSync(join(pkg, "settings.json"), JSON.stringify({ tui: { alt: true } }));
    writeFileSync(join(user, "settings.json"), '{\n  "keep": [1, 2],\n  "tui": { "theme": "default", "cursor": { "blink": 450 } }\n}\n');
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ other: 1 }));
    const before = { pkg: readFileSync(join(pkg, "settings.json"), "utf8"), project: readFileSync(join(project, NAMES.projectSettings), "utf8") };
    const env = await Env.open(project, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
    env.settings.tui.cursor.blink = 900;
    await env.settingsFlush();
    expect(env.settings.tui.cursor.blink).toBe(900); // the live view answers at once

    expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8"))).toEqual({
      keep: [1, 2], tui: { theme: "default", cursor: { blink: 900 } },
    });
    expect(readFileSync(join(pkg, "settings.json"), "utf8")).toBe(before.pkg); // never the package folder
    expect(readFileSync(join(project, NAMES.projectSettings), "utf8")).toBe(before.project);
  });

  test("the project file owns a path it already holds; a trusted-only key never lands there", async () => {
    const { pkg, user, project } = layers();
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ tui: { alt: false } }));
    const env = await Env.open(project, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
    env.settings.tui.alt = true;
    env.settings.sessions_source = undefined; // an unknown key's delete is a no-op write
    await env.settingsFlush();

    expect(JSON.parse(readFileSync(join(project, NAMES.projectSettings), "utf8"))).toEqual({ tui: { alt: true } });
    expect(existsSync(join(user, "settings.json"))).toBe(false); // nothing else changed
    expect(() => { env.settings.sessions = "elsewhere"; }).toThrow(/derived/);
  });

  test("reads apply schema defaults; settings.sessions is the resolved folder", async () => {
    const { pkg, user, project } = layers();
    writeFileSync(join(user, "settings.json"), JSON.stringify({ tui: { theme: "mine" } }));
    const env = await Env.open(project, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
    expect(env.settings.tui.theme).toBe("mine");
    expect(env.settings.tui.cursor.shape).toBe("line"); // a default fills what no layer sets
    expect(env.settings.modelAccess).toBeUndefined();
    expect(env.settings.sessions).toBe(join(user, NAMES.sessionsDir));
    expect(JSON.parse(JSON.stringify(env.settings.tui))).toMatchObject({ theme: "mine", alt: true });
  });

  test("global theme descends to each app, whose own setting overrides it independently", async () => {
    const { pkg, user, project } = layers();
    writeFileSync(join(user, "settings.json"), JSON.stringify({ theme: "night" }));
    const env = await Env.open(project, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
    expect(env.settings.tui.theme).toBe("night");
    expect(env.settings.web.theme).toBe("night");
    env.settings.web.theme = "light";
    await env.settingsFlush();
    expect(env.settings.tui.theme).toBe("night");
    expect(env.settings.web.theme).toBe("light");
    env.settings.tui.theme = "day";
    await env.settingsFlush();
    expect(env.settings.tui.theme).toBe("day");
    expect(env.settings.web.theme).toBe("light");

    expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8"))).toEqual({ theme: "night", tui: { theme: "day" }, web: { theme: "light" } });
    delete env.settings.web.theme;
    await env.settingsFlush();
    expect(env.settings.web.theme).toBe("night");
    env.settings.theme = "dusk";
    await env.settingsFlush();
    expect(env.settings.web.theme).toBe("dusk");
    expect(env.settings.tui.theme).toBe("day");

    expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8"))).toEqual({ theme: "dusk", tui: { theme: "day" } });
  });

  test("deleting a key removes it from memory and its owning file", async () => {
    const { pkg, user, project } = layers();
    writeFileSync(join(user, "settings.json"), JSON.stringify({ web: { theme: "dark", autocomplete: false } }));
    const env = await Env.open(project, { dir: pkg, settingsDir: user, init: { providers: false, tools: false, models: false } });
    delete env.settings.web.theme;
    await env.settingsFlush();
    expect(env.settings.web.theme).toBe("system"); // the default answers again

    expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8"))).toEqual({ web: { autocomplete: false } });
  });
});
