import "../child-isolation.js";
import { performanceCaseDispatch } from "../performance-process.js";
import { expect, spyOn } from "bun:test";
import { performance } from "node:perf_hooks";
import { estimateContextTokens } from "../../lib/context/usage.js";
import { sanitizeText, BashSanitizer } from "../../lib/app/markdown/text-safe.js";
import { contextBlocks } from "../../lib/app/tui/context-blocks.js";
import { MessageType, ContentType } from "../../lib/context/types.js";
import { toolBootstrapChunks, toolBootstrapObserve, toolBootstrapWrite } from "../../lib/agent/tool-bootstrap.js";
import { callToolSandboxed } from "../../lib/agent/tool-sandbox.js";
import { ProcessScope } from "../../lib/sandbox/processes.js";
import { models } from "../../lib/env/models.js";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let metrics;
function warmedMedian(call) {
  for (let i = 0; i < 3; i++) call();
  const samples = [];
  for (let i = 0; i < 7; i++) { const start = performance.now(); call(); samples.push(performance.now() - start); }
  const medianMs = median(samples);
  metrics.medians.push({ warmups: 3, sampleCount: samples.length, medianMs, maxMs: Math.max(...samples) });
  return medianMs;
}
function result(text, callId) { return { type: MessageType.ToolResult, callId, content: [{ type: ContentType.Text, text }] }; }

const cases = {
  "context estimates observe live edits while unchanged strings avoid repeated scans": () => {
    const block = { text: "one" };
    const message = { content: [block] };
    expect(estimateContextTokens([message])).toBe(2);
    block.text = "one two three";
    expect(estimateContextTokens([message])).toBe(4);
    message.content.push({ arguments: "four five six" });
    expect(estimateContextTokens([message])).toBe(8);
    const scan = spyOn(String.prototype, "charCodeAt");
    try {
      estimateContextTokens([message]);
      expect(scan).not.toHaveBeenCalled();
      block.text = "seven eight";
      expect(estimateContextTokens([message])).toBe(7);
      expect(scan).toHaveBeenCalled();
    } finally { scan.mockRestore(); }
    message.content = [{ text: "four" }];
    expect(estimateContextTokens([message])).toBe(2);
  },

  "plain 4MiB tool output is not rebuilt character by character, cold or repeated": () => {
    const text = "ordinary plain stdout words\n".repeat(150000);
    const scan = spyOn(String.prototype, "charCodeAt");
    try {
      expect(sanitizeText(text, { markdown: true })).toBe(text);
      expect(new BashSanitizer({ markdown: true }).push(text)).toBe(text);
      expect(scan).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); }
    expect(warmedMedian(() => sanitizeText(text, { markdown: true }))).toBeLessThan(10);
  },

  "dense ANSI uses the scanner rather than allocating one regex match per ordinary run": () => {
    const text = "\x1b[1mbold\x1b[0m normal\r\n".repeat(100000);
    const execute = RegExp.prototype.exec;
    let controlMatches = 0;
    const matches = spyOn(RegExp.prototype, "exec").mockImplementation(function (input) {
      if (this.source === "[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]") controlMatches++;
      return execute.call(this, input);
    });
    let sanitized;
    try {
      sanitized = sanitizeText(text, { markdown: true });
      // One guard regex, not 200000 exec/slice run-copy passes. The original
      // parser's independent SGR intermediary regex is deliberately ignored.
      expect(controlMatches).toBeLessThan(5);
    } finally { matches.mockRestore(); }
    expect(sanitized).toBe("**bold** normal\n".repeat(100000));
    const representative = text.slice(0, 64 * 1024);
    expect(warmedMedian(() => sanitizeText(representative, { markdown: true }))).toBeLessThan(10);
  },

  "warm tool-output projection does not resanitize unchanged controls and sees live edits": () => {
    const text = "\x1b[1mbold\x1b[0m plain\n".repeat(50000);
    const message = result(text);
    const initial = contextBlocks([message])[0].text;
    const scan = spyOn(String.prototype, "charCodeAt");
    try {
      for (let i = 0; i < 5; i++) expect(contextBlocks([message])[0].text).toBe(initial);
      expect(scan).not.toHaveBeenCalled();
      message.content[0].text = "changed\x07 text";
      expect(contextBlocks([message])[0].text).toBe("changed text");
      expect(scan).toHaveBeenCalled();
    } finally { scan.mockRestore(); }
  },

  "10000 tool-call result pairs project without per-result history searches or shifts": () => {
    const calls = Array.from({ length: 10000 }, (_, i) => ({ type: MessageType.Assistant, content: [{ type: ContentType.ToolCall, callId: `call-${i}`, name: "read", arguments: "{}" }] }));
    const history = [...calls, ...calls.map((call) => result("ok", call.content[0].callId))];
    const search = spyOn(Array.prototype, "lastIndexOf");
    const shift = spyOn(Array.prototype, "splice");
    let blocks;
    try { blocks = contextBlocks(history); expect(search).not.toHaveBeenCalled(); expect(shift).not.toHaveBeenCalled(); }
    finally { search.mockRestore(); shift.mockRestore(); }
    expect(blocks.length).toBe(20000);
    expect(blocks[0].type).toBe("toolcall"); expect(blocks[1].type).toBe("toolresult");
    expect(blocks[19999].group).toBe(blocks[19998].group);
    expect(warmedMedian(() => contextBlocks(history))).toBeLessThan(10);
  },

  "bootstrap encoding preserves JSON/auth semantics and rejects cycles before spawn": async () => {
    const value = { custom: { auth: "secret", keep: true }, schema: { properties: { auth: { type: "string" }, safe: {} } }, array: [undefined, NaN, { auth: 1, keep: 2 }], date: new Date("2026-10-11T00:00:00Z"), quoted: '"\\\n🙂', omitted: undefined };
    const expected = JSON.stringify(value, (key, item) => key === "auth" ? undefined : item);
    expect((await toolBootstrapChunks(value)).join("")).toBe(expected);
    expect(value.custom.auth).toBe("secret");
    const cyclic = {}; cyclic.self = cyclic;
    await expect(toolBootstrapChunks(cyclic)).rejects.toThrow("circular");
    await expect(toolBootstrapChunks({ value: 1n })).rejects.toThrow("BigInt");
    const long = "🙂".repeat(40000) + "\ud800";
    expect(JSON.parse((await toolBootstrapChunks({ long })).join("")).long).toBe(long);
    const escaped = "\u0000".repeat(40000);
    const escapedChunks = await toolBootstrapChunks({ escaped });
    expect(Math.max(...escapedChunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(32768);
    expect(JSON.parse(escapedChunks.join("")).escaped).toBe(escaped);
    const snapshot = { custom: true, auth: "secret" };
    let snapshots = 0;
    const settings = new Proxy({}, {
      get(_target, key) { if (key === "toJSON") return () => { snapshots++; return snapshot; }; throw new Error("must use owning serialization snapshot"); },
      ownKeys() { throw new Error("must not enumerate the live settings view"); },
    });
    expect(JSON.parse((await toolBootstrapChunks({ settings })).join(""))).toEqual({ settings: { custom: true } });
    expect(snapshots).toBe(1);
  },

  "model readouts merge each endpoint only once per call and see policy edits on the next read": () => {
    const count = 3000;
    let reads = 0;
    const metadata = Object.fromEntries(Array.from({ length: count }, (_, index) => [`model-${index}`, { contextWindow: 200000 }]));
    const section = { provider: "synthetic", models: metadata };
    // Full-suite imports may install Agent's global modelInfo hook before this
    // module runs. Supply its legitimate public Env surface, not hook bypasses.
    const env = { agents: () => [], settings: { maxActive: 8 }, _settingsDir: null, _dynamicEndpoints: new Set(), _settingsAccess: { read: () => undefined }, _providers: {}, _sourceGraph: { store: { read(path) { reads++; return path[0] === "providers" && path[1] === "synthetic" ? structuredClone(section) : {}; } }, configuredEndpoint: () => section }, _modelsCache: new Map(Array.from({ length: count }, (_, index) => [`synthetic/model-${index}`, { info: { endpoint: "synthetic", model: `model-${index}`, caps: {} } }])) };
    const first = models(env, true);
    expect(reads).toBe(1);
    expect(first.size).toBe(count);
    expect(first.get("synthetic/model-0").caps.contextWindow).toBe(200000);
    section.disabled = true;
    metadata["model-0"].contextWindow = 300000;
    reads = 0;
    const next = models(env, true);
    expect(reads).toBe(1);
    expect(next.get("synthetic/model-0").disabled).toBe(true);
    expect(next.get("synthetic/model-0").caps.contextWindow).toBe(300000);
    expect(first.get("synthetic/model-0").disabled).toBe(false);
    expect(warmedMedian(() => models(env, true))).toBeLessThan(10);
  },

  "cancellation during preparation stops before even an injected spawn": async () => {
    const scope = new ProcessScope();
    const env = { cwd: ".", folders: [], settings: { data: Array.from({ length: 10000 }, (_, index) => ({ index })) } };
    let spawns = 0;
    const closing = new Promise((resolve) => setImmediate(() => { void scope.close({ cancel: true }); resolve(); }));
    const verdict = await callToolSandboxed({ env, scope, name: "read", file: "tools/read.js", args: {}, spawnImpl() { spawns++; throw new Error("must not spawn"); } });
    await closing;
    expect(scope.closed).toBe(true);
    expect(spawns).toBe(0);
    expect(verdict).toMatchObject({ ok: false, error: expect.stringContaining("closed") });
  },

  "bootstrap writes yield every 32 chunks even without pipe backpressure": async () => {
    let writes = 0;
    let atHeartbeat;
    const stream = { write() { writes++; return true; }, end() {} };
    const heartbeat = new Promise((resolve) => setImmediate(() => { atHeartbeat = writes; resolve(); }));
    await toolBootstrapWrite(stream, Array(100).fill("bounded chunk"));
    await heartbeat;
    expect(atHeartbeat).toBeGreaterThan(0);
    expect(atHeartbeat).toBeLessThanOrEqual(32);
    expect(writes).toBe(100);
  },

  "large bootstrap emits bounded chunks and yields before preparation completes": async () => {
    const settings = { models: Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`model-${i}`, { contextWindow: 200000, auth: "secret", custom: true }])) };
    const slices = [];
    const stop = toolBootstrapObserve((slice) => slices.push(slice));
    let yielded = false;
    const heartbeat = new Promise((resolve) => setImmediate(() => { yielded = true; resolve(); }));
    let chunks;
    try { chunks = await toolBootstrapChunks({ settings }); } finally { stop(); }
    expect(yielded).toBe(true);
    await heartbeat;
    expect(slices.length).toBeGreaterThan(1);
    expect(Math.max(...slices.map((slice) => slice.items))).toBeLessThanOrEqual(1024);
    const sliceMedianMs = median(slices.map((slice) => slice.duration));
    metrics.bootstrap = { sliceCount: slices.length, medianMs: sliceMedianMs, maxMs: Math.max(...slices.map((slice) => slice.duration)), maxItems: Math.max(...slices.map((slice) => slice.items)), chunkCount: chunks.length, maxChunkLength: Math.max(...chunks.map((chunk) => chunk.length)) };
    expect(sliceMedianMs).toBeLessThan(5);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(32768);
    const decoded = JSON.parse(chunks.join(""));
    expect(Object.keys(decoded.settings.models)).toHaveLength(10000);
    expect(decoded.settings.models["model-0"]).toEqual({ contextWindow: 200000, custom: true });
  },
};

await performanceCaseDispatch(Object.fromEntries(Object.entries(cases).map(([name, run], index) => [`case-${index}`, async () => {
  metrics = { operation: name, medians: [], bootstrap: null };
  await run();
  return metrics;
}])));
