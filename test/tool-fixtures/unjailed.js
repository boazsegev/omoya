/**
 * test/tool-fixtures/unjailed.js — TEST-ONLY control for jailed.js:
 * the SAME outside-cwd write probe WITHOUT the `sandbox: true`
 * metadata, proving the refusal comes from the kernel jail and not
 * from the filesystem. Used by the tool-sandbox tests.
 */

import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function toolDescription() {
  return {
    unjailed: {
      description: "TEST ONLY: untrusted control probes an outside-cwd write; report the outcome and runner pid.",
      inputSchema: { type: "object", properties: {} },
    },
  };
}

export async function unjailed() {
  const probe = join(process.env.HOME ?? "/tmp", ".ai-sbx-tool-probe");
  try {
    writeFileSync(probe, "x");
    rmSync(probe, { force: true });
    return `pid ${process.pid}: outside write SUCCEEDED`;
  } catch (err) {
    return `pid ${process.pid}: outside write refused (${err.code ?? err.message})`;
  }
}
