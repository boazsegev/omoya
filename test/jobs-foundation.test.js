import { describe, expect, test } from "bun:test";
import API from "../lib/index.js";
import Jobs, { JobsError, cycleRecord, dispatchJobs } from "../lib/jobs.js";

describe("jobs public domain foundation", () => {
  test("is one importable namespace through direct and package facades", () => {
    expect(API.Jobs).toBe(Jobs);
    expect(Jobs.JobsError).toBe(JobsError);
    expect(Jobs.dispatchJobs).toBe(dispatchJobs);
    expect(Jobs.cycleRecord).toBe(cycleRecord);
    expect(Jobs.cronInterval).toBeUndefined();
    expect(Jobs.jobsCronEntry).toBeUndefined();
    expect(Jobs.uninstallJobs).toBeUndefined();
  });

  test("publishes the dispatcher cycle record without a second dispatcher", () => {
    expect(cycleRecord(42)).toEqual({ version: 1, at: 42, due: [], running: [], outcomes: [], errors: [] });
    expect(cycleRecord(42).busy).toBeUndefined();
    expect(() => cycleRecord(-1)).toThrow("cycle time");
  });
});
