import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { TerminalInput, TerminalScreen } from "./terminal-screen.js";

const selectable = () => GTUI.view.text({ selectionKey: "s", sourceText: "text" }, [{ text: "text", source: { start: 0, end: 4 } }]);

async function start(mouse, view = selectable) {
  const output = new TerminalScreen();
  const ui = new GTUI({ host: GTUI.host.terminal({ input: new TerminalInput(), output, mode: "inline", ...(mouse === undefined ? {} : { mouse }) }) });
  const run = ui.run({ init: () => ({ model: false }), update: (_, message) => ({ model: message.type === "show" }), view: (show) => view(show) });
  return { output, ui, run };
}

async function stop({ ui, run }) { ui.stop(); await run; }

test("inline overlays default leaves selectable transcript mouse-native", async () => {
  const session = await start();
  try { expect(session.output.bytes()).not.toContain("\x1b[?1006h"); }
  finally { await stop(session); }
});

test("inline overlays enables for a menu overlay then disables when it closes", async () => {
  const session = await start("overlays", (show) => show
    ? GTUI.view.overlay({}, [GTUI.view.menu({ id: "menu", items: [] })])
    : selectable());
  try {
    session.ui.dispatch({ type: "show" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.output.bytes()).toContain("\x1b[?1006h");
    session.ui.dispatch({ type: "hide" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.output.bytes()).toContain("\x1b[?1006l");
  } finally { await stop(session); }
});

test("inline off never captures an overlay", async () => {
  const session = await start("off", () => GTUI.view.overlay({}, [GTUI.view.menu({ id: "menu", items: [] })]));
  try { expect(session.output.bytes()).not.toContain("\x1b[?1006h"); }
  finally { await stop(session); }
});

test("terminal host rejects an unknown mouse policy", () => {
  expect(() => GTUI.host.terminal({ input: new TerminalInput(), output: new TerminalScreen(), mouse: "invalid" })).toThrow("unsupported mouse policy");
});
