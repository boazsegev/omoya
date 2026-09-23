// test/base-stdin.test.js — proof for lib/stdin.js (shared CLI grammar)
import { describe, expect, test } from "bun:test";
import { parseContext } from "../lib/context.js";
import { readStdin } from "../lib/cli.js";

describe("parseContext — whole-input JSON first", () => {
  test("a complete JSON context array passes through as-is", () => {
    const context = [
      { type: 1, content: [{ type: "text", text: "sys" }] },
      { type: 2, content: [{ type: "text", text: "hi" }] },
    ];
    expect(parseContext(JSON.stringify(context))).toEqual(context);
  });

  test("empty input yields an empty context", () => {
    expect(parseContext("")).toEqual([]);
    expect(parseContext("\n\n  \n")).toEqual([]);
  });
});

describe("parseContext — per-line fallback", () => {
  test("non-JSON lines become user messages", () => {
    expect(parseContext("hello\nhow are you")).toEqual([
      { type: 2, content: [{ type: "text", text: "hello" }] },
      { type: 2, content: [{ type: "text", text: "how are you" }] },
    ]);
  });

  test("mixed JSON messages/arrays and plain lines interleave in order", () => {
    const msg = { type: 1, content: [{ type: "text", text: "sys" }] };
    const pair = [
      { type: 2, content: [{ type: "text", text: "q" }] },
      { type: 3, content: [{ type: "text", text: "a" }] },
    ];
    const input = `${JSON.stringify(msg)}\nplain line\n${JSON.stringify(pair)}`;
    expect(parseContext(input)).toEqual([
      msg,
      { type: 2, content: [{ type: "text", text: "plain line" }] },
      ...pair,
    ]);
  });

  test("JSON scalars are not messages — treated as plain lines", () => {
    expect(parseContext("42")).toEqual([
      { type: 2, content: [{ type: "text", text: "42" }] },
    ]);
    expect(parseContext('"just a string"')).toEqual([
      { type: 2, content: [{ type: "text", text: '"just a string"' }] },
    ]);
  });

  test("malformed JSON objects degrade to user messages, never throw", () => {
    expect(parseContext('{"type": 2, broken')).toEqual([
      { type: 2, content: [{ type: "text", text: '{"type": 2, broken' }] },
    ]);
  });

  test("blank lines are skipped", () => {
    expect(parseContext("a\n\n   \nb")).toEqual([
      { type: 2, content: [{ type: "text", text: "a" }] },
      { type: 2, content: [{ type: "text", text: "b" }] },
    ]);
  });
});

describe("readStdin — buffers to EOF", () => {
  test("resolves only after EOF with the complete input", async () => {
    // A child that uses the real helper; parent keeps the pipe OPEN until
    // after a delay, proving the helper does not resolve before EOF.
    const child = Bun.spawn(
      ["bun", "-e", `import { readStdin } from "${import.meta.dir}/../lib/cli.js";
        process.stdout.write(await readStdin());`],
      { stdin: "pipe", stdout: "pipe" },
    );
    child.stdin.write("part one\n");
    child.stdin.flush();
    let resolved = false;
    const out = new Response(child.stdout).text().then((t) => { resolved = true; return t; });
    await Bun.sleep(150);
    expect(resolved).toBe(false); // still waiting: no EOF yet
    child.stdin.write("part two");
    await child.stdin.end(); // EOF
    expect(await out).toBe("part one\npart two");
    expect(resolved).toBe(true);
    await child.exited;
  });
});
