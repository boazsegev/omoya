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

test("sidebar section titles use the theme's markdown heading color and bold weight", () => {
  expect(css).toMatch(/\.section-head h1\s*\{[^}]*color:\s*var\(--heading,\s*var\(--fg\)\)/);
  expect(css).toMatch(/\.section-head h1\s*\{[^}]*font-weight:\s*700/);
  expect(css).toMatch(/\.project-sessions-name\s*\{[^}]*color:\s*var\(--heading,\s*var\(--fg\)\)/);
  const env = { settings: { themes: { custom: { "md.heading": { fg: "#abcdef", bold: true } } } } };
  expect(themeCss(env, "custom")).toContain("--heading:#abcdef");
});

test("both jump links share the dock's stacking level, above hovered message rows", () => {
  expect(css).toMatch(/\.jump-bottom, \.jump-top\s*\{[^}]*z-index:\s*4;/);
  expect(css).toMatch(/\.message-row:hover, \.message-row:focus-within\s*\{\s*z-index:\s*3;/);
});

test("queued tool calls stay still; only composing and running calls spin", () => {
  const spinning = css.match(/^([^{\n]*)\{[^}]*animation: spin[^}]*\}/m)?.[1] ?? "";
  expect(spinning).toContain(".tool-running .tool-state");
  expect(spinning).not.toContain("tool-queued");
  expect(css).toMatch(/\.tool-queued \.tool-state\s*\{[^}]*dashed/);
});

test("theme listing is alphabetical without a system sentinel", () => {
  expect(themeChoices(["zulu", "alpha", "system", "alpha"])).toEqual(["alpha", "dark", "light", "zulu"]);
  expect(css).toContain(".header-actions .icon-button { font-size: 1em;");
  expect(css).toContain(".connection-state { display: inline-flex; align-items: center;");
});

test("the page uses theme-derived gradients without texture and translucent conversation surfaces", () => {
  expect(css).toContain("radial-gradient(ellipse at 50% 18%, var(--page-glow)");
  expect(css).toContain("--page-glow: color-mix(in srgb, var(--accent)");
  expect(css).toContain("--surface-glass: color-mix(in srgb, var(--surface) 88%, transparent)");
  expect(css).toMatch(/\.session-sidebar\s*\{[^}]*background: var\(--surface-glass\)/);
  expect(css).toMatch(/\.composer\s*\{[^}]*background: var\(--surface-glass\)/);
  expect(css).not.toMatch(/url\([^)]*(?:noise|texture|grain)/);
});

test("dual-mode themes follow the OS unless appearance is selected", () => {
  const prefs = { themes: ["custom", "single"], dualThemes: ["custom"], themeModes: { single: "dark" } };
  expect(themeAppearance("custom", prefs, true)).toEqual({ theme: "custom", mode: "dark" });
  expect(themeAppearance("custom", prefs, true, "light")).toEqual({ theme: "custom", mode: "light" });
  expect(themeAppearance("single", prefs, false)).toEqual({ theme: "single", mode: "dark" });
  expect(themeAppearance("system", prefs, false)).toEqual({ theme: "", mode: "light" });
  const env = { settings: { themes: { custom: { light: { background: { bg: "#ffffff" } }, dark: { background: { bg: "#000000" } } } } } };
  const output = themeCss(env, "custom");
  expect(output).toContain('.theme-card[data-theme="custom"]');
  expect(output).toContain("data-mode");
});
