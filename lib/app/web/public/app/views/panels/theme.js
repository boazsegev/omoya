import { el, button } from "../../dom.js";
/** theme.js — Named theme selection, appearance mode, and theme preview UI. */
import { state } from "../../state.js";
import { themeChoices } from "../../logic/theme.js";
import { dark, themeModeChoice, selectedTheme, applyThemeName, applyTheme, updateAppearanceSwitch } from "../../theme-service.js";
/**
 * Select a theme, apply it, and persist it on the server.
 * @param {string} name - theme name or "system"/"light"/"dark".
 * @returns {void}
 */
function chooseTheme(name) {
  state.prefs = { ...state.prefs, theme: name, activeTheme: ["system", "light", "dark"].includes(name) ? null : name };
  applyTheme();
  updateAppearanceSwitch();
  emit("server", { type: "settings.theme", name });
  emit("panels.refresh");
}
/**
 * Open the themes dialog.
 * @returns {void}
 */
function openThemes() {
  emit("dialog.open", { id: "themes-panel", title: "Themes", wide: true, onClose: applyTheme });
  renderThemesBody();
}
/**
 * Repaint the themes grid; hover/focus previews, click applies.
 * @returns {void}
 */
function renderThemesBody() {
  const body = document.querySelector("#themes-panel .panel-body");
  if (!body) return;
  body.replaceChildren(el("p", "muted small", "Hover or focus to preview · click to apply. Change light, dark or system appearance in the top-right header. Named themes are available in both apps; each app saves its own selection."));
  const grid = el("div", "theme-grid");
  const current = selectedTheme();
  for (const name of themeChoices(state.prefs.themes)) {
    const named = !["system", "light", "dark"].includes(name);
    const card = button("theme-card" + (name === current ? " current" : ""), null, () => chooseTheme(name));
    if (named) card.dataset.theme = name;
    card.dataset.mode = named ? (state.prefs.dualThemes?.includes(name) ? (themeModeChoice() === "system" ? (dark.matches ? "dark" : "light") : themeModeChoice()) : (state.prefs.themeModes?.[name] ?? (dark.matches ? "dark" : "light"))) : name === "system" ? (dark.matches ? "dark" : "light") : name;
    const swatch = el("span", "theme-swatch");
    swatch.append(el("span", "sw-bg"), el("span", "sw-fg"), el("span", "sw-accent"), el("span", "sw-user"));
    card.append(swatch, el("span", "theme-name", name), el("span", "theme-mode", named ? (state.prefs.dualThemes?.includes(name) ? (themeModeChoice() === "system" ? "follows OS" : themeModeChoice()) : (state.prefs.themeModes?.[name] ?? "follows OS")) : name === "system" ? "follows OS" : "built-in"));
    if (name === current) card.append(el("span", "badge", "current"));
    const preview = () => applyThemeName(name);
    card.addEventListener("mouseenter", preview);
    card.addEventListener("focus", preview);
    card.addEventListener("mouseleave", applyTheme);
    card.addEventListener("blur", applyTheme);
    grid.append(card);
  }
  body.append(grid);
}

export { chooseTheme, openThemes, renderThemesBody };

let emit = () => {};
export function mount(_root, { emit: dispatch }) { emit = dispatch; }
