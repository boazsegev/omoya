/**
 * test/tool-fixtures/crash.js — TEST-ONLY tool that deliberately
 * destroys the process it runs in (exit 1). Loaded from a configured
 * loadTools({dirs}) by the tool-sandbox tests to prove a crushing tool
 * cannot take the Agent's process down when the call is forked
 * (lib/tool-sandbox.js). NEVER call it in-process.
 */

export function toolDescription() {
  return {
    crash: {
      description:
        "TEST ONLY: exits the process it runs in with code 1. Used to " +
        "validate crash-proof tool encapsulation.",
      inputSchema: { type: "object", properties: {} },
    },
  };
}

export function crash() {
  process.exit(1);
}
