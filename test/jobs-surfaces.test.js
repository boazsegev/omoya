import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { initializeJobs, disableJobs } from "../lib/jobs/lifecycle.js";
import { jobsPaths, scheduleJobs, jobsStatus, dispatchJobs } from "../lib/jobs.js";
import { jobSchedule, toolDescription } from "../tools/job-schedule.js";
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await fs.realpath(await fs.mkdtemp("./ai-tmp/jobs-surfaces-")); roots.push(root); await initializeJobs(root); return { root, paths: jobsPaths(root), env: { cwd: root, settings: {} } }; }
async function cli(root, ...args) {
  const child = Bun.spawn([process.execPath, resolve("bin/scripts/jobs"), ...args], { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { stdout, stderr, code };
}
async function tree(path) { const result = {}; for (const entry of await fs.readdir(path, { withFileTypes: true })) result[entry.name] = entry.isDirectory() ? await tree(join(path, entry.name)) : await fs.readFile(join(path, entry.name), "utf8"); return result; }
describe("manual Jobs surfaces", () => {
  test("CRUD changes only tasks and redacted diagnostics, never lifecycle, even with dead daemon residue", async () => {
    const { root, paths, env } = await fixture();
    const before = await tree(paths.root), scheduler = new Proxy({}, { get() { throw new Error("scheduler must not be touched"); } });
    await jobSchedule({ action: "create", filename: "a.md", prompt: "work", schedule: "every 1h" }, { env, scheduler });
    await jobSchedule({ action: "update", filename: "a.md", prompt: "changed", enabled: false }, { env, scheduler });
    expect((await scheduleJobs(root, { action: "read", filename: "a.md" })).task.enabled).toBe(false);
    expect((await scheduleJobs(root, { action: "list" })).tasks).toHaveLength(1);
    await jobSchedule({ action: "remove", filename: "a.md" }, { env, scheduler }); expect(await tree(paths.root)).toEqual(before);
    await fs.writeFile(join(paths.tasks, "bad.md"), "---\nunknown: secret-value\n---\nwork");
    const listed = await scheduleJobs(root, { action: "list" });
    expect(listed.tasks.map((task) => task.id)).not.toContain("bad.md");
    expect(listed.diagnostics).toContainEqual({ filename: "bad.md", code: "JOBS_TASK_UNKNOWN_KEY", reportable: true });
    const after = await tree(paths.root); delete after.tasks; delete after.errors; delete before.tasks; delete before.errors; expect(after).toEqual(before);
    expect(JSON.stringify(await tree(paths.errors))).not.toContain("secret-value");
  });
  test("disable after task publication cannot be undone by tool repair", async () => {
    const { root, env } = await fixture();
    // A scheduler getter is an old post-publication repair trap: any access would
    // race disable with tool-side init. The task boundary must never access it.
    let lifecycleAccess = false;
    const context = { env, get scheduler() { lifecycleAccess = true; throw new Error("post-publication lifecycle access"); } };
    await jobSchedule({ action: "create", filename: "a.md", prompt: "work" }, context);
    await disableJobs(root);
    expect(lifecycleAccess).toBe(false);
    await expect(jobSchedule({ action: "update", filename: "a.md", prompt: "no" }, { env })).rejects.toMatchObject({ code: "JOBS_DISABLED" });
  });
  test("tool eligibility refresh, safe/folder permission and stale invocation retain their boundaries", async () => {
    const { root, env } = await fixture(), available = toolDescription()["job-schedule"].available;
    expect(await available(env, {})).toBe(true); expect(await available(env, { agent: { safe: true } })).toBe(false);
    await expect(jobSchedule({ action: "list" }, { env, agent: { safe: true } })).rejects.toThrow("read-only");
    await expect(jobSchedule({ action: "list" }, { env, agent: { folder: resolve(".") } })).rejects.toMatchObject({ code: "JOBS_PROJECT_FOLDER" });
    await expect(jobSchedule({ action: "init" }, { env })).rejects.toMatchObject({ code: "JOBS_COMMAND" });
    await disableJobs(root); expect(await available(env, {})).toBe(false);
    await expect(jobSchedule({ action: "list" }, { env })).rejects.toMatchObject({ code: "JOBS_DISABLED" });
  });
  test("status reads do not write or launch a daemon", async () => { const { root, paths } = await fixture(); await fs.writeFile(join(paths.tasks, "a.md"), "work"); const before = await tree(paths.root), status = await jobsStatus(root, { clock: () => 5 }); expect(status.eligibility.state).toBe("enabled"); expect(status.daemon).toBeUndefined(); expect(await tree(paths.root)).toEqual(before); });
  test("CLI local lifecycle, refusal, status and explicit reinitialization", async () => {
    const { root, paths } = await fixture(); await fs.rm(paths.root, { recursive: true });
    expect((await cli(root, "run")).stderr).toContain("JOBS_INACTIVE"); expect(await fs.exists(paths.root)).toBe(false);
    const absent = await cli(root, "status"); expect(absent.code).toBe(1); expect(JSON.parse(absent.stdout).eligibility.state).toBe("absent"); expect(await fs.exists(paths.root)).toBe(false);
    expect((await cli(root, "--init")).code).toBe(0); expect((await cli(root, "status")).code).toBe(0); expect((await cli(root, "run")).code).toBe(0);
    expect((await cli(root, "--disable")).code).toBe(0); expect((await cli(root, "run")).stderr).toContain("JOBS_DISABLED");
    expect((await cli(root, "init")).code).toBe(0);
    expect((await cli(root, "--help")).stdout).toContain("No locks"); expect((await cli(root, "init", "--scheduler", "daemon")).code).toBe(1);
  });
});
