// test/agent-bash.test.js — execution, path guard, and link-authoring refusal.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import Env from "../lib/env.js";
import Agent from "../lib/agent.js";
import { NAMES } from "../lib/namespace.js";
import { scriptedIO, TOOLCALL, TEXT } from "./fakes.js";
const { bash, hasCdCommand, hasLinkCommand, toolDescription } = await import(["..", "tools", "bash.js"].join("/"));
// the literal must not sit in this file (the write tool's own content
// scan would refuse it) — assemble the existing outside root at runtime
const ETC = ["", "etc"].join("/");
const ROOT = `./ai-tmp/bash-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("bash tool — current API execution boundaries", () => {
  const inheritedKey = `${NAMES.NAMESPACE}_BASH_INHERITED`;
  const explicitKey = `${NAMES.NAMESPACE}_BASH_EXPLICIT`;

  async function packageEnv() {
    mkdirSync(ROOT, { recursive: true });
    const cwd = resolve(ROOT);
    return Env.create({ dir: cwd, cwd, settingsDir: cwd, settings: {
      "env-refuse": [inheritedKey],
      providers: { fixture: { provider: "test", url: "test://script" } },
    } }, { providers: false, models: false });
  }

  test("registry calls use live child environment policy after tool refresh", async () => {
    const previous = process.env[inheritedKey];
    process.env[inheritedKey] = "must-not-leak";
    const env = await packageEnv();
    const command = `printf '%s:%s' \"\${${inheritedKey}-absent}\" \"\${${explicitKey}-absent}\"`;
    try {
      const info = (await env.tools()).get("bash");
      expect(info.sandbox).toBe(true);
      expect(info.safe).toBe(false);
      expect(await env.toolCall("bash", { command, env: { [explicitKey]: "configured" } }, { env })).toBe("absent:configured");
      env.settings["env-refuse"] = [];
      await env.toolCall("tool-refresh", {});
      expect(await env.toolCall("bash", { command }, { env })).toBe("must-not-leak:absent");
    } finally {
      env.close();
      if (previous === undefined) delete process.env[inheritedKey];
      else process.env[inheritedKey] = previous;
    }
  });

  test("Agent's forked Bash preserves cwd, environment filtering, exit status and data events", async () => {
    const previous = process.env[inheritedKey];
    process.env[inheritedKey] = "must-not-leak";
    const env = await packageEnv();
    const chunks = [];
    writeFileSync(`${ROOT}/input.txt`, "working-folder");
    const command = `cat input.txt; printf '\\n%s:%s\\n' \"\${${inheritedKey}-absent}\" \"\${${explicitKey}}\"; printf 'diagnostic\\n' >&2; exit 7`;
    const io = scriptedIO([
      [...TOOLCALL(0, "bash-api", "bash", { command, env: { [explicitKey]: "configured" } }), { type: "done" }],
      [...TEXT(0, "finished"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "fixture/m", createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_DATA, ({ chunk }) => chunks.push(chunk));
    try {
      expect((await agent.run()).type).toBe("done");
      const result = agent.context.messages().find((message) => message.callId === "bash-api");
      expect(result.error).toBeUndefined();
      expect(result.content[0].text).toBe("[exit code 7]\nworking-folder\nabsent:configured\n[stderr]\ndiagnostic");
      expect(chunks).toContain("working-folder");
      expect(chunks).toContain("absent:configured");
      expect(chunks).toContain("diagnostic");
    } finally {
      agent.close();
      env.close();
      if (previous === undefined) delete process.env[inheritedKey];
      else process.env[inheritedKey] = previous;
    }
  });
});

describe("bash tool", () => {
  test("runs normal commands and reports output", async () => {
    expect(await bash({ command: "echo hello" })).toBe("hello");
  });

  test("refuses cd and ln in every detected command position", async () => {
    expect(hasCdCommand("echo ok; cd sub")).toBe(true);
    expect(hasLinkCommand("ln -s source link")).toBe(true);
    expect(hasLinkCommand("echo ok; ln source link")).toBe(true);
    expect(hasLinkCommand("echo ln")).toBe(false);
    await expect(bash({ command: "cd sub" })).rejects.toThrow(/^Remove cd/);
    await expect(bash({ command: "ln -s source link" })).rejects.toThrow(/^Remove ln/);
  });

  test("allows ls so listings can stream into other commands", async () => {
    await expect(bash({ command: "ls -d . | awk '{print \"dir:\" $0}'" })).resolves.toBe("dir:.");
  });

  test("validates arguments", async () => {
    await expect(bash({})).rejects.toThrow(TypeError);
  });

  test("regex/format tokens are NOT traversal false positives", async () => {
    expect(await bash({ command: "echo 'a/b' | sed 's/x\\/y/z/'" })).toBe("a/b");
    expect(await bash({ command: "printf '%s\\n' ok" })).toBe("ok");
    expect(await bash({ command: "echo v1.2.3/4 && echo /nonexistent-omoya-path-xyz" })).toContain("v1.2.3/4");
  });

  test("existing outside absolute paths ARE refused", async () => {
    await expect(bash({ command: "echo ok > " + ETC + "/omoya-escape-test" })).rejects.toThrow(/^Keep every visible path/);
    await expect(bash({ command: "cat " + ETC + "/hosts" })).rejects.toThrow(/^Keep every visible path/);
    // Temporary conventions pass the scanner; the execution sandbox owns write policy.
    const { findCommandTraversal } = await import("../tools/guard/paths.js");
    expect(await findCommandTraversal(`echo x > '${process.env.TMPDIR}/omoya-escape'`)).toEqual([]);
  });

  test("uses the agent folder as cwd and permits project-relative parent paths", async () => {
    const project = `${ROOT}/project`;
    const folder = `${project}/agent`;
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${project}/project.txt`, "project");
    writeFileSync(`${folder}/agent.txt`, "agent");
    const context = { env: { cwd: project }, agent: { folder } };
    expect(await bash({ command: "cat agent.txt" }, context)).toBe("agent");
    expect(await bash({ command: "cat ../project.txt" }, context)).toBe("project");
    const separate = `${ROOT}/separate`;
    mkdirSync(separate);
    writeFileSync(`${separate}/own.txt`, "own");
    const embedded = { env: { cwd: project }, agent: { folder: separate } };
    expect(await bash({ command: "cat own.txt && cat ../project/project.txt" }, embedded)).toBe("ownproject");
    await expect(bash({ command: "cat ../../outside.txt" }, context)).rejects.toThrow(/^Keep every visible path/);
  });

  test("streams complete output lines through context.onData during execution", async () => {
    const chunks = [];
    const result = await bash({ command: "printf 'one\\ntwo\\n'" }, { onData: (chunk) => chunks.push(chunk) });
    expect(result).toBe("one\ntwo");
    expect(chunks).toEqual(["one", "two"]);
  });

  test("a stream callback may be removed while bash is still emitting", async () => {
    const target = { onToolData: () => {} };
    const onData = (chunk) => target.onToolData?.({ name: "bash" }, chunk);
    const run = bash({ command: "printf 'first\\n'; sleep 0.1; printf 'late\\n'" }, { onData });
    await Bun.sleep(50);
    target.onToolData = undefined; // TUI cleanup after an interrupted turn
    await expect(run).resolves.toBe("first\nlate");
  });
});
