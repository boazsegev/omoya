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

/**
 * Build the filled and empty GTUI text spans for the context-window gauge.
 * @param {number|null|undefined} percent - Context usage percentage; nullish
 *   values indicate that the window size is unknown.
 * @returns {Array<{text: string, role: string}>} Gauge spans, or an empty
 *   array when `percent` is nullish.
 */
function gaugeSpans(percent) {
  if (percent === null || percent === undefined) return [];
  const filled = Math.min(GAUGE_CELLS, Math.max(percent > 0 ? 1 : 0, Math.round((percent / 100) * GAUGE_CELLS)));
  return [
    { text: "▰".repeat(filled), role: percent >= GAUGE_HIGH ? "error" : "accent" },
    { text: "▱".repeat(GAUGE_CELLS - filled), role: "status.muted" },
  ];
}

/**
 * Build the status row containing the working directory, setting chips, and
 * current activity state.
 * @param {object} data - Status data, including `identity.cwd`, `chips`,
 *   `backgroundIO`, and `state`.
 * @param {{focus?: boolean}} toolbar - Toolbar interaction state; `focus`
 *   controls whether the setting-chip toolbar is focused.
 * @returns {object} A GTUI row node.
 */
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

/**
 * Describe the currently focused setting chip and its available keys.
 * @param {object} data - Status data containing `chips` with a title and
 *   action for each setting.
 * @param {{key?: string}} toolbar - Toolbar interaction state; `key` selects
 *   the focused chip, falling back to the first chip when it is not found.
 * @returns {Array<{text: string}>} Text spans for the focused-chip hints.
 * @throws {TypeError} If the supplied status data has no usable `chips` array.
 */
function toolbarHints(data, toolbar) {
  const chip = data.chips.find((item) => item.key === toolbar.key) ?? data.chips[0];
  return [
    { text: chip.title },
    { text: ` · ⏎ ${chip.action} · ←/→ move · ↑ back` },
  ];
}

/**
 * Build the hints and turn-readout row, including the context gauge when known.
 * @param {object} data - Status data containing shortcut hints or fallback
 *   hints, context percentage, and before/after turn-readout text.
 * @param {{focus?: boolean, key?: string}} toolbar - Toolbar state used to
 *   choose focused-chip hints or the global hints.
 * @returns {object} A GTUI row node.
 */
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
 * Build the complete status view, with optional rate-limit and MCP rows.
 * @param {object} data - `statusData()` output, including identity, chips,
 *   activity, hints, turn-readout, and optional throttle/MCP status.
 * @param {{focus?: boolean, key?: string}} [toolbar={}] - Optional toolbar
 *   interaction state: whether it has focus and the selected chip key.
 * @returns {object} A GTUI column node containing the status rows.
 * @throws {TypeError} If required status data is missing or malformed and
 *   cannot be read while constructing the view.
 * @effects Reads the current time to determine whether a rate-limit row is
 *   needed and its remaining seconds; does not mutate the inputs.
 */
export function statusView(data, toolbar = {}) {
  const rows = [identityLine(data, toolbar), hintsLine(data, toolbar)];
  if (data.throttledUntil > Date.now()) rows.push(view.text({ margin: 0, role: "status.muted" },
    `Rate limited · continuing in ${Math.ceil((data.throttledUntil - Date.now()) / 1000)}s`));
  if (data.mcpLine) rows.push(view.text({ margin: 0, role: "status.muted" }, data.mcpLine));
  return view.column({}, rows);
}
