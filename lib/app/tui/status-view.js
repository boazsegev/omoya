/**
 * lib/tui-app/status-view.js — statusData() (status-data.js) into GTUI
 * view nodes: a responsive two-column cwd/identity-state line and a
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
/** Context gauge cells; the fill turns to the error color from this percent. */
const GAUGE_CELLS = 8;
const GAUGE_HIGH = 80;

/** `▰▰▱▱▱▱▱▱ ` — how full the context window is (none when its size is unknown). */
function gaugeSpans(percent) {
  if (percent === null || percent === undefined) return [];
  const filled = Math.min(GAUGE_CELLS, Math.max(percent > 0 ? 1 : 0, Math.round((percent / 100) * GAUGE_CELLS)));
  return [
    { text: "▰".repeat(filled), role: percent >= GAUGE_HIGH ? "error" : "accent" },
    { text: `${"▱".repeat(GAUGE_CELLS - filled)} `, role: "status.muted" },
  ];
}

function identityLine(data) {
  const cwd = view.text({
    margin: 0, role: "status.identity", overflow: "clip-start", maxWidth: CWD_COLUMNS, priority: 0,
  }, cwdShortText(data.identity.cwd));
  const endpoint = view.text({
    margin: 0, role: "status.identity", overflow: "clip-start", maxWidth: 24, priority: 0,
  }, data.identity.combo);
  const state = view.text({ margin: 0, priority: 20 }, [
    ...(data.backgroundIO ? [{ text: "IO ", role: "status.io" }] : []),
    { text: `● ${data.state}`, role: STATE_ROLE[data.state] ?? "status" },
  ]);
  const details = view.row({ id: "status-settings", action: "status.settings" }, [
    endpoint,
    view.text({ margin: 0, role: "status.muted", priority: 5 }, ` · ${data.safe ? "read only" : "read/write"}`),
    view.text({ margin: 0, role: "status.muted", priority: 7 }, " · Thinking "),
    view.text({ margin: 0, role: "status.muted", priority: 10 }, data.thinking),
    view.text({ margin: 0, role: "status.muted", priority: 15 }, " · "),
    state,
  ]);
  return view.row({ columns: ["fill", "auto"] }, [cwd, details]);
}

function hintsLine(data) {
  const hints = Array.isArray(data.shortcutHints) && data.shortcutHints.length > 0
    ? data.shortcutHints.flatMap((hint, index) => [
      ...(index === 0 ? [] : [{ text: " · " }]),
      { text: `${hint.key} ${hint.label}`, ...(hint.action ? { action: `shortcut.${hint.action}` } : {}) },
    ])
    : data.hints;
  return view.row({ columns: ["fill", "auto"] }, [
    view.text({ margin: 0, role: "status.hints", overflow: "clip-end" }, hints),
    // One line: context + plan clip at the edge rather than wrap; hints yield first.
    view.text({ margin: 0, overflow: "clip-end" }, [{ text: "  " }, ...gaugeSpans(data.contextPercent), { text: data.turnReadout, role: "status.muted" }]),
  ]);
}

/**
 * @param {object} data - statusData() (status-data.js) output
 * @returns {object} a GTUI column node
 */
export function statusView(data) {
  const rows = [identityLine(data), hintsLine(data)];
  if (data.mcpLine) rows.push(view.text({ margin: 0, role: "status.muted" }, data.mcpLine));
  return view.column({}, rows);
}
