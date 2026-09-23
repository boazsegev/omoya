import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { initializeJobs, disableJobs } from "../lib/jobs.js";
import { daemonLoop, daemonDelay, JOBS_DAEMON_DELAY } from "../lib/jobs/daemon-loop.js";
import { foregroundJobsDaemon } from "../lib/jobs/daemon.js";
const roots = [];
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture() { const root = await fs.realpath(await fs.mkdtemp("./ai-tmp/jobs-daemon-")); roots.push(root); await initializeJobs(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
describe("best-effort foreground daemon", () => {
  test("launches immediately then waits five minutes after completion", async () => { const stop = new AbortController(), child = deferred(), waiting = deferred(); let launches = 0; const running = daemonLoop({ signal: stop.signal, childSignal: stop.signal, admit: async () => true, launch: async () => { launches++; await child.promise; }, state() {}, delay: async (ms) => { expect(ms).toBe(JOBS_DAEMON_DELAY); waiting.resolve(); stop.abort(); } }); await Promise.resolve(); expect(launches).toBe(1); child.resolve(); await waiting.promise; await running; await daemonDelay(1, new AbortController().signal); });
  test("folder disappearance exits foreground daemon without durable control state", async () => { const root = await fixture(), active = deferred(), drain = deferred(); const running = foregroundJobsDaemon(root, { launch: async () => { active.resolve(); await drain.promise; }, delay: async () => {} }); await active.promise; await disableJobs(root); drain.resolve(); await running; });
  test("multiple foreground daemons are allowed", async () => { const root = await fixture(), stop = new AbortController(); const one = foregroundJobsDaemon(root, { signal: stop.signal, launch: async () => {}, delay: async () => stop.abort() }); const two = foregroundJobsDaemon(root, { signal: stop.signal, launch: async () => {}, delay: async () => stop.abort() }); await Promise.all([one, two]); });
});
