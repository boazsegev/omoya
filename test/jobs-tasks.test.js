import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Jobs from "../lib/jobs.js";
import { errorsLog, localStamp, messageLocal } from "../lib/jobs/errors.js";
import { dispatchJobs } from "../lib/jobs/dispatcher.js";
import { parseTask, parseTasks, taskId, taskStateKey } from "../lib/jobs/tasks.js";

const roots = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "jobs-tasks-")); roots.push(root); await Jobs.init(root); return root; }
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
    expect(task.diagnostics).toEqual([]); expect(Jobs.parseTask).toBeUndefined();
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
      catch (error) { expect(error).toMatchObject({ code: "JOBS_TASK_SCHEDULE", details: { filename: name + ".md" } }); }
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
    catch (error) { expect(error).toMatchObject({ code: "JOBS_TASK_CREDENTIAL", details: { filename: "credential-first.md" } }); }
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
      catch (error) { expect(error).toMatchObject({ code, details: { filename: `${name}.md` } }); }
    }
  });

  test("blocks and reports cyclic YAML aliases without losing valid siblings", () => {
    const entries = [
      { filename: "object-cycle.md", source: "---\na: &a {self: *a}\n---\nObject body" },
      { filename: "array-cycle.md", source: "---\ntools: &a [*a]\n---\nArray body" },
      { filename: "valid.md", source: "---\nid: stable\n---\nValid body" },
    ];
    const parsed = parseTasks(entries);
    expect(parsed.tasks.map((task) => task.id)).toEqual(["stable"]);
    expect(parsed.diagnostics).toEqual([
      { filename: "object-cycle.md", code: "JOBS_TASK_YAML_CYCLE", message: "task frontmatter cannot contain cyclic YAML aliases" },
      { filename: "array-cycle.md", code: "JOBS_TASK_YAML_CYCLE", message: "task frontmatter cannot contain cyclic YAML aliases" },
    ]);
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
      catch (error) { expect(error).toMatchObject({ code: "JOBS_TASK_YAML", details: { filename } }); }
    }
    defaults(parseTask("prose.md", "Note: this is ordinary Markdown prose."), "prose.md", "Note: this is ordinary Markdown prose.");
    defaults(parseTask("rule.md", "---\nordinary Markdown horizontal-rule content"), "rule.md", "---\nordinary Markdown horizontal-rule content");

    const parsed = parseTasks([
      ...rejected.map(([filename, source]) => ({ filename, source })),
      { filename: "valid.md", source: "---\nid: valid-sibling\nschedule: every 1h\n---\nRun." },
    ]);
    expect(parsed.tasks.map((task) => task.id)).toEqual(["valid-sibling"]);
    expect(parsed.diagnostics.map(({ filename, code }) => ({ filename, code }))).toEqual(rejected.map(([filename]) => ({ filename, code: "JOBS_TASK_YAML" })));
    for (const item of parsed.diagnostics) expect(item.message).toStartWith("task frontmatter");
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

  test("names the offending key so the task file can be fixed", () => {
    const { diagnostics } = parseTasks([
      { filename: "bad.md", source: "---\napiKey: abc\n---\nBody" },
      { filename: "typo.md", source: "---\nshedule: every 1h\n---\nBody" },
      { filename: "one.md", source: "---\nid: same\n---\nPrompt" },
      { filename: "two.md", source: "---\nid: same\n---\nPrompt" },
    ]);
    expect(diagnostics.map(({ filename, code }) => [filename, code])).toEqual([["bad.md", "JOBS_TASK_CREDENTIAL"], ["typo.md", "JOBS_TASK_UNKNOWN_KEY"], ["two.md", "JOBS_TASK_DUPLICATE_ID"], ["one.md", "JOBS_TASK_DUPLICATE_ID"]]);
    expect(diagnostics[0].message).toContain('"apiKey"');
    expect(diagnostics[1].message).toContain('"shedule"');
    expect(diagnostics[1].message).toContain("schedule");
    expect(diagnostics[2].message).toContain('"same"');
  });

  test("error log: readable Markdown per day with task file, time, code, message, outcome and session", async () => {
    const root = await fixture(), at = new Date(2026, 8, 28, 5, 26, 57).getTime();
    const log = await errorsLog(root, [
      { filename: "bad.md", code: "JOBS_TASK_UNKNOWN_KEY", message: 'task frontmatter has an unknown key "shedule"' },
      { id: "report", filename: "report.md", code: "JOBS_FAILED", message: "provider refused", outcome: "failed", session: "job-1" },
    ], at);
    expect(log).toBe("ai-jobs/errors/2026-09-28.md");
    expect(await readFile(join(root, log), "utf8")).toBe(`# Jobs errors 2026-09-28

## 05:26:57 — bad.md — JOBS_TASK_UNKNOWN_KEY

task frontmatter has an unknown key "shedule"

## 05:26:57 — report.md — JOBS_FAILED

provider refused

- Task id: report
- Outcome: failed
- Session: job-1

`);
    expect(localStamp(at)).toEqual({ date: "2026-09-28", time: "05:26:57" });
  });

  test("error log: a task-file problem is logged once per day, job failures every time", async () => {
    const root = await fixture(), at = new Date(2026, 8, 28, 9, 0, 0).getTime();
    const fileProblem = { filename: "bad.md", code: "JOBS_TASK_YAML", message: "task frontmatter is malformed YAML: x" };
    const failure = { filename: "job.md", code: "JOBS_FAILED", message: "boom", outcome: "failed", session: "s" };
    await errorsLog(root, [fileProblem, failure], at);
    await errorsLog(root, [fileProblem, failure], at + 300_000);
    const content = await readFile(join(root, "ai-jobs/errors/2026-09-28.md"), "utf8");
    expect(content.match(/— bad\.md —/g)).toHaveLength(1);
    expect(content.match(/— job\.md —/g)).toHaveLength(2);
    expect(await errorsLog(root, [], at)).toBeUndefined();
  });

  test("errors never name anything outside the project; inside paths read relative", async () => {
    const root = await fixture();
    expect(messageLocal(root, `ENOENT: no such file or directory, open '${root}/ai-jobs/tasks/a.md'`)).toBe("ENOENT: no such file or directory, open 'ai-jobs/tasks/a.md'");
    expect(messageLocal(root, "cannot read /Users/someone/.omoya-settings/auth-openai.json")).toBe("cannot read …/auth-openai.json");
    expect(messageLocal(root, "see https://api.example.com/v1/models")).toBe("see https://api.example.com/v1/models");
    // End to end: a scan's log and record hold the task file and message, never the root.
    const tasks = join(root, "ai-jobs/tasks");
    await Bun.write(join(tasks, "typo.md"), "---\nshedule: every 1h\n---\nBody");
    await Bun.write(join(tasks, "job.md"), "Run it");
    const result = await dispatchJobs(root, { executor: async () => { throw new Error(`cannot open ${tasks}/job.md or /etc/omoya/secret.conf`); } });
    const log = await readFile(join(root, result.log), "utf8"), record = await readFile(join(root, "ai-jobs/last-run.json"), "utf8");
    expect(log).toContain("— typo.md — JOBS_TASK_UNKNOWN_KEY");
    expect(log).toContain("cannot open ai-jobs/tasks/job.md or …/secret.conf");
    for (const text of [log, record]) { expect(text).not.toContain(root); expect(text).not.toContain("/etc/omoya"); }
  });

  test("derives ids and keeps state keys safe", () => {
    expect(taskId("one.task.md")).toBe("one.task.md");
    expect(parseTask("renamed.md", "---\nid: durable\n---\nPrompt").id).toBe("durable");
    expect(taskStateKey("ordinary.id")).toBe("ordinary.id");
    expect(taskStateKey("../../unsafe id")).toMatch(/^task-[a-f0-9]{32}$/);
  });
});
