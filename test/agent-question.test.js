// test/agent-question.test.js — proof for the question tool: pi
// question-tool semantics (1-4 questions, ≤16-char headers, 2-16
// options), the INTERNAL question bridge (Agent-provided, never in
// the published schema), REFUSAL without a bridge (a headless session
// has no one to ask), safe-mode availability, and in-process (never
// forked) execution.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Env } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { question } from "../tools/question.js";
import { scriptedIO, TOOLCALL } from "./fakes.js";

const DIRS = [];
const tmpEnv = async () => {
  const dir = mkdtempSync("./ai-tmp/question-");
  DIRS.push(dir);
  const env = new Env({ dir, cwd: dir, settings: { providers: { p: { provider: "test", url: "test://script" } } } });
  await env.loadTools({ dirs: ["./tools"] });
  return env;
};
afterEach(() => { while (DIRS.length) rmSync(DIRS.pop(), { recursive: true, force: true }); });

const Q = (over = {}) => ({
  question: "Pick one?",
  header: "Choice",
  options: [{ label: "A", description: "first" }, { label: "B", description: "second" }],
  ...over,
});

describe("question tool: argument validation (pi semantics)", () => {
  test("valid questions normalize; multiSelect/preview pass through", async () => {
    const seen = [];
    const out = await question({
      questions: [Q({ multiSelect: true, options: [
        { label: "A", description: "a", preview: "prev" },
        { label: "B", description: "b" },
      ] })],
    }, { question: { ask: async (qs) => { seen.push(qs); return [{ labels: ["A", "B"] }]; } } });
    expect(seen[0][0].multiSelect).toBe(true);
    expect(seen[0][0].options[0].preview).toBe("prev");
    expect((await question({ questions: [Q({ details: "Why this matters", options: [
      { label: "A", description: "a", preview: { type: "code", content: "const x = 1;", language: "js", title: "Example" } },
      { label: "B", description: "b", preview: { type: "text", content: "Explanation" } },
    ] })] }, { question: { ask: async (items) => { seen.push(items); return [{ labels: ["A"] }]; } } }))).toContain("A: A");
    expect(seen.at(-1)[0].details).toBe("Why this matters");
    expect(seen.at(-1)[0].options[0].preview).toEqual({ type: "code", content: "const x = 1;", language: "js", title: "Example" });
    expect(out).toBe("Q: Pick one?\nA: A, B");
  });

  test("accepts all sixteen available choices", async () => {
    const options = Array.from({ length: 16 }, (_, i) => ({ label: `Option ${i + 1}`, description: "available" }));
    const out = await question({ questions: [Q({ options })] }, {
      question: { ask: async () => [{ labels: ["Option 16"] }] },
    });
    expect(out).toContain("A: Option 16");
  });

  test("bad shapes are ordinary errors (tool-result errors at the Agent)", async () => {
    await expect(question({})).rejects.toThrow(/1-4 questions/);
    await expect(question({ questions: [] })).rejects.toThrow(/1-4 questions/);
    await expect(question({ questions: [Q(), Q(), Q(), Q(), Q()] })).rejects.toThrow(/1-4 questions/);
    await expect(question({ questions: [Q({ header: "x".repeat(17) })] })).rejects.toThrow(/1-16 characters/);
    await expect(question({ questions: [Q({ options: [{ label: "A", description: "a" }] })] })).rejects.toThrow(/2-16 options/);
    await expect(question({ questions: [Q({ options: Array.from({ length: 17 }, (_, i) => ({ label: `Option ${i}`, description: "too many" })) })] })).rejects.toThrow(/2-16 options/);
    await expect(question({ questions: [Q({ options: [
      { label: "x".repeat(61), description: "a" }, { label: "B", description: "b" },
    ] })] })).rejects.toThrow(/1-60 characters/);
    await expect(question({ questions: [Q({ options: [
      { label: "A", description: "" }, { label: "B", description: "b" },
    ] })] })).rejects.toThrow(/description/);
  });
});

describe("question tool: the bridge", () => {
  test("answers normalize: labels, custom text, abandoned", async () => {
    const ask = async () => [{ labels: ["B"] }, { text: "  typed answer " }, { abandoned: true }];
    const out = await question({ questions: [Q(), Q({ question: "Two?", header: "T2" }), Q({ question: "Three?", header: "T3" })] }, { question: { ask } });
    expect(out).toBe(
      "Q 1: Pick one?\nA: B\n" +
      "Q 2: Two?\nA: typed answer\n" +
      "Q 3: Three?\nA: (the user abandoned the question — no answer)",
    );
  });

  test("WITHOUT a bridge every question is REFUSED (a headless session has no one to ask)", async () => {
    await expect(question({ questions: [Q()] })).rejects.toThrow(/^Proceed using your best judgment/);
    await expect(question({ questions: [Q()] })).rejects.toThrow(/best judgment/);
    await expect(question({ questions: [Q()] }, { question: null })).rejects.toThrow(/^Proceed using your best judgment/);
  });

  test("the bridge is harness metadata: never in the published schema", async () => {
    const env = await tmpEnv();
    const [schema] = env.toolSchemas(["question"]);
    expect(schema.name).toBe("question");
    expect(schema.safe).toBeUndefined(); // stripped
    expect("ask" in schema).toBe(false); // the bridge is never published
    expect(JSON.stringify(schema.inputSchema)).not.toContain("bridge");
    expect(schema.inputSchema.required).toEqual(["questions"]);
  });

  test("published as SAFE and SANDBOXED through typed IPC", async () => {
    const env = await tmpEnv();
    expect(env.safeToolNames()).toContain("question");
    expect(env.toolEntry("question")).toMatchObject({ safe: true, sandbox: true });
    expect(env.safe.toolNames()).toContain("question");
    // the safe view forwards the context (the bridge) to the tool
    const out = await env.safe.callTool("question", { questions: [Q()] }, { question: { ask: async () => [{ labels: ["A"] }] } });
    expect(out).toContain("A: A");
  });
});

describe("Agent: the question bridge wiring", () => {
  test("the constructor option AND setQuestion() supply the bridge to the tool", async () => {
    const env = await tmpEnv();
    const answers = [];
    const io = scriptedIO([
      [{ type: "start" }, ...TOOLCALL(0, "c1", "question", { questions: [Q()] }), { type: "done" }],
      [{ type: "start" }, { type: "text_delta", contentIndex: 0, text: "done" }, { type: "done" }],
    ]);
    const agent = new Agent({
      env, model: "p/m", context: [], createIO: () => io,
      question: { ask: async (qs) => { answers.push(qs); return [{ text: "from the constructor" }]; } },
    });
    await agent.run();
    expect(answers).toHaveLength(1);
    expect(answers[0][0].question).toBe("Pick one?");
    const result = agent.context.find((m) => m.type === 4);
    expect(result.content[0].text).toContain("from the constructor");
    // setQuestion replaces the bridge at runtime
    agent.setQuestion({ ask: async () => [{ labels: ["B"] }] });
    const direct = await env.callTool("question", { questions: [Q()] }, agent._toolContext());
    expect(direct).toContain("A: B");
  });

  test("a sandboxed question runs over the IPC bridge", async () => {
    const env = await tmpEnv();
    let bridged = 0;
    const io = scriptedIO([
      [{ type: "start" }, ...TOOLCALL(0, "c1", "question", { questions: [Q()] }), { type: "done" }],
      [{ type: "start" }, { type: "text_delta", contentIndex: 0, text: "done" }, { type: "done" }],
    ]);
    const agent = new Agent({
      env, model: "p/m", context: [], createIO: () => io,
      toolCall: { fork: true }, // the sandbox is ON — the bridge still arrives
      question: { ask: async () => { bridged++; return [{ labels: ["A"] }]; } },
    });
    await agent.run();
    expect(bridged).toBe(1); // typed fd-3/fd-4 IPC crosses the sandbox boundary
    const result = agent.context.find((m) => m.type === 4);
    expect(result.error).toBeFalsy();
    expect(result.content[0].text).toContain("A: A");
  });

  test("without a bridge the model gets a tool-result ERROR (the refusal)", async () => {
    const env = await tmpEnv();
    const io = scriptedIO([
      [{ type: "start" }, ...TOOLCALL(0, "c1", "question", { questions: [Q()] }), { type: "done" }],
      [{ type: "start" }, { type: "text_delta", contentIndex: 0, text: "done" }, { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    await agent.run();
    const result = agent.context.find((m) => m.type === 4);
    expect(result.error).toBe(true);
    expect(result.content[0].text).toBe("tool error: Proceed using your best judgment within available permissions; no user is available to answer questions right now.");
  });
});
