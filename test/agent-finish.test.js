// test/agent-finish.test.js — proof for the reimplemented crash-safe
// onFinish/armFinishSignals pattern (no import from core/lib):
// cleanups run synchronously on exit and on trapped signals (re-raise
// preserves signal semantics), errors never propagate, real-process
// flush survives process.exit and SIGTERM.
import { describe, expect, test, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { onFinish, runFinish, armFinishSignals, _resetFinish } from "../lib/agent.js";

afterEach(() => _resetFinish());

function fakeProc() {
  const listeners = new Map();
  return {
    pid: 9999,
    killed: [],
    once: (ev, fn) => listeners.set(`once:${ev}`, fn),
    on: (ev, fn) => listeners.set(`on:${ev}`, fn),
    off: (ev) => listeners.delete(`on:${ev}`),
    kill(pid, sig) { this.killed.push([pid, sig]); },
    fire(ev) { listeners.get(`on:${ev}`)?.() ?? listeners.get(`once:${ev}`)?.(); },
    has: (ev) => listeners.has(`on:${ev}`) || listeners.has(`once:${ev}`),
  };
}

describe("onFinish", () => {
  test("registers a synchronous cleanup that runs at finish; unregister works", () => {
    const proc = fakeProc();
    const ran = [];
    const off1 = onFinish(() => ran.push(1), { process: proc });
    onFinish(() => ran.push(2), { process: proc });
    expect(proc.has("exit")).toBe(true); // exit hook armed
    off1();
    runFinish();
    expect(ran).toEqual([2]);
  });

  test("cleanup errors never propagate", () => {
    onFinish(() => { throw new Error("boom"); }, { process: fakeProc() });
    onFinish(() => { /* fine */ }, { process: fakeProc() });
    expect(() => runFinish()).not.toThrow();
  });

  test("rejects non-functions", () => {
    expect(() => onFinish("nope")).toThrow(TypeError);
  });
});

describe("armFinishSignals", () => {
  test("runs cleanups then re-raises the signal (dies BY the signal)", () => {
    const proc = fakeProc();
    const ran = [];
    onFinish(() => ran.push("flush"), { process: proc });
    armFinishSignals({ process: proc });
    proc.fire("SIGTERM");
    expect(ran).toEqual(["flush"]);
    expect(proc.killed).toEqual([[9999, "SIGTERM"]]); // re-raised
    expect(proc.has("SIGTERM")).toBe(false); // handlers removed first
  });

  test("is idempotent; disarm removes handlers", () => {
    const proc = fakeProc();
    const d1 = armFinishSignals({ process: proc });
    const d2 = armFinishSignals({ process: proc });
    expect(d2).toBe(d1);
    expect(proc.has("SIGINT")).toBe(true);
    d1();
    expect(proc.has("SIGINT")).toBe(false);
  });
});

describe("crash safety in a real process", () => {
  const ROOT = `./ai-tmp/finish-${process.pid}`;
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  async function spawnChild(script) {
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exit };
  }

  test("onFinish flushes on process.exit", async () => {
    mkdirSync(ROOT, { recursive: true });
    const file = `${ROOT}/exit.marker`;
    const { exit, stderr } = await spawnChild(`
      import { onFinish } from "./lib/agent.js";
      import { writeFileSync } from "node:fs";
      onFinish(() => writeFileSync(${JSON.stringify(file)}, "flushed"));
      process.exit(0);
    `);
    expect(exit).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("flushed");
  });

  test("armFinishSignals flushes on SIGTERM and dies by the signal", async () => {
    mkdirSync(ROOT, { recursive: true });
    const file = `${ROOT}/sigterm.marker`;
    const proc = Bun.spawn(["bun", "-e", `
      import { onFinish, armFinishSignals } from "./lib/agent.js";
      import { writeFileSync } from "node:fs";
      onFinish(() => writeFileSync(${JSON.stringify(file)}, "flushed"));
      armFinishSignals();
      setInterval(() => {}, 1000); // stay alive for the signal
    `], { stdout: "pipe", stderr: "pipe" });
    await new Promise((r) => setTimeout(r, 400)); // let it arm
    proc.kill("SIGTERM");
    const exit = await proc.exited;
    expect(exit).not.toBe(0); // terminated by signal, not a clean exit
    expect(existsSync(file)).toBe(true);
  }, 15000);

  test("zero core/lib dependency: the module is self-contained", async () => {
    const src = await Bun.file("./lib/agent/finish.js").text();
    expect([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual([]);
  });
});
