/**
 * test/tool-fixtures/stubborn.js — TEST-ONLY tool that IGNORES SIGINT
 * and sleeps for `ms`. Used by the cancel tests: the first cancel's
 * SIGINT leaves the worker running, so the second cancel's SIGTERM is
 * what actually brings it down (proving the force path).
 */

// the ignore must land at IMPORT time (the worker imports the tool
// module before invoking it): the whole worker process shrugs SIGINT
process.on("SIGINT", () => {});

export function toolDescription() {
  return {
    stubborn: {
      description: "TEST ONLY: ignore SIGINT, sleep for ms milliseconds, then report.",
      inputSchema: {
        type: "object",
        properties: {
          ms: { type: "integer", description: "milliseconds to sleep (default 30000)" },
        },
      },
    },
    unkillable: {
      description: "TEST ONLY: ignore SIGINT AND SIGTERM, sleep for ms, then report.",
      inputSchema: {
        type: "object",
        properties: {
          ms: { type: "integer", description: "milliseconds to sleep (default 30000)" },
        },
      },
    },
  };
}

export async function stubborn({ ms = 30_000 } = {}) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return `stubbornly slept ${ms}ms`;
}

export async function unkillable({ ms = 30_000 } = {}) {
  process.on("SIGTERM", () => {}); // armed on invocation: only SIGKILL gets through
  await new Promise((resolve) => setTimeout(resolve, ms));
  return `unkillably slept ${ms}ms`;
}
