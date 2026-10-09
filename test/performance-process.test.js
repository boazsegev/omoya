import { test, expect } from "bun:test";
import { performanceCaseRun } from "./performance-process.js";

test("unknown fixture is rejected before spawn", async () => {
  await expect(performanceCaseRun("not-a-fixture", "case-0")).rejects.toThrow("Unknown performance case: not-a-fixture/case-0");
});

test("a child assertion failure retains its stderr and exits nonzero", async () => {
  try {
    await performanceCaseRun("boundary", "assertion", { timeout: 10000 });
    throw new Error("expected child rejection");
  } catch (error) {
    expect(error.message).toContain("Performance child failed");
    expect(error.message).toContain("boundary assertion reached");
    expect(error.message).toContain("diagnostic stdout");
    expect(error.message).toContain("stdout:");
    expect(error.message).toContain("stderr:");
    expect(error.message).toContain("exit 1");
  }
});
