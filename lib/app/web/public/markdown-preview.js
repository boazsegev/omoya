import { renderMarkdown } from "./markdown.js";
import { state } from "./app/state.js";
import { applyThemeName } from "./app/theme-service.js";
const status = document.querySelector('[role="status"]');
const appearance = matchMedia("(prefers-color-scheme: dark)");
let themeName = "system";
function applyAppearance() { applyThemeName(themeName); }
appearance.addEventListener("change", applyAppearance);
window.addEventListener("storage", (event) => { if (event.key === "omoya.web.namedThemeMode") applyAppearance(); });
try {
  const url = new URL("files/markdown", location.href); url.search = location.search;
  const themeUrl = new URL("files/theme", location.href); themeUrl.search = location.search;
  const [response, themeResponse] = await Promise.all([fetch(url), fetch(themeUrl)]);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Preview failed");
  if (!themeResponse.ok) throw new Error("Could not load the project theme");
  state.prefs = { ...state.prefs, ...await themeResponse.json() };
  themeName = state.prefs.activeTheme ?? state.prefs.theme ?? "system";
  const css = new URL("themes.css", location.href); css.search = location.search;
  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = css.href;
  await new Promise((resolve, reject) => { link.onload = resolve; link.onerror = () => reject(new Error("Could not load theme styles")); document.head.append(link); });
  applyAppearance();
  document.title = `${data.name} — Markdown preview`;
  document.querySelector("h1").textContent = data.name;
  document.querySelector("article").innerHTML = renderMarkdown(data.text);
  status.textContent = "Read-only preview";
} catch (error) { status.textContent = error.message; }
