import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import Env from "../lib/env.js";
import { defaultSettingsDir } from "../lib/env/paths.js";

async function fixture(fn) {
  const cwd = await mkdtemp("./ai-tmp/env-open-");
  const envs = [];
  try {
    return await fn(resolve(cwd), (env) => { envs.push(env); return env; });
  } finally {
    await Promise.allSettled(envs.map((env) => env.close()));
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("Env.open acquisition", () => {
  it("refuses direct construction and exposes only open for acquisition", () => {
    expect(() => new Env()).toThrow(/Env\.open/);
    expect(() => new Env({}, Symbol("invalid"))).toThrow(/Env\.open/);
    expect(Env.create).toBeUndefined();
    expect(Env.use).toBeUndefined();
  });

  it("coalesces concurrent path-only opens across folder aliases and returns initialized model/tool surfaces", async () => fixture(async (cwd, own) => {
    const link = `${cwd}-alias`;
    await symlink(cwd, link, "dir");
    try {
      const [a, b, c] = await Promise.all([Env.open(cwd), Env.open(join(cwd, ".")), Env.open(link)]);
      own(a);
      expect(a).toBe(b);
      expect(a).toBe(c);
      expect(Env.envs[cwd]).toBe(a);
      expect(a.folder).toBe(cwd);
      expect("cwd" in a).toBe(false);
      expect(a.models()).toBeInstanceOf(Map);
      expect(await a.tools()).toBeInstanceOf(Map);
      await a.modelsReady;
    } finally { await rm(link, { force: true }); }
  }));

  it("does not publish explicit embedding Envs or let path-only lookup return them", async () => fixture(async (cwd, own) => {
    const options = { settingsDir: null, init: { providers: false, tools: false } };
    const [embeddedA, embeddedB] = await Promise.all([Env.open(cwd, options), Env.open(cwd, options)]);
    own(embeddedA); own(embeddedB);
    expect(embeddedA).not.toBe(embeddedB);
    expect(embeddedA.closed).toBe(false);
    expect(Object.hasOwn(Env.envs, cwd)).toBe(false);
    const project = own(await Env.open(cwd));
    expect(project).not.toBe(embeddedA);
    expect(project).not.toBe(embeddedB);
    expect(Env.envs[cwd]).toBe(project);
    const emptyOptions = own(await Env.open(cwd, {}));
    expect(emptyOptions).toBe(project);
    const defaults = own(await Env.open(cwd, { themes: true, auth: true, settings: {}, providers: {}, init: { providers: true, tools: true, detect: true, models: true } }));
    expect(defaults).toBe(project);
    expect(own(await Env.open(cwd, { themes: undefined, settings: undefined, init: {} }))).toBe(project);
    expect(own(await Env.open(cwd, { dir: resolve("."), settingsDir: defaultSettingsDir() }))).toBe(project);
    const nonenumerable = Object.defineProperty({}, "init", { value: { tools: false } });
    expect(own(await Env.open(cwd, nonenumerable))).not.toBe(project);
    expect(Env.envs[cwd]).toBe(project);
    await embeddedA.close();
    expect(embeddedA.closed).toBe(true);
    expect(embeddedB.closed).toBe(false);
    expect(Env.envs[cwd]).toBe(project);
  }));

  it("allows close and reopen while retaining independent embedding environments", async () => fixture(async (cwd, own) => {
    const first = own(await Env.open(cwd));
    const embedded = own(await Env.open(cwd, { settingsDir: null, init: { providers: false, tools: false } }));
    await first.close();
    expect(first.closed).toBe(true);
    expect(embedded.closed).toBe(false);
    const second = own(await Env.open(cwd));
    expect(second).not.toBe(first);
    expect(Env.envs[cwd]).toBe(second);
  }));

  it("keeps explicit endpoint overrides in its memory layer, not persisted endpoint files", async () => fixture(async (cwd, own) => {
    const file = join(cwd, "ai-settings.json");
    const persisted = { providers: { custom: { provider: "openai", url: "https://saved.example", auth: { token: "saved" }, timeout: 120 } } };
    await writeFile(file, JSON.stringify(persisted));
    const project = own(await Env.open(cwd));
    const override = { providers: { custom: { url: "https://ephemeral.example", auth: { token: "temporary" }, timeout: 5 } } };
    const embedded = own(await Env.open(cwd, { settingsDir: null, settings: override, init: { providers: false, tools: false } }));
    expect(embedded.settings.providers.custom).toMatchObject({ provider: "openai", url: "https://ephemeral.example", auth: { token: "temporary" }, timeout: 5 });
    expect(project.settings.providers.custom).toMatchObject(persisted.providers.custom);
    expect(embedded._sourceGraph.settings.source).toBe(false);
    expect(embedded._sourceGraph.settings.own(["providers", "custom"])).toEqual(override.providers.custom);
    embedded.settings.providers.custom.url = "https://changed.example";
    embedded.settings.providers.custom.timeout = 9;
    await embedded.settingsFlush();
    expect(embedded.settings.providers.custom.url).toBe("https://changed.example");
    expect(embedded.settings.providers.custom.timeout).toBe(9);
    expect(project.settings.providers.custom).toMatchObject(persisted.providers.custom);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(persisted);
    await embedded.close();
    const replacement = own(await Env.open(cwd, { settingsDir: null, init: { providers: false, tools: false } }));
    expect(replacement.settings.providers.custom).toMatchObject(persisted.providers.custom);
  }));

  it("does not hand out an Env closed during concurrent startup or erase its replacement", async () => fixture(async (cwd, own) => {
    const old = own(await Env.open(cwd));
    const closing = old.close();
    await closing;
    const fresh = own(await Env.open(cwd));
    expect(fresh).not.toBe(old);
    expect(Env.envs[cwd]).toBe(fresh);
    expect(fresh.closed).toBe(false);
  }));

  it("cleans failed starts and permits a corrected retry", async () => fixture(async (cwd, own) => {
    await expect(Env.open(cwd, { settingsDir: null, toolDirs: [42], init: { providers: false } })).rejects.toThrow();
    expect(Object.hasOwn(Env.envs, cwd)).toBe(false);
    const env = own(await Env.open(cwd, { settingsDir: null, init: { providers: false, tools: false } }));
    expect(env.closed).toBe(false);
  }));

  it("validates options and preserves the path-only registry", async () => fixture(async (cwd, own) => {
    await expect(Env.open("", {})).rejects.toThrow(TypeError);
    await expect(Env.open(cwd, { cwd })).rejects.toThrow(TypeError);
    await expect(Env.open(cwd, { init: { unknown: true } })).rejects.toThrow(TypeError);
    await expect(Env.open(cwd, { unknown: true })).rejects.toThrow(TypeError);
    expect(Object.hasOwn(Env.envs, cwd)).toBe(false);
    own(await Env.open(cwd));
  }));
});
