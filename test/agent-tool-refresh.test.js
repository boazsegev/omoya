// test/agent-tool-refresh.test.js — proof for cache-busted refreshTools():
// changed module code is used by the next call; added/removed tools
// rebuild the schema and callable indexes; built-ins survive; refresh
// happens between model requests via the always-registered tool-refresh.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { scriptedIO, USER, TEXT, TOOLCALL } from "./fakes.js";

const ROOT = `./ai-tmp/tool-refresh-${process.pid}`;
const DIR = join(ROOT, "tools");
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

const VERSION = (v) => `
export function toolDescription() { return { ver: { description: "version probe", inputSchema: {} } }; }
export function ver() { return "v${v}"; }
`;

function write(rel, content, mtimeSec) {
  const file = join(DIR, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, new Date(mtimeSec * 1000), new Date(mtimeSec * 1000));
  return file;
}

describe("refreshTools()", () => {
  test("changed module code is used by the next call (cache-busted re-import)", async () => {
    write("ver.js", VERSION(1), 1000);
    const env = new Env({ dir: ROOT, settings: {} });
    await env.loadTools({ dirs: [DIR] });
    expect(await env.callTool("ver", {})).toBe("v1");

    write("ver.js", VERSION(2), 2000);
    await env.refreshTools();
    expect(await env.callTool("ver", {})).toBe("v2");
  });

  test("a WRAPPER's private helpers re-import on refresh (explicit Env import)", async () => {
    // a well-designed tool: the top-level module is a thin wrapper;
    // the logic lives in a sub-folder the scan never enters. Editing
    // the HELPER (wrapper untouched) still applies on refresh — the
    // wrapper's helper import is stamped with the shared revision.
    write("helper/value.js", `export function value() { return "helper-v1"; }`, 1000);
    write("wrapped.js", `
import Env from "../../../lib/env.js";
const { value } = await import(\`./helper/value.js?now=\${Env.toolTimestamp()}\`);
export function toolDescription() { return { wrapped: { description: "w", inputSchema: {} } }; }
export function wrapped() { return value(); }
`, 1000);
    const env = new Env({ dir: ROOT, settings: {} });
    await env.loadTools({ dirs: [DIR] });
    expect(env.toolNames()).toContain("wrapped");
    expect(env.hasTool("helper-value")).toBe(false); // sub-folders are NOT scanned
    expect(await env.callTool("wrapped", {})).toBe("helper-v1");

    write("helper/value.js", `export function value() { return "helper-v2"; }`, 2000);
    await env.refreshTools();
    expect(await env.callTool("wrapped", {})).toBe("helper-v2"); // fresh helper, same wrapper
  });

  test("added and removed tools rebuild the schema and callable indexes", async () => {
    write("ver.js", VERSION(1), 1000);
    const env = new Env({ dir: ROOT, settings: {} });
    await env.loadTools({ dirs: [DIR] });
    expect(env.toolNames().sort()).toEqual(["tool-refresh", "ver"]);

    write("extra.js", VERSION(1).replaceAll("ver", "extra"), 1000);
    rmSync(join(DIR, "ver.js"));
    await env.refreshTools();
    expect(env.toolNames().sort()).toEqual(["extra", "tool-refresh"]); // removed dropped, added picked up
    expect(env.hasTool("ver")).toBe(false);
    await expect(env.callTool("ver", {})).rejects.toThrow(/unknown tool/);
    expect(env.toolSchemas().map((t) => t.name)).toEqual(["tool-refresh", "extra"]);
  });

  test("built-in tools survive rebuilds", async () => {
    write("ver.js", VERSION(1), 1000);
    const env = new Env({ dir: ROOT, settings: {} });
    await env.loadTools({ dirs: [DIR] });
    await env.refreshTools();
    expect(env.hasTool("tool-refresh")).toBe(true);
  });

  test("the model drives refresh: tool-refresh call -> next tool call uses the rebuilt registry", async () => {
    write("ver.js", VERSION(1), 1000);
    const env = new Env({ dir: ROOT, settings: { providers: { p: { provider: "test", url: "test://script" } } } });
    await env.loadTools({ dirs: [DIR] });
    expect(await env.callTool("ver", {})).toBe("v1");
    write("ver.js", VERSION(2), 2000); // module changes BEFORE the refresh call

    const io = scriptedIO([
      // turn 1: model asks to refresh (executed between requests)
      [...TOOLCALL(0, "c1", "tool-refresh", {}), { type: "done" }],
      // turn 2: model calls the (changed) tool
      [...TOOLCALL(0, "c2", "ver", {}), { type: "done" }],
      // turn 3: final answer
      [...TEXT(0, "done"), { type: "done" }],
    ]);
    const agent = new Agent({
      env, model: "p/m", context: [USER("refresh then read")],
      createIO: () => io,
    });

    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    // c1: refresh result lists tools; c2: the CHANGED code answered
    const refreshResult = agent.context.find((m) => m.callId === "c1");
    expect(JSON.parse(refreshResult.content[0].text).refreshed).toBe(true);
    const verResult = agent.context.find((m) => m.callId === "c2");
    expect(verResult.content[0].text).toBe("v2");
  });
});
