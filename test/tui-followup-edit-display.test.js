import { expect, test } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import "../lib/env.js";
import { edit } from "../tools/edit.js";
import Agent from "../lib/agent.js";
import { GTUI } from "../lib/gtui/gtui.js";
import { createApp, msg } from "../lib/tui-app/app.js";
import { testEnv, fakeIO, emitScript, TOOLCALL } from "./fakes.js";
import { TerminalInput, TerminalScreen } from "./terminal-screen.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));
for (const mode of ["inline", "alt"]) {
  test(`${mode}: actual edit tool display reaches colored diff rows before next response`, async () => {
    const env = await testEnv();
    const root = env.cwd;
    const path = "sample.txt";
    await writeFile(`${root}/${path}`, "OLD CONTENT\n");
    env.registerTool("edit", edit, { description: "edit fixture", interactive: true, inputSchema: { type: "object" } });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let nextStarted;
    const started = new Promise((resolve) => { nextStarted = resolve; });
    let request = 0;
    const io = fakeIO(async (_, callbacks) => {
      if (request++ === 0) return emitScript([{ type: "start" }, ...TOOLCALL(0, "edit-call", "edit", { path, edits: [{ oldText: "OLD CONTENT", newText: "NEW CONTENT" }] }), { type: "done" }], callbacks);
      nextStarted(); await held;
      return emitScript([{ type: "start" }, { type: "done" }], callbacks);
    });
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io, toolCall: { fork: false } });
    const output = new TerminalScreen(90, 32);
    const app = createApp(agent, { env, sources: {} });
    const ui = new GTUI({ host: GTUI.host.terminal({ input: new TerminalInput(), output, mode }), theme: app.theme });
    const running = ui.run(app);
    try {
      ui.dispatch(msg.submit("edit")); await started; await turn();
      expect(await readFile(`${root}/${path}`, "utf8")).toBe("NEW CONTENT\n");
      expect(output.text()).toContain("-OLD CONTENT");
      expect(output.text()).toContain("+NEW CONTENT");
      expect(output.bytes()).toMatch(/\x1b\[[0-9;]*38;5;1m/);
      expect(output.bytes()).toMatch(/\x1b\[[0-9;]*38;5;2m/);
    } finally { release(); await turn(); ui.stop(); await running; await rm(root, { recursive: true, force: true }); }
  });
}
