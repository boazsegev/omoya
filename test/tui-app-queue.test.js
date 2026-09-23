import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { Agent } from "../lib/agent.js";
import { createApp, msg } from "../lib/tui-app/app.js";
import { fakeIO, testEnv } from "./fakes.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("pending queue projects first two messages, count, and Alt+Up then drains", async () => {
  const env = await testEnv();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const io = fakeIO(async () => { await held; return { type: "done" }; });
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const host = GTUI.host.memory({ width: 80, height: 20 });
  const ui = new GTUI({ host });
  const running = ui.run(createApp(agent));
  try {
    ui.dispatch(msg.submit("running"));
    await turn();
    ui.dispatch(msg.submit("first queued"));
    ui.dispatch(msg.submit("second queued"));
    await turn();
    const queue = host.snapshot().lines.join("\n");
    expect(queue).toContain("Queued (2): first queued");
    expect(queue).toContain("second queued");
    expect(queue).toContain("Alt+Shift+↑");
    host.send(GTUI.event.key({ key: "alt+shift+up" }));
    await turn();
    expect(agent.pending).toEqual([]);
    const draft = host.snapshot().lines.join("\n");
    expect(draft).toContain("first queued");
    expect(draft).toContain("second queued");
  } finally {
    release();
    for (let i = 0; i < 3; i++) await turn();
    ui.stop(); await running;
  }
});

test("narrow queue is capped to three rows and retains its Alt+Up hint", async () => {
  const env = await testEnv();
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => fakeIO(async () => ({ type: "done" })) });
  agent.enqueue({ type: 2, content: [{ type: "text", text: "first pending message that is deliberately long" }] });
  agent.enqueue({ type: 2, content: [{ type: "text", text: "second pending message that is deliberately long" }] });
  const host = GTUI.host.memory({ width: 24, height: 20 });
  const ui = new GTUI({ host });
  const running = ui.run(createApp(agent));
  try {
    await turn();
    const lines = host.snapshot().lines;
    const queueLines = lines.filter((line) => line.includes("Queued") || line.includes("pending") || line.includes("Alt+Shift+↑"));
    expect(queueLines.length).toBeLessThanOrEqual(3);
    expect(lines.join("\n")).toContain("Alt+Shift+↑");
  } finally { ui.stop(); await running; }
});
