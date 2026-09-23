import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { appBindings } from "../lib/tui-app/bindings.js";

test("unchanged app binding state reuses one immutable binding list", () => {
  const model = { input: { completions: [] }, overlay: null, question: null };
  expect(appBindings(model)).toBe(appBindings(model));
});

test("key dispatch does not rebuild application bindings for every key event", async () => {
  let queries = 0;
  const memory = GTUI.host.memory();
  const ui = new GTUI({ host: memory });
  const bindings = Object.freeze(["ctrl+x"]);
  const run = ui.run({ init: () => ({ model: {} }), update: (model) => ({ model }), view: () => GTUI.view.text({}, "same"), bindings: () => { queries++; return bindings; } });
  try {
    const initial = queries;
    for (let i = 0; i < 20; i++) memory.send({ type: "key", key: "left" });
    expect(queries - initial).toBe(0);
  } finally { ui.stop(); await run; }
});
