import { afterEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import * as fs from "node:fs/promises";
import { dispatchJobs, ensureJobsLayout, initializeJobs, disableJobs, loadTaskState, parseTask, statePath, createTaskState, admitOccurrence, recordAttempt, saveTaskState } from "../lib/jobs.js";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(files = {}) {
  await fs.mkdir("./ai-tmp", { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp("./ai-tmp/jobs-dispatch-")); roots.push(root); const paths = await ensureJobsLayout(root);
  for (const [name, source] of Object.entries(files)) await fs.writeFile(join(paths.tasks, name), source);
  return { root, paths };
}
const recurring = "---\nschedule: every 1m\n---\nprompt";
async function state(root, name, source = "prompt") { return loadTaskState(root, parseTask(name, source)); }
async function tree(path) {
  const result = {};
  for (const entry of await fs.readdir(path, { withFileTypes: true })) result[entry.name] = entry.isDirectory() ? await tree(join(path, entry.name)) : await fs.readFile(join(path, entry.name), "utf8");
  return result;
}

describe("best-effort dispatcher", () => {
  test("orders serially, records success/failure durably, and never reclassifies normal completion as interrupted", async () => {
    const { root, paths } = await fixture({ "b.md": recurring, "a.md": recurring }); const seen = [];
    const result = await dispatchJobs(root, { clock: () => 10, executor: async (task) => { seen.push(task.id); if (task.id === "a.md") throw new Error("no"); return { session: "test-session" }; } });
    expect(seen).toEqual(["a.md", "b.md"]); expect(result.outcomes.map((item) => item.outcome)).toEqual(["failed", "completed"]);
    for (const [name, outcome] of [["a.md", "failed"], ["b.md", "completed"]]) {
      const saved = await state(root, name, recurring); expect(saved.occurrences[0].status).toBe("consumed"); expect(saved.occurrences[0].attempts[0].outcome).toBe(outcome);
    }
    await dispatchJobs(root, { clock: () => 11 }); expect((await state(root, "b.md", recurring)).occurrences[0].attempts[0]).toMatchObject({ outcome: "completed", session: "test-session" });
    expect(JSON.parse(await fs.readFile(paths.lastRun, "utf8")).errors).toEqual([]);
  });
  test("default executor blocks without a selected model instead of faking success", async () => {
    const { root } = await fixture({ "a.md": "a" });
    const result = await dispatchJobs(root, { execution: { environment: { dir: root, settingsDir: null } } });
    expect(result.errors[0].code).toBe("JOBS_MODEL_BLOCKED");
    expect((await state(root, "a.md")).occurrences[0].attempts[0]).toMatchObject({ outcome: "blocked", session: expect.any(String) });
  });
  for (const mutation of ["remove", "disable", "change"]) test(`revalidation blocks task ${mutation}`, async () => {
    const { root, paths } = await fixture({ "a.md": recurring, "b.md": recurring });
    const result = await dispatchJobs(root, { executor: async (task) => {
      expect(task.id).toBe("a.md"); const target = join(paths.tasks, "b.md");
      if (mutation === "remove") await fs.unlink(target);
      else await fs.writeFile(target, mutation === "disable" ? "---\nenabled: false\nschedule: every 1m\n---\nprompt" : `${recurring} changed`);
    } });
    expect(result.outcomes).toEqual([{ id: "a.md", outcome: "completed" }, { id: "b.md", outcome: "blocked" }]);
  });
  test("corrupt state stops execution and records error", async () => {
    const { root, paths } = await fixture({ "a.md": "a" }); await fs.writeFile(statePath(root, "a.md"), "{");
    const result = await dispatchJobs(root, { executor: async () => { throw new Error("must not run"); } });
    expect(result.errors[0].code).toBe("JOBS_STATE_READ"); expect(JSON.parse(await fs.readFile(paths.lastRun, "utf8"))).toEqual(result);
  });
  test("retains exactly 64 run diagnostics and includes parser rejections", async () => {
    const { root, paths } = await fixture({ "empty.md": "# " });
    for (let now = 0; now < 66; now++) await dispatchJobs(root, { clock: () => now });
    expect((await fs.readdir(paths.runs)).filter((name) => name.endsWith(".json"))).toHaveLength(64);
    expect(JSON.parse(await fs.readFile(paths.lastRun, "utf8")).errors[0].code).toBe("JOBS_TASK_PROMPT");
  });
  test("reports delimiter-less metadata and dispatches a valid on-disk sibling", async () => {
    const { root } = await fixture({
      "bad-enabled.md": "enabled: false\nMust be rejected, not dispatched once.",
      "bad-schedule.md": "schedule: every 1h\nMust be rejected, not dispatched once.",
      "bad-yaml.md": "id: [\nMust be rejected, not dispatched once.",
      "valid.md": "---\nid: valid\nschedule: every 1m\n---\nRun valid sibling.",
    });
    const seen = [];
    const result = await dispatchJobs(root, { clock: () => 1, executor: async (task) => { seen.push(task.id); return { outcome: "completed" }; } });
    expect(seen).toEqual(["valid"]);
    expect(result.errors.filter((error) => error.code === "JOBS_TASK_YAML").map((error) => error.filename)).toEqual(["bad-enabled.md", "bad-schedule.md", "bad-yaml.md"]);
    expect(result.outcomes).toEqual([{ id: "valid", outcome: "completed" }]);
  });
  test("calendar tasks execute serially in scheduled epoch order and coalesce stranded due history", async () => {
    const calendar = (times) => `---\nschedule:\n  at: [${times.map((time) => `"${time} GMT"`).join(", ")}]\n  days: weekdays\n---\ncalendar prompt`;
    const files = { "a.md": calendar(["09:00", "13:00"]), "z.md": calendar(["08:00"]) };
    const { root } = await fixture(files), seen = [];
    const clock = (value) => () => Date.parse(value);
    await dispatchJobs(root, { clock: clock("2026-09-14T07:00:00Z"), executor: async () => { throw new Error("future must not run"); } });
    const result = await dispatchJobs(root, { clock: clock("2026-09-14T14:00:00Z"), executor: async (task) => { seen.push([task.id, task.occurrence.scheduledAt]); return { outcome: "completed" }; } });
    expect(result.errors).toEqual([]);
    expect(seen).toEqual([["z.md", Date.parse("2026-09-14T08:00:00Z")], ["a.md", Date.parse("2026-09-14T13:00:00Z")]]);
    const saved = await state(root, "a.md", files["a.md"]);
    expect(saved.occurrences.map((item) => item.status)).toEqual(["coalesced", "consumed"]);
    const rollback = await dispatchJobs(root, { clock: clock("2026-09-14T10:00:00Z"), executor: async () => { throw new Error("rollback must not run"); } });
    expect(rollback.due).toEqual([]); expect(rollback.errors).toEqual([]);
    const repeat = await dispatchJobs(root, { clock: clock("2026-09-14T14:00:00Z"), executor: async () => { throw new Error("history must not replay"); } });
    expect(repeat.due).toEqual([]); expect(repeat.errors).toEqual([]);
  });
  test("excluded elapsed days never execute even when a prior due occurrence is stranded", async () => {
    const source = "---\nschedule:\n  every: 1h\n  days: weekdays\n---\nfiltered";
    const { root } = await fixture({ "filtered.md": source });
    const task = parseTask("filtered.md", source);
    const friday = new Date(2026, 8, 11, 23, 30).getTime();
    const saved = admitOccurrence(createTaskState(task), task, friday).state;
    await saveTaskState(root, saved);
    const sunday = new Date(2026, 8, 13, 23, 45).getTime();
    const excluded = await dispatchJobs(root, { clock: () => sunday, executor: async () => { throw new Error("excluded day must not run"); } });
    expect(excluded.due).toEqual([]); expect(excluded.errors).toEqual([]);
    const monday = new Date(2026, 8, 14, 0, 45).getTime();
    const seen = [];
    const resumed = await dispatchJobs(root, { clock: () => monday, executor: async (task) => { seen.push(task.occurrence.scheduledAt); } });
    expect(resumed.errors).toEqual([]); expect(seen).toEqual([new Date(2026, 8, 14, 0, 30).getTime()]);
    expect((await state(root, task.filename, source)).anchor).toBe(friday);
  });
  test("calendar disable/re-enable and schedule edits preserve consumed history without replay", async () => {
    const source = (time, enabled = true) => `---\nenabled: ${enabled}\nschedule:\n  at: ["${time} GMT"]\n---\nprompt`;
    const { root, paths } = await fixture({ "calendar.md": source("09:00") });
    const executeAt = (time) => dispatchJobs(root, { clock: () => Date.parse(time), executor: async () => ({ outcome: "completed" }) });
    await executeAt("2026-09-14T10:00:00Z");
    await fs.writeFile(join(paths.tasks, "calendar.md"), source("09:00", false));
    expect((await executeAt("2026-09-16T10:00:00Z")).due).toEqual([]);
    await fs.writeFile(join(paths.tasks, "calendar.md"), source("09:00"));
    expect((await executeAt("2026-09-16T10:00:00Z")).due).toHaveLength(1);
    await fs.writeFile(join(paths.tasks, "calendar.md"), source("11:00"));
    expect((await executeAt("2026-09-17T10:00:00Z")).due).toEqual([]);
    expect((await executeAt("2026-09-17T12:00:00Z")).due[0].scheduledAt).toBe(Date.parse("2026-09-17T11:00:00Z"));
    const saved = await state(root, "calendar.md", source("11:00"));
    expect(saved.occurrences.map((item) => item.status)).toEqual(["consumed", "coalesced", "consumed", "consumed"]);
  });
  test("stranded prior prepared attempt for removed task is recovered, never replayed", async () => {
    const { root, paths } = await fixture(); const task = parseTask("gone.md", "gone");
    let saved = admitOccurrence(createTaskState(task), task, 1).state; const archive = join(paths.completed, "gone.md");
    saved = recordAttempt(saved, "gone.md@1", { id: "attempt", archive: "completed/gone.md" }); await saveTaskState(root, saved); await fs.writeFile(archive, "gone");
    await dispatchJobs(root); expect((await state(root, "gone.md")).occurrences[0].attempts[0].outcome).toBe("interrupted");
  });
  for (const [name, source] of [["one-shot", "one"], ["recurring", recurring]]) test(`${name} attempts persist a relative archive reference only`, async () => {
    const { root } = await fixture({ "task.md": source });
    await dispatchJobs(root, { clock: () => 10, executor: async () => ({ outcome: "completed" }) });
    const saved = await state(root, "task.md", source), archive = saved.occurrences[0].attempts[0].archive;
    expect(archive).toMatch(name === "one-shot" ? /^completed\// : /^runs\//);
    expect(archive).not.toContain(root); expect(JSON.stringify(saved)).not.toContain(root);
  });
  for (const outcome of ["completed", "failed", "cancelled"]) test(`disable after prepared leaves ${outcome} finalization unavailable without recreating ai-jobs`, async () => {
    const { root, paths } = await fixture({ "task.md": recurring }); let prepared;
    const running = dispatchJobs(root, { clock: () => 10, executor: async () => { prepared = await state(root, "task.md", recurring); await disableJobs(root); return { outcome }; } });
    const result = await running;
    expect(prepared.occurrences[0].attempts[0]).toMatchObject({ outcome: "prepared", archive: expect.stringMatching(/^runs\//) });
    expect(result.errors).toContainEqual({ id: "task.md", code: "JOBS_FINALIZE_UNAVAILABLE", message: "attempt finalization is unavailable" });
    expect(await fs.exists(paths.root)).toBeFalse(); expect(await fs.exists(paths.disabled)).toBeTrue();
    const disabled = JSON.parse(await fs.readFile(join(paths.disabled, "state", "task.md.json"), "utf8"));
    expect(disabled.occurrences[0].attempts[0].outcome).toBe("prepared");
  });
  test("disable then restore while old execution completes cannot overwrite restored state", async () => {
    const { root, paths } = await fixture({ "task.md": recurring }); let finish; const completed = new Promise((resolve) => { finish = resolve; });
    const old = dispatchJobs(root, { clock: () => 10, executor: async () => { await disableJobs(root); await initializeJobs(root); await fs.writeFile(join(paths.state, "restored.json"), "preserve"); await completed; return { outcome: "completed" }; } });
    while (!(await fs.exists(join(paths.state, "restored.json")))) await Bun.sleep(1);
    finish(); const result = await old;
    expect(result.errors).toEqual([]);
    expect(await fs.readFile(join(paths.state, "restored.json"), "utf8")).toBe("preserve");
    const restored = JSON.parse(await fs.readFile(join(paths.state, "task.md.json"), "utf8"));
    expect(restored.occurrences[0].attempts[0].outcome).toBe("completed");
    // Restore moves the same directory back: without generations or locks, the
    // old completion is allowed to finalize that restored tree, but cannot
    // overwrite unrelated restored state.
  });
});
