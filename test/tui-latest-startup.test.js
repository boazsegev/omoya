import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";
import Env from "../lib/env.js";
import { runApplication } from "../lib/app/tui/cli-run.js";

// A local session archive must not block the first TUI event-loop turn.
test("latest-session startup yields while scanning local session metadata", async () => {
  const root = await mkdtemp("./ai-tmp/tui-latest-");
  const folder = join(root, "sessions");
  let env;
  try {
    await mkdir(folder);
    const cwd = resolve(root);
    const count = 2400;
    for (let i = 0; i < count; i += 200) {
      await Promise.all(Array.from({ length: Math.min(200, count - i) }, (_, j) =>
        writeFile(join(folder, `session-${i + j}.jsonl`), JSON.stringify({
          type: "session-metadata", version: 1, id: `id-${i + j}`, cwd,
          created: "2025-01-01T00:00:00.000Z",
        }) + "\n")));
    }
    env = await Env.open(root, { dir: root, settingsDir: null, sessionsDir: "sessions", toolDirs: [],
      init: { providers: false, tools: false } });
    const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
    const started = performance.now();
    let tick;
    const firstTick = new Promise((done) => setTimeout(() => { tick = performance.now() - started; done(); }, 0));
    const running = runApplication({ env, session: { kind: "resume", id: "latest" }, mode: "line",
      input: Readable.from([]), output: sink(), diagnostics: sink(), signals: false });
    const [result] = await Promise.all([running, firstTick]);
    expect(result.session.id).toStartWith("id-");
    expect(tick).toBeLessThan(100);
  } finally {
    await env?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 2000);
