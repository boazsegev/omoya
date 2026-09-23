/**
 * test/tool-fixtures/slow.js — TEST-ONLY tool that sleeps for `ms`
 * and then returns. Used by the tool-sandbox tests (timeout kills a
 * stuck call; toolCall.async runs calls concurrently).
 */

export function toolDescription() {
  return {
    slow: {
      description: "TEST ONLY: sleep for ms milliseconds, then report.",
      inputSchema: {
        type: "object",
        properties: {
          ms: { type: "integer", description: "milliseconds to sleep (default 1000)" },
        },
      },
    },
  };
}

export async function slow({ ms = 1000 } = {}) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return `slept ${ms}ms`;
}
