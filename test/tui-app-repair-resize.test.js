import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createInteractiveRepl } from "../lib/tui-app/run.js";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv } from "./fakes.js";
import { TerminalInput, TerminalScreen } from "./terminal-screen.js";

test("production interactive wrapper forwards resize and removes its handler on stop", async () => {
  const env = await testEnv();
  const input = new TerminalInput();
  const output = new TerminalScreen(30, 8);
  const resizeEmitter = new EventEmitter();
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
  const repl = createInteractiveRepl({ agent, input, output, resizeEmitter, mode: "alt", cwd: "project", env });

  const running = repl.start();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const before = output.chunks.length;
    output.columns = 12;
    resizeEmitter.emit("resize");
    expect(output.chunks.length).toBeGreaterThan(before);
    expect(resizeEmitter.listenerCount("resize")).toBe(1);
  } finally {
    repl.close();
    await running;
  }
  expect(resizeEmitter.listenerCount("resize")).toBe(0);
});
