import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../lib/app/web/public/style.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../lib/app/web/server.js", import.meta.url), "utf8");

test("documentation motion is scoped to welcome, interactive cards, and open details", () => {
  expect(css).toContain(".empty-state > * { animation: welcome-rise");
  expect(css).toContain(".preset-card:hover, .theme-card:hover { transform: translateY(-2px)");
  expect(css).toContain(".msg-tool[open] > .tool-body");
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none !important/);
});

test("theme listing is alphabetical and the header owns the three-way appearance selector", () => {
  expect(server).toContain('themes: ["dark", "light", ...themeNames()].sort((a, b) => a.localeCompare(b))');
  expect(app).toContain('.filter((item) => item !== "system").sort((a, b) => a.localeCompare(b))');
  expect(app).toContain('[["system", "◐", "Follow system appearance"], ["light", "☀", "Light appearance"], ["dark", "☾", "Dark appearance"]]');
  expect(css).toContain('.header-actions .icon-button { font-size: 1em;');
  expect(css).toContain('.connection-state { display: inline-flex; align-items: center; gap: .4rem; margin-right: .4rem; color: var(--muted); font-size: 1em;');
});

test("dual-mode themes have mode-scoped CSS, OS-following selection and swatches", () => {
  expect(server).toContain('return isDualTheme(env.settings.tui.themes, name) ? [rule("light"), rule("dark")]');
  expect(server).toContain('.theme-card[data-theme="${name}"]${suffix}');
  expect(app).toContain('document.documentElement.dataset.mode = mode;');
  expect(app).toContain('dark.addEventListener("change", () => { applyTheme();');
  expect(app).toContain('option.setAttribute("aria-pressed", String(option.dataset.mode === mode))');
  expect(app).toContain('appearance.setAttribute("aria-label", "Appearance")');
});
