import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Jobs, { loadTasks, parseTask, parseTasks, taskDiagnosticKey, taskId, taskStateKey } from "../lib/jobs.js";

const roots = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "jobs-tasks-")); roots.push(root); await Jobs.initializeJobs(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function defaults(task, filename, prompt) {
  expect(task).toMatchObject({ id: filename, filename, prompt, enabled: true, schedule: { kind: "once" }, metadata: {} });
  expect(task.tools).toBeUndefined(); expect(task.timeout).toBeUndefined(); expect(task.model).toBeUndefined();
}

 describe("jobs Markdown task parsing", () => {
  test("normalizes plain Markdown and valid, complete frontmatter", () => {
    defaults(parseTask("daily.md", "# Do the daily thing"), "daily.md", "# Do the daily thing");
    defaults(parseTask("rule.md", "---\n# ordinary Markdown rule, not metadata\nBody"), "rule.md", "---\n# ordinary Markdown rule, not metadata\nBody");
    defaults(parseTask("rules.md", "---\nBody between Markdown rules\n---\nAfter"), "rules.md", "---\nBody between Markdown rules\n---\nAfter");

    const task = parseTask("ignored.md", "---\nid: stable-id\nenabled: false\nschedule: every 1w\ntools: [read, bash]\ntimeout: 5m\nmodel: fast\n---\nAct now.");
    expect(task).toMatchObject({ id: "stable-id", filename: "ignored.md", prompt: "Act now.", enabled: false, schedule: { kind: "every", every: "1w", milliseconds: 604800000 }, tools: ["read", "bash"], timeout: 300000, model: "fast" });
    expect(task.diagnostics).toEqual([]); expect(Jobs.parseTask).toBe(parseTask);
  });

  test("normalizes structured calendar schedules independently of machine timezone", () => {
    const local = parseTask("local.md", "---\nschedule:\n  at: [\"09:30\", \"16:00\"]\n  days: weekdays\n---\nPrompt");
    expect(local.schedule).toEqual({ kind: "at", minutes: [570, 960], days: [1, 2, 3, 4, 5], timeZone: "local" });
    const gmt = parseTask("gmt.md", "---\nschedule:\n  at: [\"09:30 gMt\", \"16:00 GMT\"]\n  days: [mon, wed, fri]\n---\nPrompt");
    expect(gmt.schedule).toEqual({ kind: "at", minutes: [570, 960], days: [1, 3, 5], timeZone: "gmt" });
    const recurring = parseTask("recurring.md", "---\nschedule: {every: 1h, days: weekends}\n---\nPrompt");
    expect(recurring.schedule).toEqual({ kind: "every", every: "1h", milliseconds: 3600000, days: [0, 6], timeZone: "local" });
  });

  test("blocks invalid structured calendar schedules", () => {
    const huge = "9".repeat(400);
    const cases = [
      ["time", "schedule: {at: [\"9:30\"]}"],
      ["midnight-upper", "schedule: {at: [\"24:00\"]}"],
      ["day", "schedule: {at: [\"09:30\"], days: [monday]}"],
      ["mixed", "schedule: {at: [\"09:30\", \"16:00 GMT\"]}"],
      ["gmt-whitespace", "schedule: {at: [\"09:30  GMT\"]}"],
      ["duplicate-gmt", "schedule: {at: [\"09:30 GMT\", \"09:30 gmt\"]}"],
      ["both", "schedule: {at: [\"09:30\"], every: 1h}"],
      ["unknown", "schedule: {at: [\"09:30\"], basis: GMT}"],
      ["unknown-nested", "schedule: {at: [\"09:30\"], days: {include: [mon]}}"],
      ["scalar-coercion", "schedule: {every: 1}"],
      ["every-overflow", "schedule: {every: " + huge + "m}"],
    ];
    for (const [name, field] of cases) {
      expect(() => parseTask(name + ".md", "---\nid: should-not-survive\nenabled: false\n" + field + "\n---\nPrompt")).toThrow();
      try { parseTask(name + ".md", "---\nid: should-not-survive\nenabled: false\n" + field + "\n---\nPrompt"); }
      catch (error) { expect(error).toMatchObject({ code: "JOBS_TASK_SCHEDULE", details: { filename: name + ".md", reportable: true } }); }
    }
  });

  test("deep-freezes normalized structured schedules and metadata", () => {
    const task = parseTask("frozen.md", "---\nschedule: {at: [\"00:00 GMT\"], days: [mon]}\n---\nPrompt");
    expect(task.schedule).toEqual({ kind: "at", minutes: [0], days: [1], timeZone: "gmt" });
    expect(Object.isFrozen(task.schedule)).toBe(true);
    expect(Object.isFrozen(task.schedule.minutes)).toBe(true);
    expect(Object.isFrozen(task.schedule.days)).toBe(true);
    expect(Object.isFrozen(task.metadata)).toBe(true);
    expect(() => task.schedule.minutes.push(1)).toThrow();
    expect(() => { task.metadata.schedule.at[0] = "01:00"; }).toThrow();
  });

  test("prioritizes credential rejection over unknown nested keys", () => {
    expect(() => parseTask("credential-first.md", "---\nsettings: {token: secret}\n---\nPrompt")).toThrow();
    try { parseTask("credential-first.md", "---\nsettings: {token: secret}\n---\nPrompt"); }
    catch (error) { expect(error).toMatchObject({ code: "JOBS_TASK_CREDENTIAL", details: { filename: "credential-first.md", reportable: true } }); }
  });

  test("blocks every malformed declared frontmatter class", () => {
    const cases = [
      ["malformed", "---\nid: [\n---\nPrompt", "JOBS_TASK_YAML"],
      ["unknown", "---\nid: retained?\ncolor: blue\n---\nPrompt", "JOBS_TASK_UNKNOWN_KEY"],
      ["invalid", "---\nid: retained?\nenabled: nope\n---\nPrompt", "JOBS_TASK_METADATA"],
      ["credential", "---\nid: retained?\noptions: {authToken: super-secret}\n---\nPrompt", "JOBS_TASK_CREDENTIAL"],
      ["tag", "---\nid: !danger retained\n---\nPrompt", "JOBS_TASK_YAML_TAG"],
    ];
    for (const [name, source, code] of cases) {
      expect(() => parseTask(`${name}.md`, source)).toThrow();
      try { parseTask(`${name}.md`, source); }
      catch (error) { expect(error).toMatchObject({ code, details: { filename: `${name}.md`, reportable: true } }); }
    }
  });

  test("blocks and reports cyclic YAML aliases without losing valid siblings", async () => {
    const root = await fixture();
    const entries = [
      { filename: "object-cycle.md", source: "---\na: &a {self: *a}\n---\nObject body" },
      { filename: "array-cycle.md", source: "---\ntools: &a [*a]\n---\nArray body" },
      { filename: "valid.md", source: "---\nid: stable\n---\nValid body" },
    ];
    const parsed = parseTasks(entries);
    expect(parsed.tasks.map((task) => task.id)).toEqual(["stable"]);
    expect(parsed.diagnostics).toEqual([
      { filename: "object-cycle.md", code: "JOBS_TASK_YAML_CYCLE", reportable: true },
      { filename: "array-cycle.md", code: "JOBS_TASK_YAML_CYCLE", reportable: true },
    ]);
    const loaded = await loadTasks(root, entries);
    expect(loaded.tasks.map((task) => task.id)).toEqual(["stable"]);
    const errors = await readdir(join(root, "ai-jobs/errors"));
    expect(errors).toHaveLength(2);
    for (const diagnostic of loaded.diagnostics) {
      const content = await readFile(join(root, "ai-jobs/errors", `${taskDiagnosticKey(diagnostic)}.json`), "utf8");
      expect(content).toBe(`${JSON.stringify({ code: "JOBS_TASK_YAML_CYCLE", task: taskDiagnosticKey(diagnostic) })}\n`);
      expect(content).not.toContain("self"); expect(content).not.toContain("tools");
    }
  });

  test("blocks invalid delimiter and YAML failures", () => {
    expect(() => parseTask("closed.md", "---\nid: x\nnot-yaml: [\n---\nBody survives")).toThrow();
    expect(() => parseTask("unclosed.md", "---\nid: x\nBody survives")).toThrow();
  });

  test("blocks delimiter-less recognized metadata but preserves ordinary Markdown", async () => {
    const root = await fixture();
    const rejected = [
      ["enabled.md", "enabled: false\nDo not silently become a one-shot task."],
      ["schedule.md", "schedule: every 1h\nDo not silently become a one-shot task."],
      ["malformed.md", "id: [\nDo not silently become a one-shot task."],
    ];
    for (const [filename, source] of rejected) {
      expect(() => parseTask(filename, source)).toThrow();
      try { parseTask(filename, source); }
      catch (error) { expect(error).toMatchObject({ code: "JOBS_TASK_YAML", details: { filename, reportable: true } }); }
    }
    defaults(parseTask("prose.md", "Note: this is ordinary Markdown prose."), "prose.md", "Note: this is ordinary Markdown prose.");
    defaults(parseTask("rule.md", "---\nordinary Markdown horizontal-rule content"), "rule.md", "---\nordinary Markdown horizontal-rule content");

    const loaded = await loadTasks(root, [
      ...rejected.map(([filename, source]) => ({ filename, source })),
      { filename: "valid.md", source: "---\nid: valid-sibling\nschedule: every 1h\n---\nRun." },
    ]);
    expect(loaded.tasks.map((task) => task.id)).toEqual(["valid-sibling"]);
    expect(loaded.diagnostics).toEqual(rejected.map(([filename]) => ({ filename, code: "JOBS_TASK_YAML", reportable: true })));
    const errors = await readdir(join(root, "ai-jobs/errors"));
    expect(errors).toHaveLength(3);
    for (const diagnostic of loaded.diagnostics) {
      const content = await readFile(join(root, "ai-jobs/errors", `${taskDiagnosticKey(diagnostic)}.json`), "utf8");
      expect(content).toBe(`${JSON.stringify({ code: "JOBS_TASK_YAML", task: taskDiagnosticKey(diagnostic) })}\n`);
      expect(content).not.toContain("enabled"); expect(content).not.toContain("schedule");
    }
  });

  test("keeps declared values strict internally by blocking invalid values", () => {
    for (const source of ["---\nschedule: every 90s\n---\nPrompt", "---\ntimeout: 0m\n---\nPrompt", "---\ntools: ['   ']\n---\nPrompt", "---\nmodel: ''\n---\nPrompt"]) {
      expect(() => parseTask("a.md", source)).toThrow();
    }
  });

  test("preserves task-local duplicate and empty-body rejection while valid siblings survive", () => {
    const result = parseTasks([
      { filename: "good.md", source: "Good prompt" },
      { filename: "bad.md", source: "---\nid: retained\ntoken: secret\n---\nFallback body" },
      { filename: "empty.md", source: "---\ncolor: blue\n---\n   \n" },
      { filename: "one.md", source: "---\nid: same\n---\nPrompt" },
      { filename: "two.md", source: "---\nid: same\n---\nPrompt" },
    ]);
    expect(result.tasks.map((task) => task.id)).toEqual(["good.md"]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["JOBS_TASK_CREDENTIAL", "JOBS_TASK_PROMPT", "JOBS_TASK_DUPLICATE_ID", "JOBS_TASK_DUPLICATE_ID"]);
  });

  test("reports only invalid metadata diagnostics atomically without source secrets", async () => {
    const root = await fixture();
    const entries = [
      { filename: "bad.md", source: "---\napiKey: never-write-this-secret\n---\nBody" },
      { filename: "valid.md", source: "---\nid: stable\n---\nBody" },
      { filename: "plain.md", source: "Body" },
    ];
    const result = await loadTasks(root, entries);
    expect(result.tasks.map((task) => task.id)).toEqual(["stable", "plain.md"]);
    const diagnostic = result.diagnostics[0];
    const path = join(root, "ai-jobs/errors", `${taskDiagnosticKey(diagnostic)}.json`);
    const content = await readFile(path, "utf8");
    expect(await readdir(join(root, "ai-jobs/errors"))).toEqual([`${taskDiagnosticKey(diagnostic)}.json`]);
    expect(content).toBe(`${JSON.stringify({ code: "JOBS_TASK_CREDENTIAL", task: taskDiagnosticKey(diagnostic) })}\n`);
    expect(content).not.toContain("secret"); expect(content).not.toContain("apiKey"); expect(content).not.toContain("bad.md");
  });

  test("derives ids and keeps state keys safe", () => {
    expect(taskId("one.task.md")).toBe("one.task.md");
    expect(parseTask("renamed.md", "---\nid: durable\n---\nPrompt").id).toBe("durable");
    expect(taskStateKey("ordinary.id")).toBe("ordinary.id");
    expect(taskStateKey("../../unsafe id")).toMatch(/^task-[a-f0-9]{32}$/);
  });
});
