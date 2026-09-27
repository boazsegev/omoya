import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { initializeJobs, disableJobs } from "../lib/jobs/lifecycle.js";
import { jobsPaths } from "../lib/jobs/paths.js";
import { daemonLoop, daemonDelay, JOBS_DAEMON_DELAY } from "../lib/jobs/daemon-loop.js";
import { foregroundJobsDaemon } from "../lib/jobs/daemon.js";
const roots = [];
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture() { const root = await fs.realpath(await fs.mkdtemp("./ai-tmp/jobs-daemon-")); roots.push(root); await initializeJobs(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
describe("best-effort foreground daemon", () => {
  test("scans immediately then waits five minutes after completion", async () => { const stop = new AbortController(), scan = deferred(), waiting = deferred(); let scans = 0; const running = daemonLoop({ signal: stop.signal, admit: async () => true, scan: async () => { scans++; await scan.promise; }, state() {}, delay: async (ms) => { expect(ms).toBe(JOBS_DAEMON_DELAY); waiting.resolve(); stop.abort(); } }); await Promise.resolve(); expect(scans).toBe(1); scan.resolve(); await waiting.promise; await running; await daemonDelay(1, new AbortController().signal); });
  test("folder disappearance exits foreground daemon without durable control state", async () => { const root = await fixture(), active = deferred(), drain = deferred(); const running = foregroundJobsDaemon(root, { scan: async () => { active.resolve(); await drain.promise; }, delay: async () => {} }); await active.promise; await disableJobs(root); drain.resolve(); await running; });
  test("multiple foreground daemons are allowed", async () => { const root = await fixture(), stop = new AbortController(); const one = foregroundJobsDaemon(root, { signal: stop.signal, scan: async () => {}, delay: async () => stop.abort() }); const two = foregroundJobsDaemon(root, { signal: stop.signal, scan: async () => {}, delay: async () => stop.abort() }); await Promise.all([one, two]); });
});
describe("daemon scans in-process through the library", () => {
  test("stopping the daemon cancels the running scan's jobs and returns nothing", async () => {
    const root = await fixture(), stop = new AbortController(), started = deferred();
    let seen;
    const running = foregroundJobsDaemon(root, {
      signal: stop.signal, delay: async () => {},
      scan: (project, options) => { seen = { project, options }; started.resolve(); return new Promise((resolve) => options.execution.signal.addEventListener("abort", resolve)); },
    });
    await started.promise;
    expect(seen.project).toBe(root);
    expect(seen.options.execution.signal.aborted).toBeFalse();
    stop.abort();
    expect(await running).toBeUndefined();
    expect(seen.options.execution.signal.aborted).toBeTrue();
  });
  test("the default scan is dispatchJobs: each wake writes its run log", async () => {
    const root = await fixture(), stop = new AbortController();
    await foregroundJobsDaemon(root, { signal: stop.signal, delay: async () => stop.abort() });
    expect(JSON.parse(await fs.readFile(jobsPaths(root).lastRun, "utf8"))).toMatchObject({ outcomes: [], errors: [] });
  });
});
