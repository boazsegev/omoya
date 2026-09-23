import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import Jobs from "../lib/jobs.js";

const FIXTURES = "test/fixtures/jobs";
const TASK_NAMES = ["plain", "recurring", "disabled", "malformed", "duplicate first", "duplicate second"];
const roots = [];
function localDate(epoch) {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(epoch));
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}-${parts.find((part) => part.type === "day").value}`;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function source(index, name) {
  return fs.readFile(join(FIXTURES, `2026-09-15 ${String(index).padStart(3, "0")} ${name}.md`), "utf8");
}
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp("./ai-tmp/jobs-fixtures-"));
  roots.push(root);
  await Jobs.initializeJobs(root);
  const paths = Jobs.jobsPaths(root);
  await Promise.all(TASK_NAMES.map(async (name, index) => fs.writeFile(join(paths.tasks, `${name}.md`), await source(index, name))));
  return { root, paths };
}

describe("reusable jobs Markdown fixtures", () => {
  test("parsing keeps valid recurring metadata, pauses disabled tasks and rejects both duplicate IDs", async () => {
    const entries = await Promise.all(TASK_NAMES.map(async (name, index) => ({ filename: `${name}.md`, source: await source(index, name) })));
    const parsed = Jobs.parseTasks(entries);
    expect(parsed.tasks.map((task) => task.id)).toEqual(["plain.md", "recurring-report", "paused-report"]);
    expect(parsed.tasks[1]).toMatchObject({ schedule: { kind: "every", milliseconds: 3600000 }, tools: ["read"], timeout: 300000 });
    expect(parsed.tasks[2].enabled).toBe(false);
    expect(parsed.diagnostics.map((item) => item.code)).toEqual(["JOBS_TASK_YAML", "JOBS_TASK_DUPLICATE_ID", "JOBS_TASK_DUPLICATE_ID"]);
  });

  test("dispatch archives one-shots without clobbering, runs recurrence once per slot and preserves paused/duplicate sources", async () => {
    const { root, paths } = await fixture();
    const clock = () => Date.parse("2026-09-15T12:00:00Z");
    const collision = join(paths.completed, `${localDate(clock())} 000 plain.md`);
    const archived = await source(6, "archive collision");
    await fs.writeFile(collision, archived);
    const ran = [];
    const options = {
      clock,
      validate: (project) => Jobs.validateJobsOperational(project),
      executor: async (task) => { ran.push(task); return { outcome: "completed" }; },
    };
    const first = await Jobs.dispatchJobs(root, options);
    expect(first.outcomes).toHaveLength(2);
    expect(ran.map((task) => task.id).sort()).toEqual(["plain.md", "recurring-report"]);
    expect(await fs.readFile(collision, "utf8")).toBe(archived);
    const archiveDate = localDate(options.clock());
    expect((await fs.readdir(paths.completed)).sort()).toEqual([`${archiveDate} 000 plain.md`, `${archiveDate} 001 plain.md`]);
    expect((await fs.readdir(paths.tasks)).sort()).toEqual(["disabled.md", "duplicate first.md", "duplicate second.md", "malformed.md", "recurring.md"]);
    const diagnostics = await fs.readdir(paths.errors);
    expect(diagnostics).toHaveLength(1);
    expect(await fs.readFile(join(paths.errors, diagnostics[0]), "utf8")).not.toContain("enabled");
    expect((await Jobs.dispatchJobs(root, options)).outcomes).toEqual([]);
    expect((await Jobs.dispatchJobs(root, { ...options, clock: () => options.clock() + 3600000 })).outcomes).toEqual([{ id: "recurring-report", outcome: "completed" }]);
  });
});
