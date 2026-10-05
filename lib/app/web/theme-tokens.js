/** Internal web theme resolution. */
const THEME_VARS = [
  ["--fg", "text"], ["--muted", "muted"], ["--accent", "accent"], ["--border", "border"], ["--danger", "error"],
  ["--border-active", "input.border.active"],
  ["--user-fg", "message.user"], ["--user-bg", "message.user", "bg"], ["--user-rail", "message.user.border"],
  ["--assistant-fg", "message.text"], ["--assistant-rail", "message.text.border"],
  ["--thinking-fg", "message.thinking"], ["--thinking-rail", "message.thinking.border"],
  ["--system-fg", "message.system"], ["--system-rail", "message.system.border"],
  ["--tool-call", "tool.call"], ["--tool-ok", "tool.result"], ["--tool-err", "tool.error"], ["--tool-display", "tool.display"],
  ["--code-fg", "md.code"], ["--code-bg", "md.code", "bg"], ["--link", "md.link"], ["--heading", "md.heading"],
  ["--strong", "md.strong"], ["--em", "md.em"], ["--quote", "md.quote"], ["--list-marker", "md.list"],
  ["--diff-add", "md.diff.add"], ["--diff-remove", "md.diff.remove"], ["--diff-hunk", "md.diff.hunk"],
  ["--selection-fg", "selection"], ["--selection-bg", "selection", "bg"],
  ["--menu-selected-fg", "menu.selected"], ["--menu-selected-bg", "menu.selected", "bg"],
  ["--status-idle", "status.idle"], ["--status-busy", "status.busy"], ["--queue", "queue"],
  ["--notice", "notice"], ["--notice-action", "notice.action"], ["--cursor", "cursor"],
];
const HEX = /^#[0-9a-f]{3,8}$/i;

/** Merge theme roles, shallow-merging object-valued role tokens.
 * @param {object} base - Inherited role map.
 * @param {object} next - Role overrides.
 * @returns {object} A new merged role map.
 */
function mergeThemeRoles(base, next) {
  const merged = { ...base };
  for (const [role, value] of Object.entries(next)) {
    const previous = merged[role];
    merged[role] = previous && typeof previous === "object" && !Array.isArray(previous)
      && value && typeof value === "object" && !Array.isArray(value) ? { ...previous, ...value } : value;
  }
  return merged;
}
/** Resolve shared/light/dark layers through a cycle-safe theme parent chain.
 * @param {object} themes - Named theme definitions.
 * @param {string} name - Theme to resolve.
 * @param {Set<string>} [seen=new Set()] - Names already visited on this traversal.
 * @returns {{shared: object, light: object, dark: object}} Resolved inherited layers; invalid/cyclic names yield empty layers.
 */
function themeLayers(themes, name, seen = new Set()) {
  const value = themes?.[name];
  if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(name)) return { shared: {}, light: {}, dark: {} };
  seen.add(name);
  const { parent, light, dark, ...tokens } = value;
  const inherited = typeof parent === "string" && parent !== "default" ? themeLayers(themes, parent, seen) : { shared: {}, light: {}, dark: {} };
  return {
    shared: mergeThemeRoles(inherited.shared, tokens),
    light: mergeThemeRoles(inherited.light, light && typeof light === "object" && !Array.isArray(light) ? light : {}),
    dark: mergeThemeRoles(inherited.dark, dark && typeof dark === "object" && !Array.isArray(dark) ? dark : {}),
  };
}
/** Resolve theme tokens, optionally overlaying the selected appearance mode.
 * @param {object} themes - Named theme definitions.
 * @param {string} name - Theme to resolve.
 * @param {('light'|'dark'|null)} [mode=null] - Layer to overlay, or null for shared tokens only.
 * @returns {object} Resolved token map.
 */
function resolveThemeTokens(themes, name, mode = null) {
  const layers = themeLayers(themes, name);
  return mode ? mergeThemeRoles(layers.shared, layers[mode]) : layers.shared;
}
/** Test whether a theme or one of its ancestors defines mode-specific tokens.
 * @param {object} themes - Named theme definitions.
 * @param {string} name - Theme to inspect.
 * @param {Set<string>} [seen=new Set()] - Names already visited on this traversal.
 * @returns {boolean} Whether either light or dark tokens are defined.
 */
function isDualTheme(themes, name, seen = new Set()) {
  const value = themes?.[name];
  if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(name)) return false;
  seen.add(name);
  return (value.light && typeof value.light === "object" && !Array.isArray(value.light))
    || (value.dark && typeof value.dark === "object" && !Array.isArray(value.dark))
    || (typeof value.parent === "string" && isDualTheme(themes, value.parent, seen));
}

/** Collapsed-block preview heights, in rows, per semantic block. The
 *  defaults mirror the TUI's default theme (lib/tui-app/theme-data.js —
 *  not importable here: the web app never depends on tui-app); a theme's
 *  `<role>.preview.maxRows` overrides them, false = uncapped. */
const PREVIEW_DEFAULTS = Object.freeze({ system: 8, thinking: 8, tool: 7 });
const PREVIEW_ROLES = Object.freeze({ system: "message.system.preview", thinking: "message.thinking.preview", tool: "tool.preview" });
/** Calculate collapsed-preview row limits for semantic block kinds.
 * @param {object} [tokens={}] - Theme token map containing preview overrides.
 * @returns {object} Per-kind row limits, with false representing uncapped.
 */
function themePreviewRows(tokens = {}) {
  return Object.fromEntries(Object.entries(PREVIEW_ROLES).map(([kind, role]) => {
    const value = tokens?.[role]?.maxRows;
    return [kind, value === false || (Number.isInteger(value) && value > 0) ? value : PREVIEW_DEFAULTS[kind]];
  }));
}

/** Infer light/dark appearance from a theme canvas color or, as fallback, text color.
 * @param {object} tokens - Theme token map.
 * @returns {('dark'|'light'|null)} Inferred mode, or null without a valid hex color.
 */
function themeMode(tokens) {
  const hex = HEX.test(tokens?.background?.bg ?? "") ? tokens.background.bg : HEX.test(tokens?.text?.fg ?? "") ? tokens.text.fg : null;
  if (!hex) return null;
  const full = hex.length <= 5 ? [...hex.slice(1, 4)].map((c) => c + c).join("") : hex.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fromText = !HEX.test(tokens?.background?.bg ?? "");
  return (luminance < 0.5) !== fromText ? "dark" : "light";
}

/** Convert displayable scalar values to strings, mapping other values to empty text.
 * @param {*} value - Value to convert.
 * @returns {string} String representation or an empty string.
 */
const display = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
/** Serialize supported theme animations as CSS custom-property declarations.
 * @param {object} theme - Resolved theme tokens.
 * @returns {string} CSS declarations, or an empty string when none are supported.
 */
function themeAnimation(theme) {
  const busy = theme?.["status.busy"]?.animation;
  const border = theme?.["input.border.active.bottom"]?.animation ?? theme?.["input.border.active.top"]?.animation;
  // Convert one supported animation descriptor to CSS declarations.
  const value = (animation, prefix) => {
    const data = typeof animation === "string" ? { type: animation } : animation;
    if (!data || typeof data !== "object" || !["wave", "flash", "comet"].includes(data.type)) return "";
    const period = Math.max(100, Math.min(10_000, Number(data.period ?? data.crossing) || (data.type === "wave" ? 850 : 1400)));
    const colors = Array.isArray(data.colors ?? data.head) ? (data.colors ?? data.head).filter((color) => typeof color === "string" && HEX.test(color)).slice(0, 8) : [];
    return `${prefix}-animation-name:web-${data.type};${prefix}-duration:${period}ms${colors.map((color, index) => `;${prefix}-color-${index}:${color}`).join("")}`;
  };
  return [value(busy, "--working"), value(border, "--input-border")].filter(Boolean).join(";");
}


export { resolveThemeTokens, themeMode, isDualTheme, themePreviewRows };

  /** Generate browser CSS for a configured theme.
   * @param {string} name - Theme name.
   * @returns {string|null} CSS rules, or null for invalid/missing themes.
   */
  export const themeCss = (env, name) => {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) return null;
    if (!env.settings?.tui?.themes?.[name] || typeof env.settings.tui.themes[name] !== "object") return null;
    // Build the CSS rule for shared tokens or one appearance mode.
    const rule = (mode) => {
      const theme = resolveThemeTokens(env.settings.tui.themes, name, mode);
      // Return a valid hex token color for a role/key pair.
      const color = (role, key = "fg") => typeof theme[role]?.[key] === "string" && HEX.test(theme[role][key]) ? theme[role][key] : null;
      // No canvas token means the browser's light/dark palette remains the base.
      const background = color("background", "bg");
      const values = {
        ...(background ? { "--page": background, "--surface": background, "--surface-2": background } : {}),
        ...Object.fromEntries(THEME_VARS.map(([variable, role, key]) => [variable, color(role, key)])),
      };
      const css = Object.entries(values).filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join(";");
      const animation = themeAnimation(theme);
      const suffix = mode ? `[data-mode="${mode}"]` : "";
      return `:root[data-theme="${name}"]${suffix}{${css}${animation ? `;${animation}` : ""}}\n.theme-card[data-theme="${name}"]${suffix}{${css}}`;
    };
    return isDualTheme(env.settings.tui.themes, name) ? [rule("light"), rule("dark")].join("\n") : rule(null);
  };
