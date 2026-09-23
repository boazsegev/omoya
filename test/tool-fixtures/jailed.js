/**
 * test/tool-fixtures/jailed.js — TEST-ONLY tool marked `sandbox: true`
 * (harness metadata: the Agent runs its forked worker under the OS
 * write sandbox). It probes a write OUTSIDE the working folder (the
 * $HOME probe of the bash sandbox tests) and reports the outcome and
 * the runner pid — the pid proves the fork, the outcome proves the
 * kernel jail. Used by the tool-sandbox tests.
 */

import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function toolDescription() {
  return {
    jailed: {
      sandbox: true, // harness metadata, never published: run under the OS write sandbox
      description: "TEST ONLY: probe an outside-cwd write; report the outcome and the runner pid.",
      inputSchema: { type: "object", properties: {} },
    },
  };
}

export async function jailed() {
  const probe = join(process.env.HOME ?? "/tmp", ".ai-sbx-tool-probe");
  try {
    writeFileSync(probe, "x");
    rmSync(probe, { force: true });
    return `pid ${process.pid}: outside write SUCCEEDED`;
  } catch (err) {
    return `pid ${process.pid}: outside write refused (${err.code ?? err.message})`;
  }
}
