import { expect, test } from "bun:test";
import { createRepl } from "../lib/tui.js";
import { Agent } from "../lib/agent.js";
import { testEnv, scriptedIO } from "./fakes.js";
import { TerminalInput } from "./terminal-screen.js";

for (const engine of ["inline", "alt"]) {
  test(`${engine} bin-style write callback preserves actual stdout resize subscription`, async () => {
    const env = await testEnv();
    const input = new TerminalInput();
    const bytes = [];
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const before = process.stdout.listenerCount("resize");
    const repl = createRepl({ agent, env, engine, input, write: (chunk) => bytes.push(chunk) });
    const run = repl.start();
    try {
      expect(process.stdout.listenerCount("resize")).toBe(before + 1);
      const writes = bytes.length;
      process.stdout.emit("resize");
      expect(bytes.length).toBeGreaterThan(writes);
      if (engine === "inline") expect(bytes.at(-1)).toContain("\x1b[2J");
    } finally { repl.close(); await run; }
    expect(process.stdout.listenerCount("resize")).toBe(before);
  });
}
