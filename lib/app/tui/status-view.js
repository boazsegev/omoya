/**
 * lib/app/tui/status-view.js — statusData() (status-data.js) into GTUI
 * view nodes: a responsive cwd / setting-chip toolbar / state line and a
 * hints/turn-readout line (GTUI's row "fill"/"auto" tracks and generic
 * maxWidth clipping own the geometry), plus the mcp/plan lines
 * when present (no line, no noise — parity with legacy). The busy
 * indicator carries a `status.busy` role; the terminal host resolves
 * its wave animation on the host clock. The app declares activity,
 * while GTUI owns timing, palette frames, and repaint scheduling.
 */

import { view } from "../gtui/gtui.js";
import { CWD_COLUMNS, cwdShortText } from "./status-data.js";

const STATE_ROLE = { idle: "status.idle", working: "status.busy", disconnected: "status.error" };
/** The status toolbar's GTUI id — app.js reads toolbar.change/action.select for it. */
export const STATUS_TOOLBAR_ID = "status-tools";
/** What activating each setting chip asks app.js to do. The model chip IS ^M, the endpoint chip ^P. */
const CHIP_ACTIONS = Object.freeze({ model: "shortcut.ctrl+m", endpoint: "shortcut.ctrl+p", thinking: "status.thinking", safe: "status.safe", logging: "status.logging" });
/** Narrow terminals drop chips lowest first: the safety-relevant ones stay. */
const CHIP_PRIORITY = Object.freeze({ safe: 40, logging: 30, model: 20, endpoint: 15, thinking: 10 });
/** Context gauge cells; the fill turns to the error color from this percent. */
const GAUGE_CELLS = 8;
const GAUGE_HIGH = 80;

/** `▰▰▱▱▱▱▱▱` — how full the context window is (none when its size is unknown; the caller pads it). */
function gaugeSpans(percent) {
  if (percent === null || percent === undefined) return [];
  const filled = Math.min(GAUGE_CELLS, Math.max(percent > 0 ? 1 : 0, Math.round((percent / 100) * GAUGE_CELLS)));
  return [
    { text: "▰".repeat(filled), role: percent >= GAUGE_HIGH ? "error" : "accent" },
    { text: "▱".repeat(GAUGE_CELLS - filled), role: "status.muted" },
  ];
}

function identityLine(data, toolbar) {
  const cwd = view.text({
    margin: 0, role: "status.identity", overflow: "clip-start", maxWidth: CWD_COLUMNS, priority: 0,
  }, cwdShortText(data.identity.cwd));
  const chips = view.toolbar({ id: STATUS_TOOLBAR_ID, focus: toolbar.focus === true, align: "end", priority: 10 }, data.chips.map((chip) => view.button({
    id: chip.key, action: CHIP_ACTIONS[chip.key], icon: chip.icon, pressed: chip.active,
    ...(chip.warn ? { tone: "warn" } : {}), priority: CHIP_PRIORITY[chip.key] ?? 0,
  }, chip.label)));
  const state = view.text({ margin: 0, priority: 20 }, [
    { text: " " },
    ...(data.backgroundIO ? [{ text: "IO ", role: "status.io" }] : []),
    { text: `● ${data.state}`, role: STATE_ROLE[data.state] ?? "status" },
  ]);
  return view.row({ columns: ["fill", "auto", "auto"] }, [cwd, chips, state]);
}

/** While the toolbar has focus the hints describe the focused chip and the
 *  keys that work there, in place of the global shortcuts. */
function toolbarHints(data, toolbar) {
  const chip = data.chips.find((item) => item.key === toolbar.key) ?? data.chips[0];
  return [
    { text: chip.title },
    { text: ` · ⏎ ${chip.action} · ←/→ move · ↑ back` },
  ];
}

function hintsLine(data, toolbar) {
  const hints = toolbar.focus === true ? toolbarHints(data, toolbar)
    : Array.isArray(data.shortcutHints) && data.shortcutHints.length > 0
    ? data.shortcutHints.flatMap((hint, index) => [
      ...(index === 0 ? [] : [{ text: " · " }]),
      { text: `${hint.key} ${hint.label}`, ...(hint.action ? { action: `shortcut.${hint.action}` } : {}) },
    ])
    : data.hints;
  const gauge = gaugeSpans(data.contextPercent);
  return view.row({ columns: ["fill", "auto"] }, [
    view.text({ margin: 0, role: "status.hints", overflow: "clip-end" }, hints),
    // One line: `<used>/<total> ▰▰▱▱▱▱▱▱ <pct>% · plan …` — counters before
    // the gauge, percent and plan after; context + plan clip at the edge
    // rather than wrap; hints yield first.
    view.text({ margin: 0, overflow: "clip-end" }, [
      { text: "  " },
      { text: data.turnReadout.before, role: "status.muted" },
      ...(gauge.length > 0 ? [{ text: " " }, ...gauge, { text: " " }] : []),
      { text: data.turnReadout.after, role: "status.muted" },
    ]),
  ]);
}

/**
 * @param {object} data - statusData() (status-data.js) output
 * @param {{focus?: boolean, key?: string}} [toolbar] - whether the setting
 *   toolbar has keyboard focus, and which chip (from toolbar.change)
 * @returns {object} a GTUI column node
 */
export function statusView(data, toolbar = {}) {
  const rows = [identityLine(data, toolbar), hintsLine(data, toolbar)];
  if (data.throttledUntil > Date.now()) rows.push(view.text({ margin: 0, role: "status.muted" },
    `Rate limited · continuing in ${Math.ceil((data.throttledUntil - Date.now()) / 1000)}s`));
  if (data.mcpLine) rows.push(view.text({ margin: 0, role: "status.muted" }, data.mcpLine));
  return view.column({}, rows);
}
