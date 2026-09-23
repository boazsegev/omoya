// test/bin-ai-tool.test.js — proof for the `tool` CLI wrapper: a thin CLI
// calling any registered tool directly, no Agent involved. Hermetic: the
// settings directory is pinned to a throwaway folder, so the tool catalog
// is exactly the package built-ins plus explicitly configured roots. Every
// executable name derives from bin-names.js — rename-safe.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { binName, cli } from "./bin-names.js";

mkdirSync("./ai-tmp", { recursive: true });

async function run(args, { tools, env = {} } = {}) {
  const settingsDir = mkdtempSync("./ai-tmp/ai-tool-cli-");
  if (tools) writeFileSync(`${settingsDir}/settings.json`, JSON.stringify({ tools: [tools] }));
  const proc = Bun.spawn(["bun", cli.tool, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, [NAMES.settingsEnv]: settingsDir, ...env },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exit };
}

describe("the tool CLI wrapper", () => {
  test("no args (or --list): the tool catalog, one 'name — description' line each", async () => {
    const { stdout, exit } = await run([]);
    expect(exit).toBe(0);
    expect(stdout).toContain("- read — ");
    expect(stdout).toContain("- skill — ");
    const { stdout: viaFlag } = await run(["--list"]);
    expect(viaFlag).toBe(stdout);
  });

  test("tool modules import the canonical Env façade explicitly", async () => {
    const tools = mkdtempSync("./ai-tmp/ai-tool-env-import-");
    writeFileSync(`${tools}/explicit.js`, `
import Env from "../../lib/env.js";
const loadedAt = Env.toolTimestamp();
export function explicit() { return loadedAt; }
export function toolDescription() {
  return { explicit: { description: "explicit Env import probe", inputSchema: { type: "object", properties: {} } } };
}
`);
    const { stdout, stderr, exit } = await run(["--list"], { tools });
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("- explicit — explicit Env import probe");
  });

  test("closes tool-owned resources after successful and failed calls", async () => {
    const tools = mkdtempSync("./ai-tmp/ai-tool-cleanup-");
    for (const fails of [false, true]) {
      const marker = `${tools}/closed-${fails}`;
      writeFileSync(`${tools}/cleanup.js`, `
import { writeFileSync } from "node:fs";
import Env from "../../lib/env.js";
export function cleanup() {
  Env.mcpPool.set("probe", { child: { kill: () => writeFileSync(${JSON.stringify(marker)}, "closed") } });
  if (${fails}) throw new Error("expected failure");
  return "ok";
}
export function toolDescription() {
  return { cleanup: { description: "cleanup probe", inputSchema: { type: "object", properties: {} } } };
}
`);
      const result = await run(["cleanup"], { tools });
      expect(result.exit).toBe(fails ? 2 : 0);
      expect(existsSync(marker)).toBe(true);
    }
  });

  test("--help prints usage and exits 0", async () => {
    const { stdout, exit } = await run(["--help"]);
    expect(exit).toBe(0);
    expect(stdout).toContain(`Usage: ${binName("tool")}`);
  });

  test("a JSON OBJECT passes through as-is: read '{\"path\":...}'", async () => {
    const { stdout, exit } = await run(["read", '{"path":"README.md"}']);
    expect(exit).toBe(0);
    expect(stdout).toContain("A transparent agent harness");
  });

  test("shell-style args support arrays and spaced or joined object values", async () => {
    const array = await run(["skill", "core"]);
    expect(array.exit).toBe(0);
    expect(array.stdout.trim()).not.toBe("");
    const spaced = await run(["read", "path:", "README.md"]);
    expect(spaced.exit).toBe(0);
    expect(spaced.stdout).toContain("A transparent agent harness");
    const joined = await run(["read", "path:README.md"]);
    expect(joined.exit).toBe(0);
    expect(joined.stdout).toContain("A transparent agent harness");
  });

  test("a bare JSON value shorthands into the tool's FIRST schema property — the skill example", async () => {
    const { stdout, stderr, exit } = await run(["skill", '["core"]']);
    expect(exit).toBe(0);
    expect(stdout.trim()).not.toBe("");
    expect(stderr).toContain("[system]"); // the payload is side-channeled
  });

  test("no json-args at all calls the tool with {}", async () => {
    const { stdout, exit } = await run(["skill"]); // {} -> lists the catalog
    expect(exit).toBe(0);
    expect(stdout).toContain("skill");
  });

  test("an unknown tool is a usage error (exit 1), never a crash", async () => {
    const { stderr, exit } = await run(["nope-not-a-tool"]);
    expect(exit).toBe(1);
    expect(stderr).toContain('unknown tool "nope-not-a-tool"');
  });

  test("non-JSON args are shell strings rather than a JSON usage error", async () => {
    const { stdout, exit } = await run(["skill", "not json"]);
    expect(exit).toBe(0);
    expect(stdout.trim()).not.toBe("");
  });

  test("a tool call that throws is exit 2, never a stack trace", async () => {
    const { stderr, exit } = await run(["write", '{"path":"x.txt"}']); // missing required "content"
    expect(exit).toBe(2);
    expect(stderr).toContain("write failed:");
  });
});
