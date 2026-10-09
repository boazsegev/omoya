import { describe, expect, test, afterEach } from "bun:test";
import { providerClass } from "./fakes.js";
import Gemini from "../providers/gemini.js";
import { Context } from "../lib/context.js";
import { createAssembler } from "../lib/context/assemble.js";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";

const Protocol = await providerClass(Gemini, "gemini");
const user = (text) => ({ type: 2, content: [{ type: "text", text }] });
const io = (context) => ({ model: "gemini/gemini-3.8-flash", settings: { auth: { type: "api_key", token: "key" } }, tools: () => [], context });
const conn = new Protocol("https://example.test/v1beta", io());
const previousFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = previousFetch; });

describe("Gemini Interactions", () => {
  test("connects to a configurable protocol root without an SDK", () => {
    expect(Protocol.knownEndpoints.map((item) => item.name)).toContain("gemini");
    expect(Protocol.knownEndpoints[0].label).toBe("Google Gemini API");
    expect(conn.url).toBe("https://example.test/v1beta/interactions?alt=sse");
    expect(typeof conn.read).toBe("function");
    expect(typeof conn.send).toBe("function");
  });
  test("offers a separate OAuth preset only with an owned client and Cloud project", () => {
    const keys = ["GOOGLE_GEMINI_OAUTH_CLIENT_ID", "GOOGLE_GEMINI_OAUTH_CLIENT_SECRET", "GOOGLE_CLOUD_PROJECT"];
    const saved = keys.map((key) => process.env[key]);
    try {
      for (const key of keys) delete process.env[key];
      expect(Protocol.knownEndpoints.map((entry) => entry.name)).toEqual(["gemini"]);
      process.env.GOOGLE_GEMINI_OAUTH_CLIENT_ID = "owned-client";
      process.env.GOOGLE_GEMINI_OAUTH_CLIENT_SECRET = "owned-secret";
      expect(Protocol.knownEndpoints.map((entry) => entry.name)).toEqual(["gemini"]);
      process.env.GOOGLE_CLOUD_PROJECT = "own-project";
      const preset = Protocol.knownEndpoints[1];
      expect(preset.name).toBe("gemini-oauth");
      expect(preset.oauth).toMatchObject({ clientId: "owned-client", clientSecret: "owned-secret", projectId: "own-project" });
      expect(preset.note).toContain("billing");
    } finally { keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); }
  });
  test("sends a new user turn and system instruction", () => {
    const [h, body] = conn.context2msg([{ type: 1, content: [{ type: "text", text: "Be brief" }] }, user("hi")], io());
    expect(h["x-goog-api-key"]).toBe("key");
    expect(body).toMatchObject({ model: "gemini-3.8-flash", stream: true, system_instruction: "Be brief", input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }] });
  });
  test("requests thought summaries independently of the thinking-level preference", () => {
    const standard = conn.context2msg([user("hi")], io())[1];
    expect(standard.generation_config).toEqual({ thinking_summaries: "auto" });
    const level = conn.context2msg([user("hi")], { ...io(), settings: { ...io().settings, think: "low" } })[1];
    expect(level.generation_config).toEqual({ thinking_level: "low", thinking_summaries: "auto" });
  });
  test("streams summary from thought step.start and preserves signed original step for replay", () => {
    const state = {};
    const original = { type: "thought", summary: [{ type: "text", text: "First " }, { type: "image", data: "image-data" }, { type: "text", text: "second" }], signature: "" };
    const frames = [
      { event_type: "step.start", index: 0, step: original },
      { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "signed" } },
      { event_type: "step.stop", index: 0 },
      { event_type: "interaction.completed", interaction: { id: "id", status: "completed" } },
    ];
    const events = frames.flatMap((frame) => conn.msg2events(frame, state));
    expect(events.slice(0, -1)).toEqual([
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, text: "First second" },
      { type: "thinking_end", contentIndex: 0 },
    ]);
    const message = events.at(-1).message;
    expect(message.content).toEqual([{ type: "thinking", text: "First second", gemini: { step: message.gemini.steps[0] } }]);
    expect(message.gemini.steps[0]).toEqual({ ...original, signature: "signed" });
    expect(original.signature).toBe("");
    expect(conn.context2msg([user("hi"), message], io())[1].input[1]).toEqual(message.gemini.steps[0]);
  });
  test("appends incremental thought summaries once without modifying original start parts", () => {
    const state = {};
    const summary = [{ type: "text", text: "Start" }];
    const frames = [
      { event_type: "step.start", index: 1, step: { type: "thought", summary } },
      { event_type: "step.delta", index: 1, delta: { type: "thought_summary", content: { type: "text", text: " plus" } } },
      { event_type: "step.delta", index: 1, delta: { type: "thought_summary", content: { type: "text", text: " more" } } },
      { event_type: "step.stop", index: 1 },
      { event_type: "interaction.completed", interaction: { id: "id", status: "completed" } },
    ];
    const events = frames.flatMap((frame) => conn.msg2events(frame, state));
    expect(events.map((event) => event.type)).toEqual(["thinking_start", "thinking_delta", "thinking_delta", "thinking_delta", "thinking_end", "done"]);
    expect(events.filter((event) => event.type === "thinking_delta").map((event) => event.text).join("")).toBe("Start plus more");
    expect(events.at(-1).message.content[0].text).toBe("Start plus more");
    expect(events.at(-1).message.gemini.steps[0].summary).toEqual([{ type: "text", text: "Start" }, { type: "text", text: " plus" }, { type: "text", text: " more" }]);
    expect(summary).toEqual([{ type: "text", text: "Start" }]);
  });
  test("signature-only thought remains in replay metadata without an empty visible block", () => {
    const state = {};
    const frames = [
      { event_type: "step.start", index: 0, step: { type: "thought", summary: [] } },
      { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "signed" } },
      { event_type: "step.stop", index: 0 },
      { event_type: "interaction.completed", interaction: { id: "id", status: "completed" } },
    ];
    const events = frames.flatMap((frame) => conn.msg2events(frame, state));
    expect(events.map((event) => event.type)).toEqual(["done"]);
    expect(events[0].message.content).toEqual([]);
    expect(events[0].message.gemini.steps).toEqual([{ type: "thought", summary: [], signature: "signed" }]);
    expect(conn.context2msg([user("hi"), events[0].message], io())[1].input[1]).toEqual(events[0].message.gemini.steps[0]);
  });
  test("thought delta-only summaries follow the IO thinking start/delta/end contract", () => {
    const state = {};
    const frames = [
      { event_type: "step.start", index: 0, step: { type: "thought" } },
      { event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: "Reason" } } },
      { event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: "ing" } } },
      { event_type: "step.stop", index: 0 },
      { event_type: "interaction.completed", interaction: { id: "id", status: "completed" } },
    ];
    const events = frames.flatMap((frame) => conn.msg2events(frame, state));
    expect(events.slice(0, -1)).toEqual([
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, text: "Reason" },
      { type: "thinking_delta", contentIndex: 0, text: "ing" },
      { type: "thinking_end", contentIndex: 0 },
    ]);
    expect(events.at(-1).message.content[0].text).toBe("Reasoning");
    const assembler = createAssembler();
    for (const event of events) assembler.consume(event);
    expect(assembler.message().content[0].text).toBe("Reasoning");
  });
  test("streams answer text present in step.start before completion without repeating later deltas", () => {
    const state = {};
    const frames = [
      { event_type: "step.start", index: 0, step: { type: "model_output", content: [{ type: "text", text: "Hello" }] } },
      { event_type: "step.delta", index: 0, delta: { type: "text", text: " world" } },
      { event_type: "step.stop", index: 0 },
      { event_type: "interaction.completed", interaction: { id: "i", status: "completed" } },
    ];
    const events = frames.flatMap((frame) => conn.msg2events(frame, state));
    expect(events.slice(0, -1)).toEqual([
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, text: "Hello" },
      { type: "text_delta", contentIndex: 0, text: " world" },
      { type: "text_end", contentIndex: 0 },
    ]);
    expect(events.at(-1).message.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(frames[0].step.content[0].text).toBe("Hello");
    const assembled = createAssembler();
    for (const event of events) assembled.consume(event);
    expect(assembled.message().content).toEqual([{ type: "text", text: "Hello world" }]);
  });
  test("classifies a streamed gateway timeout for the ordinary IO retry policy", () => {
    const event = conn.msg2events({ event_type: "error", error: { code: "gateway_timeout", message: "Deadline expired before operation could complete." } }, {})[0];
    expect(event).toMatchObject({ type: "error", kind: "network", error: "Deadline expired before operation could complete." });
  });
  test("IO delivers start-time text and retryable Gemini SSE timeout through callbacks", async () => {
    const environment = await Env.open("./ai-tmp", { settingsDir: null, providers: { gemini: Gemini }, settings: { providers: { gemini: { provider: "gemini", url: "https://example.test/v1beta", auth: { type: "api_key", token: "key" }, models: { "gemini-3.8-flash": { label: "Gemini" } } } } }, init: { providers: false, tools: false, detect: false, models: false } });
    const aiio = new IO({ env: environment, model: "gemini/gemini-3.8-flash" });
    globalThis.fetch = async () => new Response([
      'data: {"event_type":"step.start","index":0,"step":{"type":"model_output","content":[{"type":"text","text":"Hello"}]}}',
      'data: {"event_type":"error","error":{"code":"gateway_timeout","message":"Deadline expired before operation could complete."}}',
      "",
    ].join("\n"));
    const seen = [];
    try {
      const result = await aiio.write(new Context({ messages: [user("hi")] }), { onTextDelta: (event) => seen.push(event.text) });
      expect(seen).toEqual(["Hello"]);
      expect(result).toMatchObject({ type: "error", kind: "network", message: { content: [{ type: "text", text: "Hello" }] } });
    } finally { await aiio.close(); await environment.close(); }
  });
  test("Google OAuth uses bearer and its own quota project, never the API-key header", () => {
    const oauth = { type: "oauth", token: "access" };
    const aiio = { ...io(), settings: { auth: oauth, oauth: { projectId: "project-1", clientId: "own-client" } } };
    const [headers] = conn.context2msg([user("hello")], aiio);
    expect(headers.authorization).toBe("Bearer access");
    expect(headers["x-goog-user-project"]).toBe("project-1");
    expect(headers["x-goog-api-key"]).toBeUndefined();
    expect(() => conn.context2msg([user("hello")], { ...io(), settings: { auth: oauth } })).toThrow(/Cloud project/);
  });
  test("round trips signed thought, streamed text, tool and interaction ID", () => {
    const state = {};
    const frames = [
      { event_type: "step.start", index: 0, step: { type: "thought" } },
      { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "signed" } },
      { event_type: "step.stop", index: 0 },
      { event_type: "step.start", index: 1, step: { type: "model_output" } },
      { event_type: "step.delta", index: 1, delta: { type: "text", text: "look " } },
      { event_type: "step.delta", index: 1, delta: { type: "text", text: "up" } },
      { event_type: "step.stop", index: 1 },
      { event_type: "step.start", index: 2, step: { type: "function_call", id: "c1", name: "lookup", arguments: {} } },
      { event_type: "step.delta", index: 2, delta: { type: "arguments_delta", arguments: '{"q":"Paris"}' } },
      { event_type: "step.stop", index: 2 },
      { event_type: "interaction.completed", interaction: { id: "i1", status: "requires_action", usage: { total_input_tokens: 10, total_output_tokens: 3 } } },
    ];
    const events = frames.flatMap((frame) => conn.msg2events(frame, state));
    expect(events.map((e) => e.type)).toContain("text_delta");
    const done = events.at(-1);
    expect(done.message.gemini).toMatchObject({ interactionId: "i1", steps: [{ type: "thought", signature: "signed" }, { type: "model_output", content: [{ type: "text", text: "look up" }] }, { type: "function_call", id: "c1", arguments: { q: "Paris" } }] });
    expect(done.message.content[0].type).toBe("text");
    expect(done.message.content[1].callId).toBe("c1");
    expect(events.find((event) => event.type === "text_start").contentIndex).toBe(0);
    expect(events.find((event) => event.type === "tool_call_start").contentIndex).toBe(1);
    const next = conn.context2msg([user("hi"), done.message, { type: 4, name: "lookup", callId: "c1", content: [{ type: "text", text: "sunny" }] }], io());
    expect(next[1].previous_interaction_id).toBe("i1");
    expect(next[1].input).toEqual([{ type: "function_result", call_id: "c1", name: "lookup", result: [{ type: "text", text: "sunny" }] }]);
  });
  test("dirty Context clears Gemini metadata and replays full history", () => {
    const history = new Context({ messages: [user("hi"), { type: 3, content: [{ type: "text", text: "hello" }], gemini: { interactionId: "id", steps: [{ type: "model_output", content: [{ type: "text", text: "hello" }] }] } }, user("again")] });
    history.update((messages) => { messages[0].content[0].text = "changed"; return true; });
    const [h, body] = conn.context2msg(history.messages(), io(history));
    expect(body.previous_interaction_id).toBeUndefined();
    expect(body.input.map((step) => step.type)).toEqual(["user_input", "model_output", "user_input"]);
    expect(history.at(1).gemini).toBeUndefined();
  });
  test("reads SSE over the ordinary fetch transport", async () => {
    globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://example.test/v1beta/interactions?alt=sse");
      expect(JSON.parse(init.body).input[0].type).toBe("user_input");
      return new Response('event: step.start\ndata: {"event_type":"step.start","index":0,"step":{"type":"model_output"}}\n\nevent: step.delta\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"hi"}}\n\nevent: step.stop\ndata: {"event_type":"step.stop","index":0}\n\nevent: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"id":"i","status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } });
    };
    const connection = new Protocol("https://example.test/v1beta", io());
    await connection.send(connection.context2msg([user("hi")], io()));
    const state = {};
    const frames = [];
    for (let frame; (frame = await connection.read()) !== null;) frames.push(...connection.msg2events(frame, state));
    expect(frames.at(-1).message.content).toEqual([{ type: "text", text: "hi" }]);
    await connection.close();
  });
  test("refuses streams that end without completion", async () => {
    globalThis.fetch = async () => new Response('data: {"event_type":"interaction.created"}\n\n');
    const connection = new Protocol("https://example.test/v1beta", io());
    expect(connection.requireTerminal).toBe(true);
    await connection.send(connection.context2msg([user("hi")], io()));
    expect((await connection.read()).event_type).toBe("interaction.created");
    expect(await connection.read()).toBeNull();
    await connection.close();
  });
  test("IO preserves native Gemini steps and rejects truncated streams", async () => {
    const environment = await Env.open("./ai-tmp", { settingsDir: null, providers: { gemini: Gemini }, settings: { providers: { gemini: { provider: "gemini", url: "https://example.test/v1beta", auth: { type: "api_key", token: "key" }, models: { "gemini-3.8-flash": { label: "Gemini" } } } } }, init: { providers: false, tools: false, detect: false, models: false } });
    const conversation = new Context({ messages: [user("hi")] });
    const aiio = new IO({ env: environment, model: "gemini/gemini-3.8-flash" });
    globalThis.fetch = async () => new Response('data: {"event_type":"step.start","index":0,"step":{"type":"model_output"}}\n\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"hello"}}\n\ndata: {"event_type":"step.stop","index":0}\n\ndata: {"event_type":"interaction.completed","interaction":{"id":"i2","status":"completed"}}\n\n');
    try {
      const result = await aiio.write(conversation);
      expect(result.type).toBe("done");
      expect(result.message.gemini.interactionId).toBe("i2");
      globalThis.fetch = async () => new Response('data: {"event_type":"step.start","index":0,"step":{"type":"model_output"}}\n\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"partial"}}\n\n');
      const truncated = await aiio.write(new Context({ messages: [user("new")] }));
      expect(truncated.type).toBe("error");
      expect(truncated.error).toContain("without completion");
    } finally { await aiio.close(); await environment.close(); }
  });
  test("lists and filters paged models with API credentials", async () => {
    const urls = [];
    globalThis.fetch = async (url, init) => {
      urls.push(url);
      expect(init.headers["x-goog-api-key"]).toBe("key");
      return Response.json(urls.length === 1 ? { models: [{ name: "models/gemini-test", displayName: "Gemini Test", inputTokenLimit: 100, supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next" } : { models: [] });
    };
    expect(await Protocol.models({ url: "https://example.test/v1beta", auth: { type: "api_key", token: "key" } })).toEqual({ "gemini-test": { label: "Gemini Test", contextWindow: 100, maxTokens: undefined } });
    expect(urls[1]).toContain("pageToken=next");
  });
});
