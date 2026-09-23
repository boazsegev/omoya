import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("microtask token streams do not render once per token ahead of input I/O", async () => {
  let views = 0;
  let completed;
  const complete = new Promise((resolve) => { completed = resolve; });
  const ui = new GTUI({ host: GTUI.host.memory() });
  const run = ui.run({
    init: () => ({ model: { text: "" }, effects: [GTUI.effect.task("tokens", async ({ send }) => {
      for (let i = 0; i < 50; i++) { await Promise.resolve(); send({ type: "token", text: "x" }); }
      completed();
    })] }),
    update: (model, message) => ({ model: message.type === "token" ? { text: model.text + message.text } : model, effects: [] }),
    view: (model) => { views++; return GTUI.view.text({}, model.text); },
  });
  try {
    await complete;
    await turn();
    expect(views).toBeLessThanOrEqual(3);
  } finally { ui.stop(); await run; }
});

test("stop and restart cancel stale background frames", async () => {
  const memory = GTUI.host.memory();
  const ui = new GTUI({ host: memory });
  let firstViews = 0;
  const first = ui.run({
    init: () => ({ model: 0, effects: [] }),
    update: (model, message) => ({ model: message.type === "background" ? model + 1 : model, effects: [] }),
    view: (model) => { firstViews++; return GTUI.view.text({}, `first:${model}`); },
  });
  ui.dispatch({ type: "background" });
  ui.stop();
  await first;
  await turn();
  expect(firstViews).toBe(1);

  let secondViews = 0;
  const second = ui.run({
    init: () => ({ model: 0, effects: [] }),
    update: (model) => ({ model, effects: [] }),
    view: () => { secondViews++; return GTUI.view.text({}, "second"); },
  });
  await turn();
  expect(secondViews).toBe(1);
  expect(memory.snapshot().lines.join("\n")).toContain("second");
  ui.stop();
  await second;
});
