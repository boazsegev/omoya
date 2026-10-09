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
const rendered = new WeakMap();
function renderThemesBody() {
  const body = document.querySelector("#themes-panel .panel-body");
  if (!body) return;
  const choices = themeChoices(state.prefs.themes);
  const signature = JSON.stringify(choices);
  const current = selectedTheme();
  const updateCard = (card, name) => {
    const named = !["system", "light", "dark"].includes(name);
    const dual = state.prefs.dualThemes?.includes(name);
    const choice = themeModeChoice();
    const mode = named ? (dual ? (choice === "system" ? (dark.matches ? "dark" : "light") : choice) : (state.prefs.themeModes?.[name] ?? (dark.matches ? "dark" : "light"))) : name === "system" ? (dark.matches ? "dark" : "light") : name;
    if (card.dataset.mode !== mode) card.dataset.mode = mode;
    const label = named ? (dual ? (choice === "system" ? "follows OS" : choice) : (state.prefs.themeModes?.[name] ?? "follows OS")) : "built-in";
    const detail = card.querySelector(".theme-mode");
    if (detail.textContent !== label) detail.textContent = label;
    const selected = name === current;
    if (card.classList.contains("current") !== selected) card.classList.toggle("current", selected);
    if (card.getAttribute("aria-pressed") !== String(selected)) card.setAttribute("aria-pressed", String(selected));
    const badge = card.querySelector(".badge");
    if (selected && !badge) card.append(el("span", "badge", "current"));
    else if (!selected && badge) badge.remove();
  };
  if (rendered.get(body)?.signature === signature) {
    for (const [name, card] of rendered.get(body).cards) updateCard(card, name);
    return;
  }
  const cards = new Map();
  rendered.set(body, { signature, cards });
  body.replaceChildren(el("p", "muted small", "Hover or focus to preview · click to apply. Change light, dark or system appearance in the top-right header. Named themes are available in both apps; each app saves its own selection."));
  const grid = el("div", "theme-grid");
  for (const name of choices) {
    const named = !["system", "light", "dark"].includes(name);
    const card = button("theme-card" + (name === current ? " current" : ""), null, () => chooseTheme(name));
    if (named) card.dataset.theme = name;
    const swatch = el("span", "theme-swatch");
    swatch.append(el("span", "sw-bg"), el("span", "sw-fg"), el("span", "sw-accent"), el("span", "sw-user"));
    card.append(swatch, el("span", "theme-name", name), el("span", "theme-mode"));
    updateCard(card, name);
    cards.set(name, card);
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
