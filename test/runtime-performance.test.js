import { describe, test } from "bun:test";
import { performanceCaseRun } from "./performance-process.js";

describe("non-settings runtime responsiveness", () => {
  test("context estimates observe live edits while unchanged strings avoid repeated scans", async () => {
    await performanceCaseRun("runtime", "case-0");
  }, 65000);

  test("plain 4MiB tool output is not rebuilt character by character, cold or repeated", async () => {
    await performanceCaseRun("runtime", "case-1");
  }, 65000);

  test("dense ANSI uses the scanner rather than allocating one regex match per ordinary run", async () => {
    await performanceCaseRun("runtime", "case-2");
  }, 65000);

  test("warm tool-output projection does not resanitize unchanged controls and sees live edits", async () => {
    await performanceCaseRun("runtime", "case-3");
  }, 65000);

  test("10000 tool-call result pairs project without per-result history searches or shifts", async () => {
    await performanceCaseRun("runtime", "case-4");
  }, 65000);

  test("bootstrap encoding preserves JSON/auth semantics and rejects cycles before spawn", async () => {
    await performanceCaseRun("runtime", "case-5");
  }, 65000);

  test("model readouts merge each endpoint only once per call and see policy edits on the next read", async () => {
    await performanceCaseRun("runtime", "case-6");
  }, 65000);

  test("cancellation during preparation stops before even an injected spawn", async () => {
    await performanceCaseRun("runtime", "case-7");
  }, 65000);

  test("bootstrap writes yield every 32 chunks even without pipe backpressure", async () => {
    await performanceCaseRun("runtime", "case-8");
  }, 65000);

  test("large bootstrap emits bounded chunks and yields before preparation completes", async () => {
    await performanceCaseRun("runtime", "case-9");
  }, 65000);
});
