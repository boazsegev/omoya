/**
 * test/tool-fixtures/guardfail.js — TEST-ONLY tool that throws an
 * error carrying a `system` payload (the path-traversal guard's
 * refusal shape). Used by the tool-sandbox / tool-system tests to
 * prove the payload survives the forked-worker boundary and appends
 * as System messages.
 */

export function toolDescription() {
  return {
    guardfail: {
      description: "TEST ONLY: throw an error with a system payload attached.",
      inputSchema: { type: "object", properties: {} },
    },
  };
}

export async function guardfail() {
  const err = new Error("path traversal refused: test refusal");
  err.system = "Stay in the current directory tree. Use relative path names only.";
  throw err;
}
