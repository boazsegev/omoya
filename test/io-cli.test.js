// test/io-cli.test.js — proof for the io one-request CLI: shared
// stdin grammar, one provider request, streamed stdout events,
// diagnostics-only stderr, explicit args overriding settings.
import { describe, expect, test, afterEach } from "bun:test";
import { NAMES } from "../lib/namespace.js";
import { cli } from "./bin-names.js";

let server;
afterEach(() => server?.stop(true));

function startServer(handler, requests) {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests?.push({ url: req.url, body: await req.json().catch(() => null) });
      return handler(req);
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli({ input = "", args = [] }) {
  // Bun.spawn without `env` re-reads the ORIGINAL process environment, not
  // the preload's sandboxed one — the child would scan the user's real
  // settings dir (a cached live-server model list rejects the suite's
  // synthetic model names). Pass the suite env through explicitly.
  const proc = Bun.spawn(["bun", cli.io, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const events = stdout.trim() === "" ? [] : stdout.trim().split("\n").map((l) => JSON.parse(l));
  return { stdout, stderr, exit, events };
}

const FRAMES = [
  { message: { role: "assistant", content: "Hello " }, done: false },
  { message: { role: "assistant", content: "world" }, done: false },
  { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 11, eval_count: 6 },
];

function chatResponse(frames = FRAMES) {
  return new Response(frames.map((f) => JSON.stringify(f) + "\n").join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
}

describe("io one-request CLI", () => {
  test("streams normalized events on stdout, diagnostics on stderr, exit 0", async () => {
    const requests = [];
    const url = startServer(() => chatResponse(), requests);
    const { events, stderr, exit } = await runCli({
      input: JSON.stringify([{ type: 2, content: [{ type: "text", text: "hi" }] }]),
      args: ["--model", "ollama/qwen3:8b", "--url", url],
    });

    expect(exit).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe("qwen3:8b");
    expect(requests[0].body.stream).toBe(true);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types.at(-1)).toBe("done");
    const done = events.at(-1);
    expect(done.message.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(done.usage).toEqual({ inputTokens: 11, outputTokens: 6, source: "provider" });

    // stderr: diagnostics only — usage summary, no JSON events
    expect(stderr).toContain("usage: in=11 out=6 (provider)");
    expect(stderr.trim().split("\n").every((l) => !l.startsWith("{"))).toBe(true);
  });

  test("whole JSON context input runs exactly one provider request", async () => {
    const requests = [];
    const url = startServer(() => chatResponse(), requests);
    const input = JSON.stringify([
      { type: 1, content: [{ type: "text", text: "be terse" }] },
      { type: 2, content: [{ type: "text", text: "hello" }] },
    ]);
    const { exit } = await runCli({ input, args: ["--model", "ollama/m", "--url", url] });
    expect(exit).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  test("mixed JSON/plain lines buffer to EOF and still run one request", async () => {
    const requests = [];
    const url = startServer(() => chatResponse(), requests);
    const input = [
      JSON.stringify({ type: 1, content: [{ type: "text", text: "sys" }] }),
      "plain user line",
      "another plain line",
    ].join("\n");
    const { exit } = await runCli({ input, args: ["--model", "ollama/m", "--url", url] });
    expect(exit).toBe(0);
    expect(requests).toHaveLength(1);
    const roles = requests[0].body.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "user"]);
    expect(requests[0].body.messages[1].content).toBe("plain user line");
  });

  test("single plain-text line runs one request as a user message", async () => {
    const requests = [];
    const url = startServer(() => chatResponse(), requests);
    const { exit } = await runCli({ input: "just a question", args: ["--model", "ollama/m", "--url", url] });
    expect(exit).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.messages).toEqual([{ role: "user", content: "just a question" }]);
  });

  test("an explicit provider prefix selects among the registered providers", async () => {
    const requests = [];
    const url = startServer(() => chatResponse(), requests);
    // ollama/<model>: the prefix picks ollama out of every registered connector
    const { exit, stderr } = await runCli({ input: "hi", args: ["--model", "ollama/m", "--url", url] });
    expect(exit).toBe(0);
    expect(requests).toHaveLength(1);
    expect(stderr).not.toContain("no provider selected");
  });

  test("--token rides as an authorization header for this invocation only", async () => {
    const requests = [];
    let seenAuth;
    const url = startServer(() => chatResponse());
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenAuth = req.headers.get("authorization");
        return chatResponse();
      },
    });
    const url2 = `http://127.0.0.1:${server.port}`;
    const { exit } = await runCli({
      input: "hi",
      args: ["--model", "ollama/m", "--url", url2, "--token", "secret-1"],
    });
    expect(exit).toBe(0);
    expect(seenAuth).toBe("Bearer secret-1");
  });
});
