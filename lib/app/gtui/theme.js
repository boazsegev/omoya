import { BOLD, DIM, ITALIC, REVERSE, STRIKE, UNDERLINE } from "./cell.js";
import { graphemeWidth, graphemes } from "./width.js";
import { themeDark } from "./theme-detect.js";

const ATTRIBUTES = Object.freeze({ bold: BOLD, dim: DIM, italic: ITALIC, underline: UNDERLINE, reverse: REVERSE, strike: STRIKE });
const GENERIC_ROLES = Object.freeze([
  "text", "muted", "accent", "error", "border", "border.active", "selection",
  "input.text", "input.border", "input.border.active", "input.selection",
  "completion.text", "completion.selected", "menu.title", "menu.header", "menu.text", "menu.selected", "menu.footer",
  "scroll.track", "scroll.thumb", "overlay.border", "overlay.title", "cursor",
]);
const PHI = (1 + Math.sqrt(5)) / 2;

function variant(value, dark) {
  if (!value || Array.isArray(value) || typeof value !== "object") return value;
  if (!("dark" in value) && !("light" in value) && !("default" in value)) return value;
  if (dark === true) return value.dark ?? value.default ?? value.light;
  if (dark === false) return value.light ?? value.default ?? value.dark;
  return value.default ?? null;
}

function color(value) {
  if (value === undefined || value === null || value === "default") return null;
  if (Number.isInteger(value) && value >= 0 && value <= 255) return value;
  const ansi = /^ansi:(\d{1,3})$/.exec(String(value));
  if (ansi) return Math.min(255, Number(ansi[1]));
  const rgb = /^#([0-9a-f]{6})$/i.exec(String(value));
  if (rgb) return `#${rgb[1].toLowerCase()}`;
  throw new TypeError(`invalid GTUI color: ${value}`);
}

function normalizeStyle(value, dark) {
  const resolved = variant(value, dark) ?? {};
  let attrs = 0;
  for (const [name, flag] of Object.entries(ATTRIBUTES)) if (resolved[name] === true) attrs |= flag;
  return Object.freeze({ fg: color(variant(resolved.fg, dark)), bg: color(variant(resolved.bg, dark)), attrs });
}

function normalizeAnimation(value) {
  if (!value) return null;
  if (typeof value === "string") return Object.freeze({ type: value });
  return Object.freeze({ ...value, type: value.type ?? value.name });
}

function mergeStyles(base, next) {
  return {
    fg: next.fg ?? base.fg,
    bg: next.bg ?? base.bg,
    attrs: base.attrs | next.attrs,
  };
}

function normalizeDecoration(value) {
  if (value === undefined || value === null || value === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid GTUI decoration");
  const { left } = value;
  if (left === undefined || left === null) return null;
  if (!left || typeof left !== "object" || Array.isArray(left)) throw new TypeError("invalid GTUI decoration.left");
  const glyph = left.glyph;
  if (typeof glyph !== "string" || graphemes(glyph).length !== 1 || graphemeWidth(glyph) !== 1) {
    throw new TypeError("GTUI decoration glyph must be exactly one width-1 grapheme");
  }
  if (typeof left.role !== "string" || !left.role.trim()) throw new TypeError("GTUI decoration role must be a non-empty string");
  const gap = left.gap ?? 0;
  if (!Number.isInteger(gap) || gap < 0 || gap > 1024) throw new TypeError("GTUI decoration gap must be an integer from 0 to 1024");
  return Object.freeze({ left: Object.freeze({ glyph, role: left.role, gap }) });
}

/** Resolve token fallback and host light/dark capability once at the boundary. */
export function createTheme(tokens = {}, capability = {}) {
  const detected = themeDark({ COLORFGBG: capability.colorfgbg ?? process.env.COLORFGBG });
  const dark = capability.dark === true || capability.dark === false ? capability.dark : detected;
  const styles = new Map();
  const animations = new Map();
  const decorations = new Map();
  const source = { text: {}, selection: { reverse: true }, ...tokens };
  // Validate every declared decoration now, rather than deferring malformed
  // inactive roles until a particular view happens to use one.
  for (const value of Object.values(source)) if (value && typeof value === "object" && "decoration" in value) normalizeDecoration(value.decoration);
  function tokenFor(role) {
    const parts = String(role).split(".");
    while (parts.length > 0) {
      const token = source[parts.join(".")];
      if (token !== undefined) return token;
      parts.pop();
    }
    return source.text;
  }
  function decorationFor(role) {
    const parts = String(role).split(".");
    while (parts.length > 0) {
      const token = source[parts.join(".")];
      if (token && typeof token === "object" && Object.hasOwn(token, "decoration")) return { declared: true, value: token.decoration };
      parts.pop();
    }
    return { declared: false, value: null };
  }
  function single(role) {
    if (styles.has(role)) return styles.get(role);
    const value = tokenFor(role);
    const style = normalizeStyle(value?.style ?? value, dark);
    styles.set(role, style);
    animations.set(role, normalizeAnimation(value?.animation));
    const decoration = decorationFor(role);
    decorations.set(role, Object.freeze({ declared: decoration.declared, value: normalizeDecoration(decoration.value) }));
    return style;
  }
  function roleList(role) {
    return Array.isArray(role) ? role : String(role ?? "text").trim().split(/\s+/).filter(Boolean);
  }
  function resolve(role = "text") {
    const roles = roleList(role);
    if (roles.length <= 1) return single(roles[0] ?? "text");
    const combined = roles.map(single).reduce(mergeStyles, { fg: null, bg: null, attrs: 0 });
    return Object.freeze(combined);
  }
  function decoration(role = "text") {
    const roles = roleList(role);
    // Roles compose left-to-right for style. Decoration is singular geometry:
    // scan from the final explicit role so the last declared decoration wins.
    for (let index = roles.length - 1; index >= 0; index--) {
      single(roles[index]);
      const entry = decorations.get(roles[index]);
      // `null` is an explicit geometry override, distinct from no token.
      if (entry.declared) return entry.value;
    }
    return null;
  }
  function animation(role = "text") {
    const roles = roleList(role);
    for (let index = roles.length - 1; index >= 0; index--) {
      single(roles[index]);
      const value = animations.get(roles[index]);
      if (value) return value;
    }
    return null;
  }
  function animated(role, { time = Date.now(), index = 0, count = 1 } = {}) {
    const base = resolve(role);
    const value = animation(role);
    if (!value) return base;
    if (value.type === "comet") {
      const foreground = cometFrame(count, time, value)[index];
      return foreground === null || foreground === undefined ? base : Object.freeze({ ...base, fg: foreground });
    }
    if (value.type === "wave") {
      if (Array.isArray(value.colors) && value.colors.length > 0) {
        const length = Math.max(1, count);
        const crest = waveCrest(length, time, value, value.colors.length);
        const slot = index - crest + Math.floor(value.colors.length / 2);
        return slot >= 0 && slot < value.colors.length
          ? Object.freeze({ ...base, fg: color(value.colors[slot]) }) : base;
      }
      const frame = waveFrame(" ".repeat(Math.max(1, count)), time, value)[index];
      return frame?.role && frame.role !== "text" ? Object.freeze(mergeStyles(base, resolve(frame.role))) : base;
    }
    if (value.type === "flash" && flashFrame(time, value)) {
      return Object.freeze(mergeStyles(base, resolve(value.role ?? "accent")));
    }
    return base;
  }
  GENERIC_ROLES.forEach(single);
  const cursorToken = source.cursor && typeof source.cursor === "object" ? variant(source.cursor, dark) : {};
  const cursor = Object.freeze({
    color: color(variant(cursorToken?.fg, dark)),
    shape: cursorToken?.shape,
    blinkMs: cursorToken?.blinkMs,
  });
  return Object.freeze({ dark, cursor, resolve, decoration, animation, animated });
}

function resample(stops, count) {
  return Array.from({ length: count }, (_, index) => stops[Math.min(stops.length - 1, Math.floor((index * stops.length) / count))]);
}

/** Generic ping-pong comet colors for a one-cell rule at host time. */
export function cometFrame(width, time, options = {}) {
  const headStops = options.head ?? [223, 215, 208, 208];
  const tailStops = options.tail ?? [172, 172, 130, 130, 94, 94, 88, 52];
  const noseStops = options.nose ?? [172, 130];
  const tick = options.tick ?? 50;
  const crossing = options.crossing ?? 1400;
  const ratio = options.ratio ?? PHI;
  const phase = Math.floor(time / tick);
  const span = Math.max(headStops.length + tailStops.length + noseStops.length, Math.round(width / ratio));
  const headCount = Math.max(2, Math.round((span * headStops.length) / 14));
  const noseCount = Math.max(1, Math.round((span * noseStops.length) / 14));
  const tailCount = Math.max(2, span - headCount - noseCount);
  const head = resample(headStops, headCount);
  const tail = resample(tailStops, tailCount);
  const nose = resample(noseStops, noseCount);
  const travel = width + span;
  const speed = Math.max(2, Math.round(travel / (crossing / tick)));
  const t = ((phase * speed) % (2 * travel) + 2 * travel) % (2 * travel);
  const progress = t <= travel ? t : 2 * travel - t;
  let headPosition = width + nose.length - progress;
  if (options.mirror) headPosition = width - 1 - headPosition;
  return Array.from({ length: width }, (_, index) => {
    const distance = options.mirror ? headPosition - index : index - headPosition;
    if (distance >= 0 && distance < head.length) return head[distance];
    const tailDistance = distance - head.length;
    if (tailDistance >= 0 && tailDistance < tail.length) return tail[tailDistance];
    const noseDistance = -distance - 1;
    if (noseDistance >= 0 && noseDistance < nose.length) return nose[noseDistance];
    return null;
  });
}

function waveCrest(length, time, { period = 1400, mirror = false } = {}, width = 1) {
  const crossing = Math.max(1, Number(period) || 1400);
  const cycle = crossing * 2;
  const elapsed = ((time % cycle) + cycle) % cycle;
  const progress = elapsed <= crossing ? elapsed / crossing : (cycle - elapsed) / crossing;
  const left = Math.floor(width / 2);
  const start = -(width - left);
  const end = length + left;
  const crest = Math.min(end, start + Math.floor(progress * (end - start + 1)));
  return mirror ? start + end - crest : crest;
}

export function waveFrame(text, time, { period = 1400, role = "accent", mirror = false } = {}) {
  const length = Math.max(1, [...text].length);
  const crest = waveCrest(length, time, { period, mirror });
  return [...text].map((character, index) => ({ character, role: index === crest ? role : "text" }));
}

export function flashFrame(time, { period = 600 } = {}) {
  return Math.floor(time / Math.max(1, period)) % 2 === 0;
}

export const themeRoles = GENERIC_ROLES;
