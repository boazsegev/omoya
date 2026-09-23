// test/agent-library.test.js — proof for the library binding: drive
// the engine via normalized response callbacks + tool-loop callbacks
// only (no stdio), parity with the CLI binding, injectable session
// persistence defaulting to the file store, zero-dependency constraint.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, afterEach } from "bun:test";
import { rmSync, readFileSync, readdirSync } from "node:fs";

const transpiler = new Bun.Transpiler({ loader: "js" });
import API from "../lib/index.js";

const Env = API.Env;
const Agent = API.Agent;
const { SessionStore } = Agent;
const Context = API.Context;
const { MessageType, userMessage } = Context;
import { readFileSync as readFs } from "node:fs";
import { cli as cliPath } from "./bin-names.js";

let server;
afterEach(() => server?.stop(true));

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// spawned children get a THROWAWAY user settings folder (see agent-cancel)
mkdirSync("./ai-tmp", { recursive: true });
const SPAWN_SETTINGS = mkdtempSync("./ai-tmp/agent-lib-settings-");

const ROOT = `./ai-tmp/agent-lib-${process.pid}`;

const frames = (...list) =>
  new Response(list.map((f) => JSON.stringify(f) + "\n").join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });

function toolLoopServer(finalText = "library finished") {
  const requests = [];
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests.push(await req.json());
      return requests.length === 1
        ? frames(
            { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "file-read", arguments: { path: "./AI-TODO.md" } } }] }, done: false },
            { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 5, eval_count: 2 },
          )
        : frames({ message: { role: "assistant", content: finalText }, done: true, prompt_eval_count: 9, eval_count: 4 });
    },
  });
  return { requests, url: `http://127.0.0.1:${server.port}` };
}

async function libraryRun({ url, callbacks = {}, session } = {}) {
  // dir AND cwd isolated from the real repo root: resolveSystemPrompt()'s
  // package-fallback AND project-local AGENTS.md layers must not seed
  // an extra system message into these exact-context-sequence assertions.
  const env = new Env({ dir: ROOT, cwd: ROOT });
  await env.loadProviders({ dirs: ["./providers"], detect: false });
  env.endpoints.ollama = { provider: "ollama", url };
  await env.loadTools({ dirs: ["./tools"] }); // explicit root keeps the proof self-contained
  const agent = new Agent({
    env, model: "ollama/m", url,
    context: [userMessage("read it")],
    ...session,
  });
  const events = [];
  const eventMap = {
    onStart: [Agent.EVENT.START, "start"], onTextDelta: [Agent.EVENT.TEXT_DELTA, "text_delta"],
    onToolcallStart: [Agent.EVENT.TOOLCALL_START, "toolcall_start"], onDone: [Agent.EVENT.DONE, "done"],
    onError: [Agent.EVENT.ERROR, "error"],
  };
  for (const [name, [event, type]] of Object.entries(eventMap)) {
    agent.onEvent(event, callbacks[name] ?? ((value) => events.push({ type, ...value })));
  }
  const terminal = await agent.run();
  return { agent, terminal, events };
}

describe("library namespaces", () => {
  test("publishes each module namespace directly without environment globals", async () => {
    expect(API.name).toBeUndefined();
    expect(API.Agent.name).toBe("Agent");
    expect(API.Env.name).toBe("Env");
    expect(API.IO.name).toBe("IO");
    expect(API.Context.name).toBe("Context");
    expect(API.Env.Env).toBeUndefined();
    expect(API.Env[`${NAMES.Namespace}Env`]).toBeUndefined();
    expect(globalThis[`${NAMES.Namespace}Env`]).toBeUndefined();
    expect(globalThis.Env).toBeUndefined();
    expect(API.IO.IO).toBeUndefined();
    expect(typeof API.Env.parseDuration).toBe("function");
    expect(typeof API.Context.userMessage).toBe("function");
    expect(API.CLI).toBeUndefined();
    expect(API.Markdown).toBeUndefined();
    expect(typeof API.Jobs.dispatchJobs).toBe("function");
    const core = Bun.spawnSync([process.execPath, "-e", 'import AI from "./lib/index.js"; process.stdout.write(String(AI.TUI))'], { cwd: process.cwd() });
    expect(core.exitCode).toBe(0);
    expect(core.stdout.toString()).toBe("undefined");
    // ONE export — the default; importing names it (or `import * as`).
    const CoreModule = await import("../lib/index.js");
    expect(CoreModule.default).toBe(API);
    expect(Object.keys(CoreModule)).toEqual(["default"]);
    expect(CoreModule.default.NAMES).toBe(NAMES);
    expect(CoreModule.default.Agent).toBe(Agent);
    const FullModule = await import("../lib/index_app.js");
    const { default: FullAPI } = FullModule;
    expect(Object.keys(FullModule)).toEqual(["default"]);
    // A FRESH application object over the same core façades — Agent remains
    // core-only no matter which entry point loads first.
    expect(FullAPI).not.toBe(API);
    expect(FullAPI.Env).toBe(API.Env);
    expect(FullAPI.Agent).toBe(API.Agent);
    expect(FullAPI.NAMES).toBe(NAMES);
    expect(API.TUI).toBeUndefined();
    expect(typeof FullAPI.CLI.parseFlags).toBe("function");
    expect(typeof FullAPI.Markdown.renderMarkdown).toBe("function");
    expect(FullAPI.Jobs).toBe(API.Jobs);
    expect(typeof FullAPI.TUI.createRepl).toBe("function");
    // GTUI rides on the TUI namespace and as a top-level shortcut — one object.
    expect(FullAPI.TUI.GTUI).toBeDefined();
    expect(FullAPI.GTUI).toBe(FullAPI.TUI.GTUI);
    expect(typeof FullAPI.GTUI.host.memory).toBe("function");
    expect(FullAPI.GTUI.view).toBeDefined();
  });
});

describe("Agent.setFolder: agent-local tool root", () => {
  test("accepts only existing folders inside env.cwd and leaves the shared environment unchanged", () => {
    const root = mkdtempSync("./ai-tmp/agent-folder-");
    const child = `${root}/project`;
    mkdirSync(child);
    writeFileSync(`${root}/plain-file`, "not a folder");
    const env = new Env({ dir: ROOT, cwd: root, settings: {} });
    const agent = new Agent({ env });
    expect(agent.setFolder("project")).toBe(resolve(child));
    expect(agent.folder).toBe(resolve(child));
    expect(env.cwd).toBe(root);
    expect(() => agent.setFolder("missing")).toThrow(/does not exist/);
    expect(() => agent.setFolder("../")).toThrow(/inside env\.cwd/);
    expect(() => agent.setFolder("plain-file")).toThrow(/not a folder/);
    expect(agent.setFolder()).toBe(root);
  });
});

describe("library binding: engine over callbacks only", () => {
  test("normalized response callbacks drive the tool loop; context owned in-process", async () => {
    const { requests, url } = toolLoopServer();
    const { agent, terminal, events } = await libraryRun({ url });

    expect(terminal.type).toBe("done");
    expect(terminal.message.content).toEqual([{ type: "text", text: "library finished" }]);
    expect(requests).toHaveLength(2); // tool loop ran
    expect(events.map((e) => e.type)).toContain("toolcall_start");
    // context held in-process, editable through the Context surface
    expect(agent.context.map((m) => m.type)).toEqual([2, 3, 4, 3]);
    expect(Context.at(agent.context, 2).callId).toBeDefined();
  });

  test("parity with the CLI binding: same scenario, same terminal + context", async () => {
    const lib = toolLoopServer("parity text");
    const libRun = await libraryRun({ url: lib.url });

    const cli = toolLoopServer("parity text");
    const proc = Bun.spawn(
      ["bun", cliPath.agent, "--model", "ollama/m", "--url", cli.url],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, [NAMES.settingsEnv]: SPAWN_SETTINGS } },
    );
    proc.stdin.write(JSON.stringify([userMessage("read it")]));
    proc.stdin.end();
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exit).toBe(0);
    const cliEvents = stdout.trim().split("\n").map((l) => JSON.parse(l));
    const cliDone = cliEvents.at(-1);

    // terminal parity
    expect(libRun.terminal.message).toEqual(cliDone.message);
    expect(libRun.terminal.usage).toEqual(cliDone.usage);
    // context parity: library in-memory context == CLI's request-2 wire context
    // (excluding a leading "system" role either side may carry — the
    // spawned CLI's env.dir is the real package folder, unlike the
    // library run's isolated one above, so only IT picks up a fresh
    // session's system-prompt prefill; this test is about tool-loop
    // parity, not that)
    const cliWire = cli.requests[1].messages.map((m) => m.role).filter((r) => r !== "system");
    const libTypes = libRun.agent.context.slice(0, -1).map((m) =>
      ({ 1: "system", 2: "user", 3: "assistant", 4: "tool" })[m.type]).filter((r) => r !== "system");
    expect(libTypes).toEqual(cliWire);
  });

  test("injectable persistence: a duck-typed store receives the appends", async () => {
    const { url } = toolLoopServer();
    const appended = [];
    const store = {
      context: [userMessage("seeded")],
      append(m) { this.context.push(m); appended.push(m); },
      flush() { this.flushed = (this.flushed ?? 0) + 1; },
    };
    const { agent, terminal } = await libraryRun({ url, session: { session: store } });
    expect(terminal.type).toBe("done");
    expect(appended).toHaveLength(3); // assistant, tool result, assistant
    expect(store.flushed).toBeGreaterThan(0); // synced onDone
    expect(agent.context).toBe(store.context); // same live array
  });

  test("default persistence is the file store when a sessionId is given", async () => {
    const { url } = toolLoopServer();
    const id = `lib-${process.pid}`;
    const { agent } = await libraryRun({ url, session: { session: id, sessionDir: ROOT } });
    expect(agent.session).toBeInstanceOf(SessionStore);
    const records = readFileSync(agent.session.file, "utf8").trim().split("\n").map(JSON.parse)
    .filter((record) => record?.type !== "session-metadata");
    expect(records.every((m) => typeof m.type === "number" && m.op === undefined)).toBe(true);
    expect(records).toHaveLength(4); // seed + 3 loop messages
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("zero-dependency constraint: engine imports are node:/bun:/relative only", () => {
    // One approved, narrow exception: lib/markdown/marked.js's guarded
    // dynamic import("marked") — optional at runtime, never a declared
    // dependency (see README.md and test/cli-nodeps.test.js).
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".js") ? [`${dir}/${e.name}`] : []);
    const files = [cliPath.agent.slice(2), ...walk("lib")];
    for (const file of files) {
      const imports = transpiler.scan(readFs(`./${file}`, "utf8")).imports
        .map((entry) => entry.path)
        .filter((s) => !s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("bun"))
        .filter((s) => !(s === "marked" && file === "lib/markdown/marked.js"));
      expect(imports, `${file}: external imports ${imports}`).toEqual([]);
    }
  });
});
