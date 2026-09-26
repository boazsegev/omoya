// test/tui-escape-layers.test.js — Esc closes the innermost open layer
// before it interrupts a running turn, proven end to end through raw
// terminal bytes (createRepl + the real byte filter/decoder), in both
// engines and for both the bare and the Kitty spelling of Escape.
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import TUI from "../lib/app/tui/index.js";
import { fakeIO, testEnv } from "./fakes.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;:<=>?]*[\x20-\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
async function until(fn, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (!fn() && Date.now() < end) await wait(10);
  return fn();
}

async function harness(engine) {
  const env = await testEnv();
  let kills = 0;
  const io = fakeIO(async (io, callbacks) => {
    callbacks.onTextStart?.({ contentIndex: 0 });
    callbacks.onTextDelta?.({ contentIndex: 0, text: "partial" });
    return new Promise((resolve) => { io._onKill = () => { kills++; resolve({ type: "error", error: "cancelled", kind: "cancelled", cancelled: true }); }; });
  });
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const input = new PassThrough();
  input.isTTY = true;
  const chunks = [];
  const repl = TUI.createRepl({ agent, env, input, engine, rows: () => 40, columns: () => 100, write: (c) => chunks.push(c), log: () => {}, onExit: () => {} });
  repl.start();
  // One write + a tick per keystroke, like a real terminal; an escape
  // sequence arrives as one chunk.
  const send = async (s) => { for (const ch of s.startsWith("\x1b") ? [s] : [...s]) { input.write(Buffer.from(ch)); await wait(15); } };
  return { agent, repl, send, kills: () => kills, text: () => strip(chunks.join("")) };
}

describe("Esc layering through raw terminal bytes", () => {
  for (const engine of ["inline", "alt"]) {
    for (const [name, esc] of [["bare", "\x1b"], ["Kitty", "\x1b[27u"]]) {
      test(`${engine}, ${name} Esc: the first closes the block viewer, the second interrupts`, async () => {
        const t = await harness(engine);
        try {
          await t.send("go\r");
          expect(await until(() => t.agent.busy)).toBe(true);
          await t.send("\x0f"); // ^O
          expect(await until(() => t.text().includes("← → blocks"))).toBe(true);
          await t.send(esc);
          await wait(200);
          expect(t.kills()).toBe(0);
          expect(t.agent.busy).toBe(true);
          await t.send(esc);
          expect(await until(() => !t.agent.busy)).toBe(true);
          expect(t.kills()).toBe(1);
        } finally { t.repl.stop?.(); }
      });
    }
  }
});
