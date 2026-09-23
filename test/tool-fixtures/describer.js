/**
 * test/tool-fixtures/describer.js — TEST-ONLY tool whose schema comes
 * from describe() — the FALLBACK name the tool scan accepts when
 * toolDescription is undefined (lib/env/tools.js). Used by the
 * tool-discovery tests.
 */

export function describe() {
  return {
    describer: {
      description: "TEST ONLY: described via the describe() fallback (no toolDescription export).",
      inputSchema: { type: "object", properties: {} },
    },
  };
}

export async function describer() {
  return "described via describe()";
}
