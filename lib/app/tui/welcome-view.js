import { view } from "../gtui/gtui.js";

// Each character cell is roughly twice as tall as it is wide. The O is
// sampled in physical-cell proportions; MOYA is a separate, smaller bitmap
// whose baseline meets the bottom of the O.
const LETTERS = {
  M: ["█   █", "██ ██", "█████", "█ █ █", "█   █", "█   █", "█   █"],
  O: [" ███ ", "█   █", "█   █", "█   █", "█   █", "█   █", " ███ "],
  Y: ["█   █", "█   █", " █ █ ", "  █  ", "  █  ", "  █  ", "  █  "],
  A: [" ███ ", "█   █", "█   █", "█████", "█   █", "█   █", "█   █"],
};
const PROMPT = ["██      ", "  ██    ", "    ██  ", "  ██    ", "██   ████"];
const RING_WIDTH = 27;
const RING_HEIGHT = 13;
const LARGE_WIDTH = 86;
const NARROW_WIDTH = 56;
const PROMPT_LIMIT = 6;
const RING_INNER_RADIUS = 3.7;
const RING_OUTER_RADIUS = 6.45;

function markRow(y, width) {
  const centerX = (width - 1) / 2;
  const centerY = (RING_HEIGHT - 1) / 2;
  return Array.from({ length: width }, (_, x) => {
    const radius = Math.hypot((x - centerX) / 2, y - centerY);
    if (radius >= RING_INNER_RADIUS && radius <= RING_OUTER_RADIUS) return { text: "█", role: "accent" };
    const glyph = PROMPT[y - 4]?.[x - centerX + 3];
    return glyph === "█" ? { text: "█", role: "welcome.foreground" } : { text: " " };
  });
}

function wordmarkRows(wide) {
  const scale = wide ? 2 : 1;
  const ringWidth = RING_WIDTH;
  return Array.from({ length: RING_HEIGHT }, (_, y) => {
    const cells = markRow(y, ringWidth);
    if (y < RING_HEIGHT - 7) return cells;
    const line = "MOYA".split("").map((letter) => [...LETTERS[letter][y - (RING_HEIGHT - 7)]]
      .map((pixel) => pixel === "█" ? "█".repeat(scale) : " ".repeat(scale)).join("")).join("  ");
    return [...cells, ...Array.from({ length: 3 }, () => ({ text: " " })), { text: line, role: "welcome.foreground" }];
  });
}

function centered(content, width, role = "welcome.foreground", blockWidth) {
  const length = typeof content === "string" ? content.length : content.reduce((sum, span) => sum + span.text.length, 0);
  const inset = Math.max(0, Math.floor((width - 1 - (blockWidth ?? length)) / 2));
  const spans = typeof content === "string" ? [{ text: content }] : content;
  return view.text({ role, margin: 0, overflow: "clip-end" }, [{ text: " ".repeat(inset) }, ...spans]);
}

/** A terminal-cell rendition of the SVG's O-with-prompt wordmark. */
export function welcomeArt(wide = true, width = LARGE_WIDTH) {
  const rows = wordmarkRows(wide);
  const blockWidth = Math.max(...rows.map((row) => row.reduce((sum, span) => sum + span.text.length, 0)));
  return rows.map((row) => centered(row, width, "notice", blockWidth));
}

/** Build the opening hero; catalog names are read from the existing completion cache. */
export function welcomeView({ model, prompts = [], width = LARGE_WIDTH, compact = false, topSpace = 0 } = {}) {
  const names = prompts.slice(0, PROMPT_LIMIT).map((name) => `/${name}`);
  const blank = () => centered("", width);
  const rows = Array.from({ length: topSpace }, blank);
  rows.push(...(width < NARROW_WIDTH ? [centered("Omoya", width, "accent md.strong")] : welcomeArt(width >= LARGE_WIDTH, width)));
  if (!compact) rows.push(blank());
  rows.push(centered(`Talking to ${model ?? "(none)"}`, width));
  if (names.length) {
    if (!compact) rows.push(blank());
    rows.push(centered("Your prompts", width, "welcome.foreground md.strong"));
    rows.push(centered(names.join("   "), width));
  }
  if (!compact) rows.push(blank());
  rows.push(centered("/ commands and prompts · ^X menu · ^O block viewer", width));
  return view.column({ priority: 0 }, rows);
}
