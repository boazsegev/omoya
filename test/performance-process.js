// A fresh Bun script per timed regression: never invoke nested `bun test`.
import { resolve } from "node:path";

const fixtures = Object.freeze({
  settings: resolve(import.meta.dir, "fixtures/settings-performance.js"),
  runtime: resolve(import.meta.dir, "fixtures/runtime-performance.js"),
  boundary: resolve(import.meta.dir, "fixtures/performance-boundary.js"),
});

/** Run a named fixture case in a fresh process. Inherits the parent's sanitized
 * environment; neither arguments nor environment are mutated. Rejects on timeout,
 * nonzero exit, malformed JSON, or a child assertion, retaining stdout/stderr.
 * The returned metrics object belongs to the caller. */
export async function performanceCaseRun(fixture, caseName, { timeout = 60000 } = {}) {
  const script = fixtures[fixture];
  if (!script || typeof caseName !== "string" || caseName.length > 160 || !caseName) throw new Error(`Unknown performance case: ${fixture}/${caseName}`);
  const child = Bun.spawn([process.execPath, script, caseName], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
  let stdout = "";
  let stderr = "";
  let exit;
  try {
    [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
  } finally {
    clearTimeout(timer);
    if (exit === undefined) { child.kill("SIGKILL"); await child.exited; }
  }
  const detail = `case ${fixture}/${caseName}; exit ${exit}; stdout: ${stdout}; stderr: ${stderr}`;
  if (timedOut) throw new Error(`Performance child timeout (${timeout}ms): ${detail}`);
  if (exit !== 0) throw new Error(`Performance child failed: ${detail}`);
  try {
    const metrics = JSON.parse(stdout);
    if (metrics?.case !== caseName || metrics?.ok !== true) throw new Error("invalid case result");
    return metrics;
  } catch (cause) {
    throw new Error(`Performance child invalid JSON: ${detail}`, { cause });
  }
}

/** Execute a fixture's exported named case without registering bun:test tests.
 * Emits exactly one JSON success record; failures retain their stack on stderr. */
export async function performanceCaseDispatch(cases) {
  const name = process.argv[2];
  try {
    if (!Object.hasOwn(cases, name)) throw new Error(`Unknown performance case: ${name}`);
    const metrics = await cases[name]();
    process.stdout.write(`${JSON.stringify({ case: name, ok: true, metrics })}\n`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
