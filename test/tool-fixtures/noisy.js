import { NAMES } from "../../lib/namespace.js";
/**
 * test/tool-fixtures/noisy.js — TEST-ONLY tool that dumps MEGABYTES
 * onto stdout WHILE RUNNING — exactly what a chatty tool does inside
 * the forked worker (import-time printing is separately suppressed
 * by the tool scan — see agent-tool-discovery.test.js; the import
 * block below, gated on the namespace worker marker, proves suppression
 * also holds inside the worker). The worker's result line must still
 * reach the parent COMPLETE and on its OWN last line
 * (lib/tool-worker.js: \n-prefixed, flushed before exit — the race
 * reported as "worker exited without a result (code 0)").
 */

if (process.env[NAMES.toolWorkerEnv] === "1") {
  process.stdout.write("import noise, suppressed by the worker's own tool scan\n");
}

export function toolDescription() {
  return {
    noisy: {
      description: "TEST ONLY: dumps megabytes of stdout noise while running, then returns.",
      inputSchema: { type: "object", properties: {} },
    },
  };
}

export function noisy() {
  // ~2.2MB of call-time noise, deliberately WITHOUT a trailing
  // newline (a script's output often ends mid-line)
  process.stdout.write("call-noise-".repeat(200_000));
  return "noisy done";
}
