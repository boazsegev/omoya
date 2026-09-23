// test/preload.js — the test-suite preload (bun test --preload):
//   1. LIVE-MODEL INDEPENDENCE gate: any fetch to a local model
//      server (ollama :11434, LM Studio :1234) throws, and every
//      ambient provider key a protocol's detectEndpoints could pick
//      up is scrubbed — the suite runs IDENTICALLY on any machine
//      and can never roundtrip a real model or spend a real key
//      (tests that exercise detection set their own fake keys and
//      stub fetch explicitly);
//   2. FULL ENVIRONMENT ISOLATION (zero access to external folders —
//      the suite survives an OS sandbox that denies everything
//      outside the project): EVERY variable under the active namespace
//      is suite-controlled. Ambient namespaced values are deleted
//      wholesale (skills/prompts roots and internal gate flags — anything,
//      present or future, can never leak in), then the variables the
//      run needs point INSIDE ./ai-tmp: the namespace settings variable
//      (the user settings layer — settings/tools/skills/prompts/sessions
//      and every DYNAMIC write: last-model.json, auth-*.json) is FORCED
//      to a throwaway folder, and HOME (the defaultSettingsDir
//      namespace home fallback, linkify's ~ expansion) plus TMPDIR
//      (any incidental temp usage) are redirected too — even a test
//      that exercises DEFAULT resolution touches nothing real. Tests
//      that exercise a variable set it explicitly per test.
//   3. ai-tmp hygiene: ./ai-tmp is temporary BY DEFINITION — when the
//      run finishes with EVERY test passing, every live artifact in
//      it is deleted (a failing run keeps its artifacts for
//      debugging). Mechanic: bun test never fires exit/beforeExit
//      handlers, but a preload-registered afterAll DOES fire once at
//      the very end — it just carries no result, so `test`/`it` and
//      the lifecycle hooks are WRAPPED to count failures as they
//      throw (the suite uses plain test/describe only). The folder
//      itself stays (tests mkdtemp into it).
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { NAMES } from "../lib/namespace.js";

const original = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  const target = String(url?.url ?? url);
  if (target.includes(":11434") || target.includes(":1234")) {
    throw new Error(`live model server fetch forbidden in tests: ${target}`);
  }
  return original(url, ...args);
};

// the ambient keys the protocol classes' detectEndpoints read
// (providers/openai.js, providers/kimi.js, providers/anthropic.js): a shell-set key must
// never configure an endpoint in a test
for (const key of [
  "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "XAI_API_KEY",
  "MOONSHOT_API_KEY", "MOONSHOT_BASE_URL", "KIMI_API_KEY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
]) {
  delete process.env[key];
}

// point 2 — resolved NOW: the cwd at preload is the project root; a
// test that chdir'd must not move the target
const TEST_TMP = resolve("./ai-tmp");
mkdirSync(TEST_TMP, { recursive: true });
const SANDBOX = mkdtempSync(join(TEST_TMP, "test-env-"));
const envPrefix = `${NAMES.NAMESPACE}_`;
for (const key of Object.keys(process.env)) {
  if (key.startsWith(envPrefix)) delete process.env[key]; // all namespaced variables are suite-controlled
}
process.env[NAMES.settingsEnv] = join(SANDBOX, "settings");
process.env.HOME = join(SANDBOX, "home");
process.env.TMPDIR = join(SANDBOX, "tmp");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.TMPDIR, { recursive: true });

// the ai-tmp sweep (point 3)
let failedTests = 0;
const countFailure = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (cause) {
    failedTests++;
    throw cause; // the failure still reports exactly as before
  }
};
const require = createRequire(import.meta.url);
const bunTest = require("bun:test");
const originalAfterAll = bunTest.afterAll;
for (const key of ["test", "it", "beforeAll", "beforeEach", "afterAll", "afterEach"]) {
  const original = bunTest[key];
  if (typeof original !== "function") continue;
  const wrapped = (...args) => {
    // wrap the LAST function argument (test's fn, a hook's fn alike)
    for (let i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === "function") { args[i] = countFailure(args[i]); break; }
    }
    return original(...args);
  };
  for (const prop of Object.keys(original)) wrapped[prop] = original[prop]; // test.each & co.
  try {
    bunTest[key] = wrapped; // ESM test-file imports see the same object
  } catch { /* a frozen module object skips the count, never the run */ }
}
originalAfterAll(() => {
  if (failedTests > 0) return; // a failing run keeps its artifacts
  try {
    for (const entry of readdirSync(TEST_TMP)) {
      rmSync(join(TEST_TMP, entry), { recursive: true, force: true });
    }
  } catch { /* a missing folder or a locked file never fails the run */ }
});
