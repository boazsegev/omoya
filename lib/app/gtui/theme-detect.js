/**
 * lib/gtui/theme-detect.js — best-effort terminal theme detection
 * (dark vs light), a host CAPABILITY (generic terminal primitive,
 * ported from the retired lib/tui-helpers/theme.js). The full theme
 * MECHANISM (token lookup, roles, fallback) lives in lib/gtui/theme.js
 * — this is only the environment probe it reads.
 *
 * Detection: the COLORFGBG environment variable ("<fg>;<bg>[;...]",
 * set by iTerm2, konsole, rxvt and others — Terminal.app and many
 * modern terminals do NOT set it). When it's absent or unparseable the
 * theme is UNKNOWN until the terminal host receives an OSC 11 background
 * reply. Terminals that do not answer retain the unknown fallback.
 */

/**
 * Detects whether the terminal background is dark from COLORFGBG.
 * Parses the background palette index in the environment value formatted
 * as `<foreground>;<background>[;...]`; indexes 0–6 are considered dark
 * and 7–15 light. An absent, blank, or unparseable value is unknown.
 * Does not modify the environment; reading COLORFGBG can propagate an
 * exception thrown by an environment object's getter.
 * @param {object|null} [env=process.env] Environment map to inspect.
 * @returns {boolean|null} `true` for dark, `false` for light, or `null` if unknown.
 */
export function themeDark(env = process.env) {
  const value = env?.COLORFGBG;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parts = value.split(";").map((p) => Number(p));
  const bg = parts.length >= 2 ? parts[1] : NaN;
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return null;
  return bg <= 6; // palette indexes 0-6 are the dark half by convention
}

/**
 * Classifies an OSC 11 `rgb:R/G/B` background-color reply as dark or light.
 * Each hexadecimal channel (1–4 digits, case-insensitive) is normalized,
 * converted to linear light, and combined using relative-luminance weights;
 * luminance below 0.18 is classified as dark. Malformed replies return null.
 * Does not explicitly modify the input. Non-string values are coerced to
 * strings; coercion side effects or errors from a custom conversion propagate,
 * and a Symbol causes a TypeError during regular-expression matching.
 * @param {string} value OSC 11 RGB reply to parse.
 * @returns {boolean|null} `true` if dark, `false` if light, or `null` if malformed.
 */
export function backgroundDark(value) {
  const match = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(value);
  if (!match) return null;
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / (16 ** part.length - 1));
  /**
   * Converts one normalized sRGB channel value to linear-light intensity.
   * @param {number} channel Normalized sRGB channel, ordinarily in [0, 1].
   * @returns {number} Linear-light channel intensity.
   */
  const linear = (channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) < 0.18;
}

/**
 * Selects the subtle ANSI background palette color for the detected theme:
 * bright black (`"100"`) for dark themes, bright white (`"107"`) for light
 * themes, or null when the theme is unknown. If omitted, `dark` is determined
 * by calling themeDark() with its default process.env; this reads the current
 * COLORFGBG value. Does not mutate the environment or other state.
 * @param {boolean|null} [dark=themeDark()] Detected theme classification.
 * @returns {string|null} ANSI background palette index (`"100"` or `"107"`), or null.
 */
export function subtleBg(dark = themeDark()) {
  if (dark === null || dark === undefined) return null;
  return dark ? "100" : "107";
}
