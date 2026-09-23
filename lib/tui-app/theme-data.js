/**
 * lib/tui-app/theme-data.js — the default GTUI theme (ai roles only;
 * GTUI's own generic roles — text, muted, accent, error, border,
 * the input/menu/overlay families — already fall back sensibly, see
 * lib/gtui/theme.js) and `tui.theme`/`tui.themes` settings resolution.
 * Colors port the
 * SAME 256-color indices legacy's SGR constants named (basic 8-color
 * codes 30-37/90-97 map onto 256-color indices 0-7/8-15 one for one)
 * so the visual result matches — lib/gtui/cell.js always emits the
 * extended `38;5;<n>` SGR form (a Phase 02 choice, not this file's to
 * relitigate), so the ESCAPE BYTES differ from legacy's basic-code
 * form even at the same index; that's fine, a terminal renders both
 * identically. Literal byte-for-byte parity is Phase 03 step 6's job.
 */

import Env from "../env.js";

// Loading the TUI feature enables its theme settings layer without relying on
// import order or an executable mutating Env on the application's behalf.
Env._loadThemes = true;

// The "tui.theme"/"tui.themes" defaults ("default", {}) are duplicated
// here as literals rather than imported from lib/env/settings-schema.js:
// that file is a PRIVATE env implementation detail (only lib/env.js is
// the public façade lower modules may import — see base-architecture.test.js),
// and these two defaults are simple, stable constants anyway.
const DEFAULT_THEME_NAME = "default";
const DEFAULT_THEMES_MAP = {};

/** lib/tui-helpers/messages.js's TOOL_STYLE/TOOL_ERR_STYLE (dim green/red). */
const TOOL_OK = { dim: true, fg: 2 };
const TOOL_ERR = { dim: true, fg: 1 };

export const DEFAULT_THEME = Object.freeze({
  // No global background: the terminal itself remains the source of truth.
  // Named themes may opt in with `background: { bg }`.
  background: {},
  text: {},
  muted: { dim: true },
  accent: { fg: { dark: 45, light: 25, default: 6 } },
  error: { fg: 1 },
  border: { fg: { dark: 8, light: 7, default: 8 }, dim: true },
  "border.active": { fg: 3 },
  "input.text": {},
  "input.border": { fg: { dark: 8, light: 7, default: 8 }, dim: true },
  "input.border.active": { fg: 3 },
  "input.border.active.top": { fg: 3, animation: { type: "comet", mirror: true } },
  "input.border.active.bottom": { fg: 3, animation: "comet" },
  "input.selection": { reverse: true },
  "completion.text": { dim: true },
  "completion.selected": { reverse: true },
  "overlay.border": { fg: { dark: 8, light: 7, default: 8 } },
  "scroll.track": { fg: { dark: 8, light: 7, default: 8 }, dim: true },
  "scroll.thumb": { fg: { dark: 250, light: 238, default: 250 } },
  "message.system": { dim: true },
  "message.system.preview": { maxRows: 8 },
  "message.user": { fg: { dark: 250, light: 238, default: 250 }, bg: { dark: 8, light: 15, default: null }, decoration: { left: { glyph: "▌", role: "message.user.border", gap: 1 } } },
  "message.user.border": { fg: { dark: 8, light: 7, default: 8 } },
  "message.draft": { dim: true, strike: true },
  "message.thinking": { dim: true },
  "message.thinking.preview": { maxRows: 8 },
  "message.text": {},
  "tool.preview": { maxRows: 7 },
  "tool.call": { ...TOOL_OK, decoration: { left: { glyph: "▌", role: "tool.call", gap: 1 } } },
  "tool.result": { ...TOOL_OK, decoration: { left: { glyph: "▌", role: "tool.result", gap: 1 } } },
  "tool.error": { ...TOOL_ERR, decoration: { left: { glyph: "▌", role: "tool.error", gap: 1 } } },
  "tool.display": { dim: true, fg: 8, decoration: { left: { glyph: "▌", role: "tool.display", gap: 1 } } },
  notice: { dim: true },
  "notice.action": { fg: 3, bold: true },
  queue: { fg: 3 },
  "notice.error": { fg: 1 },
  "information.source": { dim: true },
  "information.text": {},
  "menu.title": { fg: 0, bg: 6 },
  "menu.header": { fg: 6, bold: true },
  "menu.text": {},
  "menu.current": { dim: true },
  "menu.selected": { reverse: true },
  "menu.footer": { dim: true },
  "question.text": { bold: true },
  "question.details": { dim: true },
  "question.preview": { fg: { dark: 8, light: 7, default: 8 } },
  "status.identity": { bold: true },
  "status.hints": { dim: true },
  "status.muted": { dim: true },
  "status.io": { fg: 6, bold: true, animation: { type: "flash", role: "accent" } },
  "status.idle": { bold: true },
  "status.busy": { bold: true, animation: { type: "wave", period: 850, mirror: true, colors: [220, 208, 220] } },
  "status.error": { fg: 1, bold: true },
  "md.strong": { bold: true },
  "md.em": { italic: true },
  "md.code": { fg: 2 },
  "md.quote": { dim: true, fg: 6, decoration: { left: { glyph: "│", role: "md.quote", gap: 1 } } },
  "md.heading": { bold: true },
  "md.hr": { dim: true },
  "md.table": {},
  "md.table.heading": { bold: true },
  "md.link": { underline: true },
  // Hover is an interaction overlay: it layers on the link's underline and
  // inherits each selected theme's palette rather than controls choosing one.
  "link.hover": { bg: { dark: 24, light: 153, default: 24 } },
  "md.diff.add": { fg: 2 },
  "md.diff.remove": { fg: 1 },
  "md.diff.hunk": { fg: 6 },
});

/**
 * Resolve the active theme's tokens from settings: `tui.theme` names an
 * entry in `tui.themes`, recursively layering its optional `parent`
 * before its own roles and ultimately over default; an unknown active name falls back to the default
 * theme alone — never a hard error. A malformed `tui.themes`/entry
 * (not a plain object) is rejected with a clear TypeError: this is
 * content this file owns, unlike settings-schema.js's discovery-only,
 * never-enforced keys.
 * @param {{tui?: {theme?: string, themes?: object}}} settings
 * @returns {object} tokens ready for lib/gtui/gtui.js's `host.terminal`/`GTUI` theme option
 */
export function resolveTheme(settings = {}) {
  const themeName = settings.tui?.theme ?? DEFAULT_THEME_NAME;
  if (typeof themeName !== "string" || themeName === "") {
    throw new TypeError(`tui.theme must be a non-empty string, got ${JSON.stringify(themeName)}`);
  }
  const themes = settings.tui && "themes" in settings.tui ? settings.tui.themes : DEFAULT_THEMES_MAP;
  if (themes === null || typeof themes !== "object" || Array.isArray(themes)) {
    throw new TypeError("tui.themes must be an object of theme name -> role tokens");
  }
  if (themeName === "default") return DEFAULT_THEME;
  if (themes[themeName] === undefined) return DEFAULT_THEME; // unknown active name: fall back, never throw

  function resolveNamed(name, chain = []) {
    if (name === "default") return DEFAULT_THEME;
    if (chain.includes(name)) throw new TypeError(`tui theme parent cycle: ${[...chain, name].join(" -> ")}`);
    const value = themes[name];
    if (value === undefined) throw new TypeError(`tui theme parent "${name}" does not exist`);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`tui.themes["${name}"] must be an object of role -> tokens`);
    }
    const parent = value.parent ?? "default";
    if (typeof parent !== "string" || parent === "") {
      throw new TypeError(`tui.themes["${name}"].parent must be a non-empty theme name`);
    }
    const { parent: ignored, ...tokens } = value;
    return { ...resolveNamed(parent, [...chain, name]), ...tokens };
  }

  return resolveNamed(themeName);
}

function previewRows(tokens, role, fallback = false) {
  const value = tokens?.[role]?.maxRows ?? fallback;
  if (value === false) return false;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${role}.maxRows must be false or a positive integer, got ${JSON.stringify(value)}`);
  return value;
}

/** Cached semantic-type capping map; false means uncapped. */
export function themePreviewRows(tokens = DEFAULT_THEME) {
  const tool = previewRows(tokens, "tool.preview", 3);
  return Object.freeze({ system: previewRows(tokens, "message.system.preview", 8), thinking: previewRows(tokens, "message.thinking.preview", 8),
    toolcall: tool, toolresult: tool, toolerror: tool, display: false, user: false, text: false, draft: false });
}
