import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { themeChoices, themeAppearance } from "../lib/app/web/public/app/logic/theme.js";
import { themeCss } from "../lib/app/web/theme-tokens.js";

const css = readFileSync(new URL("../lib/app/web/public/style.css", import.meta.url), "utf8");

test("documentation motion is scoped to welcome, interactive cards, and open details", () => {
  expect(css).toContain(".empty-state > * { animation: welcome-rise");
  expect(css).toContain(".preset-card:hover, .theme-card:hover { transform: translateY(-2px)");
  expect(css).toContain(".msg-tool[open] > .tool-body");
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none !important/);
});

test("theme listing is alphabetical without a system sentinel", () => {
  expect(themeChoices(["zulu", "alpha", "system", "alpha"])).toEqual(["alpha", "dark", "light", "zulu"]);
  expect(css).toContain(".header-actions .icon-button { font-size: 1em;");
  expect(css).toContain(".connection-state { display: inline-flex; align-items: center;");
});

test("dual-mode themes follow the OS unless appearance is selected", () => {
  const prefs = { themes: ["custom", "single"], dualThemes: ["custom"], themeModes: { single: "dark" } };
  expect(themeAppearance("custom", prefs, true)).toEqual({ theme: "custom", mode: "dark" });
  expect(themeAppearance("custom", prefs, true, "light")).toEqual({ theme: "custom", mode: "light" });
  expect(themeAppearance("single", prefs, false)).toEqual({ theme: "single", mode: "dark" });
  expect(themeAppearance("system", prefs, false)).toEqual({ theme: "", mode: "light" });
  const env = { settings: { tui: { themes: { custom: { light: { background: { bg: "#ffffff" } }, dark: { background: { bg: "#000000" } } } } } } };
  const output = themeCss(env, "custom");
  expect(output).toContain('.theme-card[data-theme="custom"]');
  expect(output).toContain("data-mode");
});
