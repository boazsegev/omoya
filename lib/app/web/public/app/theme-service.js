/** Document-level appearance; no view dependency. */
import { state, readPref } from "./state.js";
import { themeAppearance } from "./logic/theme.js";
export const dark = matchMedia("(prefers-color-scheme: dark)");
export function themeModeChoice() { return ["system", "light", "dark"].includes(readPref("omoya.web.namedThemeMode", "system")) ? readPref("omoya.web.namedThemeMode", "system") : "system"; }
export function selectedTheme() { return state.prefs.activeTheme && state.prefs.themes?.includes(state.prefs.activeTheme) ? state.prefs.activeTheme : state.prefs.theme ?? "system"; }
export function updateAppearanceSwitch() {
  const selected = selectedTheme();
  const mode = ["system", "light", "dark"].includes(selected) ? selected : themeModeChoice();
  for (const option of document.querySelectorAll(".appearance-option")) {
    const pressed = String(option.dataset.mode === mode);
    if (option.getAttribute("aria-pressed") !== pressed) option.setAttribute("aria-pressed", pressed);
  }
}
export function applyThemeName(name) {
  const { theme, mode } = themeAppearance(name, state.prefs, dark.matches, themeModeChoice());
  const root = document.documentElement;
  let changed = false;
  if (root.classList.contains("dark") !== (mode === "dark")) { root.classList.toggle("dark", mode === "dark"); changed = true; }
  if (root.dataset.theme !== theme) { root.dataset.theme = theme; changed = true; }
  if (root.dataset.mode !== mode) { root.dataset.mode = mode; changed = true; }
  if (root.style.colorScheme !== mode) { root.style.colorScheme = mode; changed = true; }
  if (changed) queueMicrotask(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const color = getComputedStyle(document.body).backgroundColor;
    if (meta.getAttribute("content") !== color) meta.setAttribute("content", color);
  });
}
export function applyTheme() { applyThemeName(selectedTheme()); }
/** Refetch generated theme rules after the server reads changed settings. */
export function refreshThemeStyles(version, url = "themes.css") {
  const link = document.querySelector("#theme-styles");
  if (!link) return;
  const current = new URL(link.href, document.baseURI);
  const target = new URL(url, document.baseURI);
  // The HTML already fetched this project's initial CSS. A version-zero
  // settings packet must not turn that same URL into a second HTTP request.
  const loadedVersion = current.searchParams.get("v");
  if (current.origin === target.origin && current.pathname === target.pathname
    && (loadedVersion === String(version) || loadedVersion === null && version === 0)) return;
  target.searchParams.set("v", String(version));
  link.href = target.href;
}
export function initTheme(refresh) {
  dark.addEventListener("change", () => { applyTheme(); if (document.querySelector("#themes-panel")) refresh(); });
  applyTheme();
}
