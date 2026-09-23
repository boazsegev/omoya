// test/io-cli-exit.test.js — proof for the io CLI's exit codes and --help:
// 0 success; nonzero failure classes (auth, network, provider,
// malformed input); cancelled; usage errors.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NAMES } from "../lib/namespace.js";
import { binName, cli } from "./bin-names.js";

let server;
let pending = []; // never-resolving handlers park here; afterEach releases them
afterEach(() => {
  for (const resolve of pending.splice(0)) resolve(OK());
  server?.stop(true);
});

// The spawned CLIs get ONE ATTEMPT (maxAttempts: 1 — the retry
// policy's waits would stretch every failure-class assertion past its
// timeout; the retries have their own proof in agent-retry.test.js)
mkdirSync("./ai-tmp/io-cli-exit", { recursive: true });

function startServer(handler) {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli({ input = "", args = [], signal } = {}) {
  // ABSOLUTE + FRESH per spawn: a relative path would miss the child's own
  // cwd, and a shared dir would let one CLI's startup refreshModels() cache a
  // LIVE local server's model list (a dev machine's ollama) that the next
  // CLI's synthetic "ollama/m" then fails validation against.
  const settingsDir = mkdtempSync(resolve("./ai-tmp/io-cli-exit/settings-") + "");
  writeFileSync(`${settingsDir}/settings.json`, JSON.stringify({ maxAttempts: 1 }));
  const proc = Bun.spawn(["bun", cli.io, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [NAMES.settingsEnv]: settingsDir },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  if (signal) {
    setTimeout(() => proc.kill(signal), 150);
  }
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exit };
}

const OK = () =>
  new Response(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");

describe("io CLI exit codes", () => {
  test("0 on success", async () => {
    const url = startServer(OK);
    const { exit } = await runCli({ input: "hi", args: ["--model", "ollama/m", "--url", url] });
    expect(exit).toBe(0);
  });

  test("2 on auth failure (401)", async () => {
    const url = startServer(() => new Response("unauthorized", { status: 401 }));
    const { exit, stderr } = await runCli({ input: "hi", args: ["--model", "ollama/m", "--url", url] });
    expect(exit).toBe(2);
    expect(stderr).toContain("401");
  });

  test("3 on network failure (connection refused)", async () => {
    const { exit } = await runCli({ input: "hi", args: ["--model", "ollama/m", "--url", "http://127.0.0.1:1"] });
    expect(exit).toBe(3);
  });

  test("4 on provider error (404 model missing)", async () => {
    const url = startServer(
      () => new Response(JSON.stringify({ error: "model 'm' not found" }), { status: 404 }),
    );
    const { exit } = await runCli({ input: "hi", args: ["--model", "ollama/m", "--url", url] });
    expect(exit).toBe(4);
  });

  test("5 on malformed provider data", async () => {
    const url = startServer(() => new Response("{garbage\n"));
    const { exit } = await runCli({ input: "hi", args: ["--model", "ollama/m", "--url", url] });
    expect(exit).toBe(5);
  });

  test("130 on SIGINT cancellation of an in-flight request", async () => {
    const url = startServer(() => new Promise((resolve) => pending.push(resolve))); // responds only in afterEach
    const { exit, stderr } = await runCli({
      input: "hi",
      args: ["--model", "ollama/m", "--url", url, "--timeout", "10000"],
      signal: "SIGINT",
    });
    expect(exit).toBe(130);
    expect(stderr).toContain("SIGINT");
  }, 15000); // generous: SIGINT timer + process spawn stretch under parallel load

  test("1 on usage errors (unknown flag, missing value, bad timeout)", async () => {
    for (const args of [["--nope"], ["--model"], ["--timeout", "abc"]]) {
      const { exit, stderr } = await runCli({ args });
      expect(exit).toBe(1);
      expect(stderr).toContain("--help");
    }
  });

  test("1 when no endpoint/model is selected", async () => {
    const url = startServer(OK);
    const { exit, stderr } = await runCli({ input: "hi", args: ["--url", url] });
    expect(exit).toBe(1);
    expect(stderr).toContain("Please load a model");
  });
});

describe("io CLI --help", () => {
  test("prints the harness contract and exits 0", async () => {
    const { stdout, exit } = await runCli({ args: ["--help"] });
    expect(exit).toBe(0);
    for (const expected of ["usage:", "stdin:", "stdout:", "stderr:", "--model <endpoint>/<model>", "exit codes:"]) {
      expect(stdout).toContain(expected);
    }
  });

  test("the usage names the invoked wrapper (dynamic argv[1] basename)", async () => {
    const { stdout, exit } = await runCli({ args: ["--help"] });
    expect(exit).toBe(0);
    expect(stdout).toContain(`usage: ${binName("io")}`);
    expect(stdout.startsWith(`${binName("io")} — `)).toBe(true);
  });
});
