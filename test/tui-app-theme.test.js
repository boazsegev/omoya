// test/tui-app-theme.test.js — proof for Phase 03 step 5 (Theme
// settings): tui.theme/tui.themes are discoverable in the settings
// schema (lib/env/settings-schema.js, discovery-only per that file's
// own contract — never enforcement there), and lib/tui-app/theme-data.js
// resolves them into tokens ready for GTUI's theme mechanism (Phase 02,
// lib/gtui/theme.js) with real fallback (unknown theme name) and
// reject (malformed shapes) behavior.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { Env } from "../lib/env.js";
import { createTheme } from "../lib/gtui/theme.js";
import { ITALIC } from "../lib/gtui/cell.js";
import { DEFAULT_THEME, resolveTheme, themePreviewRows } from "../lib/tui-app/theme-data.js";

describe("bundled themes", () => {
  test("declare an explicit global background so hosts never infer one from text colors", () => {
    const files = readdirSync("themes").filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(`themes/${file}`, "utf8"));
      const theme = Object.values(parsed.tui.themes)[0];
      expect(theme.background?.bg).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("tui.theme / tui.themes: discoverable in the settings schema", () => {
  test("both keys default and describe themselves, before any tool loads", () => {
    const dir = mkdtempSync("./ai-tmp/theme-schema-");
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    const schema = env.defaultsSchema();
    expect(schema.tui.default.theme).toBe("default");
    expect(schema.tui.default.themes).toEqual({});
    expect(schema.tui.description).toEqual(expect.any(String));
  });
});

describe("resolveTheme: fallback and reject", () => {
  test("no settings at all resolves the built-in default theme", () => {
    expect(resolveTheme()).toBe(DEFAULT_THEME);
    expect(resolveTheme({})).toBe(DEFAULT_THEME);
  });

  test("a named theme LAYERS over the default — untouched roles survive", () => {
    const resolved = resolveTheme({ tui: { theme: "solar", themes: { solar: { "message.user": { fg: 220 } } } } });
    expect(resolved["message.user"]).toEqual({ fg: 220 });
    expect(resolved["tool.call"]).toEqual(DEFAULT_THEME["tool.call"]); // every other role: untouched
  });

  test("themes recursively inherit parents, then override roles", () => {
    const resolved = resolveTheme({ tui: { theme: "child", themes: {
      base: { accent: { fg: 12 }, "message.user": { fg: 220 } },
      middle: { parent: "base", accent: { fg: 13 } },
      child: { parent: "middle", error: { fg: 9 } },
    } } });
    expect(resolved.accent).toEqual({ fg: 13 });
    expect(resolved.error).toEqual({ fg: 9 });
    expect(resolved["message.user"]).toEqual({ fg: 220 });
    expect(resolved["tool.call"]).toEqual(DEFAULT_THEME["tool.call"]);
    expect(resolved.parent).toBeUndefined();
  });

  test("theme parents reject missing names, malformed values, and cycles", () => {
    expect(() => resolveTheme({ tui: { theme: "child", themes: { child: { parent: "missing" } } } })).toThrow(/parent "missing" does not exist/);
    expect(() => resolveTheme({ tui: { theme: "child", themes: { child: { parent: 7 } } } })).toThrow(/parent must be a non-empty theme name/);
    expect(() => resolveTheme({ tui: { theme: "a", themes: { a: { parent: "b" }, b: { parent: "a" } } } })).toThrow(/parent cycle: a -> b -> a/);
  });

  // Contract only: the shape of the caps map and that custom theme values
  // layer through — never the default theme's literal maxRows numbers
  // (those are content: free to change without touching this test).
  test("preview row caps expose the semantic map and layer custom values through named themes", () => {
    const rows = themePreviewRows(resolveTheme());
    expect(Object.keys(rows).sort()).toEqual(["display", "draft", "system", "text", "thinking", "toolcall", "toolerror", "toolresult", "user"]);
    const tokens = resolveTheme({ tui: { theme: "compact", themes: { compact: {
      "tool.preview": { maxRows: 3 }, "message.thinking.preview": { maxRows: 5 },
    } } } });
    const layered = themePreviewRows(tokens);
    expect(layered).toMatchObject({ toolcall: 3, toolresult: 3, toolerror: 3, thinking: 5 });
    expect(layered.system).toBe(rows.system); // untouched caps survive layering
  });

  test("invalid preview row caps are rejected at the app theme boundary", () => {
    const tokens = resolveTheme({ tui: { theme: "bad", themes: { bad: { "tool.preview": { maxRows: 0 } } } } });
    expect(() => themePreviewRows(tokens)).toThrow(/tool.preview.maxRows must be false or a positive integer/);
  });

  test("an UNKNOWN theme name falls back to default — never throws", () => {
    const resolved = resolveTheme({ tui: { theme: "nonexistent", themes: { solar: {} } } });
    expect(resolved).toBe(DEFAULT_THEME);
  });

  test("a non-string tui.theme is rejected", () => {
    expect(() => resolveTheme({ tui: { theme: 5 } })).toThrow(/tui.theme must be a non-empty string/);
    expect(() => resolveTheme({ tui: { theme: "" } })).toThrow(/tui.theme must be a non-empty string/);
  });

  test("a malformed tui.themes (or theme entry) is rejected", () => {
    expect(() => resolveTheme({ tui: { themes: ["not", "an", "object"] } })).toThrow(/tui.themes must be an object/);
    expect(() => resolveTheme({ tui: { themes: null } })).toThrow(/tui.themes must be an object/);
    expect(() => resolveTheme({ tui: { theme: "solar", themes: { solar: "not an object" } } })).toThrow(/tui.themes\["solar"\] must be an object/);
  });
});

describe("resolved tokens feed GTUI's own theme mechanism (Phase 02) end to end", () => {
  test("every default-theme role resolves without throwing, dark and light", () => {
    const tokens = resolveTheme();
    for (const dark of [true, false]) {
      const theme = createTheme(tokens, { dark });
      for (const role of Object.keys(tokens)) expect(() => theme.resolve(role)).not.toThrow();
    }
  });

  test("createTheme itself still rejects an invalid color value in a custom theme (Phase 02's own validation, not re-implemented here)", () => {
    const tokens = resolveTheme({ tui: { theme: "bad", themes: { bad: { "message.user": { fg: "not-a-color" } } } } });
    expect(() => createTheme(tokens, { dark: true }).resolve("message.user")).toThrow();
  });

  // Contract: a variant token resolves its dark/light side — which colors
  // the default theme picks (250/238) is content, not tested here.
  test("message.user picks the dark/light variant exactly like every other GTUI variant token", () => {
    expect(createTheme(resolveTheme(), { dark: true }).resolve("message.user").fg).toBe(DEFAULT_THEME["message.user"].fg.dark);
    expect(createTheme(resolveTheme(), { dark: false }).resolve("message.user").fg).toBe(DEFAULT_THEME["message.user"].fg.light);
  });

  // Contract: busy status animates, active input borders animate,
  // action notices are emphasized (never dim), md.em is italic. The
  // default theme's animation types/parameters and color picks are
  // content — asserted against DEFAULT_THEME, never as literals.
  test("status.busy animates and action notices are emphasized", () => {
    const theme = createTheme(resolveTheme(), { dark: true });
    expect(theme.animation("status.busy")).toEqual(DEFAULT_THEME["status.busy"].animation);
    expect(theme.animation("input.border.active.top")).toMatchObject(DEFAULT_THEME["input.border.active.top"].animation);
    expect(theme.animation("input.border.active.bottom")).toMatchObject({ type: DEFAULT_THEME["input.border.active.bottom"].animation });
    expect(theme.resolve("notice.action").attrs).not.toBe(0); // emphasized, never dim
    expect(theme.resolve("md.em").attrs & ITALIC).toBe(ITALIC);
  });
});
