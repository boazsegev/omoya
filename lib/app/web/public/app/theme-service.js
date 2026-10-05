/** Document-level appearance; no view dependency. */
import { state, readPref } from "./state.js";
import { themeAppearance } from "./logic/theme.js";
export const dark = matchMedia("(prefers-color-scheme: dark)");
export function themeModeChoice() { return ["system", "light", "dark"].includes(readPref("omoya.web.namedThemeMode", "system")) ? readPref("omoya.web.namedThemeMode", "system") : "system"; }
export function selectedTheme() { return state.prefs.activeTheme && state.prefs.themes?.includes(state.prefs.activeTheme) ? state.prefs.activeTheme : state.prefs.theme ?? "system"; }
export function updateAppearanceSwitch() {
  const selected = selectedTheme();
  const mode = ["system", "light", "dark"].includes(selected) ? selected : themeModeChoice();
  for (const option of document.querySelectorAll(".appearance-option")) option.setAttribute("aria-pressed", String(option.dataset.mode === mode));
}
export function applyThemeName(name) {
  const { theme, mode } = themeAppearance(name, state.prefs, dark.matches, themeModeChoice());
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.colorScheme = mode;
  queueMicrotask(() => document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.body).backgroundColor));
}
export function applyTheme() { applyThemeName(selectedTheme()); }
export function initTheme(refresh) {
  dark.addEventListener("change", () => { applyTheme(); if (document.querySelector("#themes-panel")) refresh(); });
  applyTheme();
}
