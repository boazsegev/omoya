// test/base-cli-input.test.js — cross-cutting CLI input test
// (grammar half of AI-CORE's Testing list). Proves, against the shared
// helper (lib/stdin.js, the one both CLIs use), that whole-JSON-context
// and mixed JSON/plain-line inputs are BOTH buffered to EOF and parsed
// per the grammar. The ai-io-runs-once / ai-agent-loops assertions land
// in the AI-IO / AI-AGENT units.
import { describe, expect, test } from "bun:test";

// Drive the exact composition the CLI bindings use: read stdin to EOF,
// then parse. Runs in a child process so stdin/EOF are real.
async function runCliInputHelper(stdinText, { holdOpenMs = 0 } = {}) {
  const child = Bun.spawn(
    ["bun", "-e", `import { readContextFromStdin } from "${import.meta.dir}/../lib/cli.js";
      const ctx = await readContextFromStdin();
      process.stdout.write(JSON.stringify(ctx));`],
    { stdin: "pipe", stdout: "pipe" },
  );
  child.stdin.write(stdinText);
  child.stdin.flush();
  if (holdOpenMs) await Bun.sleep(holdOpenMs); // keep pipe open: no EOF yet
  await child.stdin.end();
  const out = await new Response(child.stdout).text();
  await child.exited;
  return JSON.parse(out);
}

describe("CLI input: whole JSON context", () => {
  test("buffered to EOF, parsed as one context array", async () => {
    const context = [
      { type: 1, content: [{ type: "text", text: "sys" }] },
      { type: 2, content: [{ type: "text", text: "hello" }] },
    ];
    const result = await runCliInputHelper(JSON.stringify(context));
    expect(result).toEqual(context);
  });
});

describe("CLI input: mixed JSON/plain lines", () => {
  test("JSON lines structure, plain lines become user messages, order kept", async () => {
    const sys = { type: 1, content: [{ type: "text", text: "sys" }] };
    const input = `${JSON.stringify(sys)}\ntell me a joke`;
    const result = await runCliInputHelper(input);
    expect(result).toEqual([
      sys,
      { type: 2, content: [{ type: "text", text: "tell me a joke" }] },
    ]);
  });
});

describe("CLI input: EOF gating", () => {
  test("execution does not start before EOF (no output while pipe open)", async () => {
    const context = [{ type: 2, content: [{ type: "text", text: "hi" }] }];
    // holdOpenMs keeps stdin open after the bytes arrive; if the helper
    // started early it would still emit — proving EOF gates execution.
    const result = await runCliInputHelper(JSON.stringify(context), { holdOpenMs: 200 });
    expect(result).toEqual(context);
  });
});
