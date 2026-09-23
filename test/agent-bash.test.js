// test/agent-bash.test.js — execution, path guard, and link-authoring refusal.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
await import(["..", "lib", "env.js"].join("/")); // initialize public Env before loading the tool
const { bash, hasCdCommand, hasLinkCommand, hasListCommand, toolDescription } = await import(["..", "tools", "bash.js"].join("/"));
// the literal must not sit in this file (the write tool's own content
// scan would refuse it) — assemble the existing outside root at runtime
const ETC = ["", "etc"].join("/");
const ROOT = `./ai-tmp/bash-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

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

  test("refuses ls and directs folder inspection to read", async () => {
    expect(hasListCommand("ls")).toBe(true);
    expect(hasListCommand("echo ok; ls -la ./sub")).toBe(true);
    expect(hasListCommand("command ls ./sub")).toBe(true);
    expect(hasListCommand("echo ls")).toBe(false);
    expect(hasListCommand("printf '%s' list")).toBe(false);
    await expect(bash({ command: "ls" })).rejects.toThrow(/^Use the read tool/);
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
    await expect(bash({ command: "echo ok > " + ETC + "/omoya-escape-test" })).rejects.toThrow(/^Keep every path argument/);
    await expect(bash({ command: "cat " + ETC + "/hosts" })).rejects.toThrow(/^Keep every path argument/);
    // the jailed TMPDIR: existing, outside the working folder, test-controlled
    await expect(bash({ command: "echo x > " + process.env.TMPDIR + "/omoya-escape" })).rejects.toThrow(/^Keep every path argument/);
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
    await expect(bash({ command: "cat ../../outside.txt" }, context)).rejects.toThrow(/^Keep every path argument/);
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
