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
 * @param {object} [env] - environment map (default process.env)
 * @returns {boolean|null} true = dark theme, false = light, null = unknown
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
 * The subtle background palette number for the detected theme:
 * "100" (bright black) on dark, "107" (bright white) on light,
 * null when the theme is unknown (use no background). The ANSI
 * palette has no "dimmed background" of its own: the 8 background
 * slots are theme-defined and a bright-black block reads as a loud
 * gray slab on dark themes, so a background is only ever chosen
 * after detecting the theme.
 * @param {boolean|null} dark - from themeDark() (re-detected when omitted)
 * @returns {string|null}
 */
/** Parse an OSC 11 RGB reply and classify its background brightness. */
export function backgroundDark(value) {
  const match = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(value);
  if (!match) return null;
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / (16 ** part.length - 1));
  const linear = (channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) < 0.18;
}

export function subtleBg(dark = themeDark()) {
  if (dark === null || dark === undefined) return null;
  return dark ? "100" : "107";
}
