// test/agent-session.test.js — proof for the JSONL session store:
// the file holds ONE metadata line (the origin-folder record — what
// maps a session to its project) plus the CURRENT context (one
// message per line, rewritten atomically on flush — no change log,
// no {op:} wrappers), buffered until flush, synced onDone + crash
// backstop via lib/finish.js, and resume loads it tolerantly
// (non-message records quietly ignored).
import { NAMES } from "../lib/namespace.js";
import { defaultSettingsDir } from "../lib/env/paths.js";
import { describe, expect, test, afterEach } from "bun:test";
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { Context } from "../lib/context.js";
import { loadMessages } from "../lib/context/store.js";
import { adoptResumeOrigin } from "../lib/cli.js";
import { Agent } from "../lib/agent.js";
import { Env } from "../lib/env.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

const ROOT = `./ai-tmp/session-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

/** The file's MESSAGE lines (the first, metadata, line excluded). */
const lines = (file) => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
  .filter((record) => record?.type !== "session-metadata");
/** The file's metadata record (first line). */
const metadata = (file) => JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]);

describe("Context", () => {
  test("Agent with saving disabled never resumes a same-named disk session", () => {
    const env = new Env({ settingsDir: ROOT, cwd: ROOT, settings: {} });
    const saved = new Agent({ env, contextId: "same-id", context: [USER("saved")], createIO: () => null });
    saved.context.flush();
    saved.close();

    const memory = new Agent({ env, contextId: "same-id", contextSave: false, context: [USER("live")], createIO: () => null });
    expect(memory.context.save).toBe(false);
    expect(memory.context.messages().filter((message) => message.type === 2)).toEqual([USER("live")]);
    memory.context.flush();
    expect(Context.resume({ id: "same-id", dir: env.settings.sessions }).messages().filter((message) => message.type === 2)).toEqual([USER("saved")]);
    memory.close();
  });

  test("Agent follows the Env sessions folder: <settings folder>/sessions by default", () => {
    const settingsDir = join(ROOT, "agent-settings");
    const env = new Env({ settingsDir, cwd: ROOT, settings: {} });
    expect(env.settings.sessions).toBe(join(settingsDir, NAMES.sessionsDir));
    const agent = new Agent({ env, contextId: "default-folder", createIO: () => null });
    expect(agent.context.dir).toBe(env.settings.sessions);
    agent.close();
  });

  test("settings.settings.sessions moves the folder; a relative path resolves against the settings folder", () => {
    const settingsDir = resolve(ROOT, "agent-settings-configured");
    expect(new Env({ settingsDir, cwd: ROOT, settings: { sessions: "logs" } }).settings.sessions).toBe(join(settingsDir, "logs"));
    const absolute = resolve(ROOT, "elsewhere");
    const env = new Env({ settingsDir, cwd: ROOT, settings: { sessions: absolute } });
    const agent = new Agent({ env, contextId: "configured-folder", createIO: () => null });
    expect(agent.context.dir).toBe(absolute);
    agent.close();
  });

  test("a project settings file cannot redirect the sessions folder into the agent-writable tree", () => {
    const project = resolve(ROOT, "project-redirect");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ sessions: join(project, "logs") }));
    const settingsDir = resolve(ROOT, "project-redirect-settings");
    const env = new Env({ settingsDir, cwd: project });
    expect(env.settings.sessions).toBe(join(settingsDir, NAMES.sessionsDir));
  });

  test("an Env without a user settings layer uses the default settings folder's sessions", () => {
    const env = new Env({ settingsDir: null, cwd: ROOT, settings: {} });
    expect(env.settings.sessions).toBe(join(defaultSettingsDir(), NAMES.sessionsDir));
  });

  test("saving disabled retains context without creating a directory or file, then persists the full live context when enabled", () => {
    const dir = join(ROOT, "memory-only");
    const store = new Context({ id: "memory", dir, save: false });
    store.append(USER("private"));
    store.flush();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(store.file)).toBe(false);
    expect(store.messages()).toEqual([USER("private")]);
    expect(store.save).toBe(false);

    expect(store.saveSet(true)).toBe(true);
    store.flush();
    expect(lines(store.file)).toEqual([USER("private")]);
    store.close();
  });

  test("writes the context as plain messages — one metadata line, then one message per line", () => {
    const store = new Context({ id: "s1", dir: ROOT });
    store.append(USER("one"));
    store.append({ type: 3, content: [{ type: "text", text: "two" }] });
    expect(existsSync(store.file)).toBe(false); // buffered until flush
    store.flush();

    const records = lines(store.file);
    expect(records).toEqual([USER("one"), { type: 3, content: [{ type: "text", text: "two" }] }]);
    expect(records.every((m) => typeof m.type === "number" && m.op === undefined)).toBe(true);
    expect(store.file).toContain("s1.jsonl"); // date + uuid8 prefix, then the given name
    expect(store.messages()).toHaveLength(2);
    // the metadata line maps the session to its origin folder
    const meta = metadata(store.file);
    expect(meta.type).toBe("session-metadata");
    expect(meta.id).toBe("s1");
    expect(meta.cwd).toBe(process.cwd());
    expect(typeof meta.created).toBe("string");
  });

  test("flush rewrites the whole file (edits are rewrites, not tombstones)", () => {
    const store = new Context({ id: "s1b", dir: ROOT });
    store.append(USER("one"));
    store.append({ type: 3, content: [{ type: "text", text: "two" }] });
    store.flush();
    store.pop();
    store.edit(0, USER("ONE"));
    store.flush();
    expect(lines(store.file)).toEqual([USER("ONE")]); // no trace of the removed/edited message
  });

  test("resume loads the file into a fresh in-memory array", () => {
    const store = new Context({ id: "s2", dir: ROOT });
    store.append(USER("a"));
    store.append({ type: 3, content: [{ type: "text", text: "b" }] });
    store.flush();
    store.close();

    const resumed = Context.resume({ id: "s2", dir: ROOT });
    expect(resumed.messages()).toEqual([USER("a"), { type: 3, content: [{ type: "text", text: "b" }] }]);
    expect(resumed.id).toBe("s2");
    // resume continues the same file
    resumed.append(USER("c"));
    resumed.flush();
    expect(lines(store.file)).toEqual([
      USER("a"),
      { type: 3, content: [{ type: "text", text: "b" }] },
      USER("c"),
    ]);
  });

  test("resume quietly ignores non-message records (metadata coexists)", () => {
    const store = new Context({ id: "s2b", dir: ROOT });
    store.append(USER("real"));
    store.flush();
    store.close();
    // foreign records + an unparseable line land in the file, AFTER
    // the session's own metadata line (which must stay first — it's
    // now also how resume() FINDS the file, not just origin/created)
    writeFileSync(store.file,
      readFileSync(store.file, "utf8") +
      JSON.stringify({ header: "mine", at: "now" }) + "\n" +
      "{not json\n" +
      JSON.stringify({ note: "no type here" }) + "\n");

    const resumed = Context.resume({ id: "s2b", dir: ROOT });
    expect(resumed.messages()).toEqual([USER("real")]); // only the message survives
  });

  test("loadMessages reads JSONL, keeping records, ignoring the shapeless", () => {
    // metadata RECORDS (a string `type`) load and ride the context;
    // shapeless values still drop; the file's own session-metadata
    // header never re-enters the context; a whole JSON array on one
    // line is just a record-less value and drops like anything else
    const record = { type: "note-store", notes: { a: { content: "x" } } };
    const mixed = [JSON.stringify({ meta: true }), JSON.stringify(USER("x")), "42", "null", JSON.stringify(record)].join("\n");
    expect(loadMessages(mixed)).toEqual([USER("x"), record]);
    expect(loadMessages([{ op: "append", message: USER("y") }, USER("z")])).toEqual([USER("z")]);
    expect(loadMessages([USER("a"), USER("b"), { type: "session-metadata", id: "s" }])).toEqual([USER("a"), USER("b")]);
    expect(loadMessages("")).toEqual([]);
  });

  test("resume of a missing session is a clear error", () => {
    expect(() => Context.resume({ id: "nope", dir: ROOT })).toThrow(/no session "nope"/);
  });

  test("pure tail appends flush as just the new lines; edits still rewrite", () => {
    const store = new Context({ id: "fast-path", dir: ROOT });
    store.append(USER("one"));
    store.flush();
    const full = readFileSync(store.file, "utf8");
    store.append({ type: 3, content: [{ type: "text", text: "two" }] }, { merge: false });
    store.flush();
    // the append fast-path: the prior bytes are a strict prefix of the file
    const after = readFileSync(store.file, "utf8");
    expect(after.startsWith(full)).toBe(true);
    expect(after.slice(full.length)).toBe(JSON.stringify({ type: 3, content: [{ type: "text", text: "two" }] }) + "\n");
    // an edit invalidates the fast-path: the next flush rewrites fully
    store.edit(0, USER("one-edited"));
    store.flush();
    const rewritten = readFileSync(store.file, "utf8");
    expect(rewritten.startsWith(full)).toBe(false);
    expect(lines(store.file)).toEqual([USER("one-edited"), { type: 3, content: [{ type: "text", text: "two" }] }]);
    store.close();
  });

  test("a resumed store appends via the fast-path and stays resumable", () => {
    const store = new Context({ id: "fast-resume", dir: ROOT });
    store.append(USER("seed"));
    store.close();
    const resumed = Context.resume({ id: "fast-resume", dir: ROOT });
    const before = readFileSync(resumed.file, "utf8");
    resumed.append({ type: 3, content: [{ type: "text", text: "more" }] }, { merge: false });
    resumed.flush();
    expect(readFileSync(resumed.file, "utf8").startsWith(before)).toBe(true);
    const again = Context.resume({ id: "fast-resume", dir: ROOT });
    expect(again.messages()).toEqual([USER("seed"), { type: 3, content: [{ type: "text", text: "more" }] }]);
    again.close();
  });

  test("flush is idempotent; close detaches", () => {
    const store = new Context({ id: "s3", dir: ROOT });
    store.append(USER("x"));
    store.flush();
    store.flush(); // no-op
    const size1 = readFileSync(store.file, "utf8").length;
    store.flush();
    expect(readFileSync(store.file, "utf8").length).toBe(size1);
    store.close();
    expect(() => store.append(USER("x"))).toThrow(/closed/);
  });

  test("live async flush never commits an obsolete snapshot after a synchronous mutation", async () => {
    const store = new Context({ id: "async-race", dir: ROOT });
    store.append(USER("first"));
    const pending = store.flushAsync();
    store.append(USER("second"));
    store.flush();
    await pending;
    expect(lines(store.file)).toEqual([USER("first\n\nsecond")]);
  });

  test("a stale live async snapshot leaves the later mutation dirty for the next async flush", async () => {
    const store = new Context({ id: "async-dirty", dir: ROOT });
    store.append(USER("first"));
    const pending = store.flushAsync();
    store.append(USER("second"));
    await pending;
    expect(store._dirty).toBeTruthy(); // "append" | "full", never false
    await store.flushAsync();
    expect(lines(store.file)).toEqual([USER("first\n\nsecond")]);
    expect(store._dirty).toBe(false);
  });
});

describe("Context file naming (date + sessionUUID prefix + name, no \"session-\" noise)", () => {
  const STEM = /^(\d{4}-\d{2}-\d{2}) ([0-9a-f]{8})(?: (.+))?\.jsonl$/;

  test("an EXPLICIT id is the name from the start: date + uuid8 + id", () => {
    const store = new Context({ id: "my-project", dir: ROOT });
    store.append(USER("hello"));
    store.flush();
    const m = STEM.exec(basename(store.file));
    expect(m).not.toBeNull();
    expect(m[1]).toBe(new Date().toISOString().slice(0, 10));
    expect(m[3]).toBe("my-project");
    expect(metadata(store.file).uuid).toMatch(/^[0-9a-f]{8}-/);
    expect(metadata(store.file).name).toBe("my-project");
    store.close();
  });

  test("an UNNAMED session (default random-uuid id) derives its name from the first real message, then freezes it", () => {
    const store = new Context({ dir: ROOT }); // no id: a fresh random UUID
    store.append(USER("please fix the flaky login test once and for all today"));
    store.flush();
    const base = basename(store.file);
    const m = STEM.exec(base);
    expect(m).not.toBeNull();
    expect(m[3]).toBe("please fix the flaky log"); // first 24 chars
    const namedFile = store.file;
    // editing later messages never renames the file again (frozen)
    store.append({ type: 3, content: [{ type: "text", text: "done" }] });
    store.flush();
    expect(store.file).toBe(namedFile);
    store.close();
  });

  test("a pure-thinking assistant message never qualifies as the first real message", () => {
    const store = new Context({ dir: ROOT });
    store.append({ type: 3, content: [{ type: "thinking", text: "hmm let me think about this" }] });
    store.append(USER("the actual question, finally"));
    store.flush();
    const m = STEM.exec(basename(store.file));
    expect(m[3]).toBe("the actual question, fin"); // first 24 chars
    store.close();
  });

  test("rename() keeps the SAME date/uuid8 prefix — only the name segment changes", () => {
    const store = new Context({ id: "old-name", dir: ROOT });
    store.append(USER("x"));
    store.flush();
    const before = STEM.exec(basename(store.file));
    store.rename("new-name");
    const after = STEM.exec(basename(store.file));
    expect(after[1]).toBe(before[1]); // same date
    expect(after[2]).toBe(before[2]); // same uuid8 — same session, new label
    expect(after[3]).toBe("new-name");
    store.close();
  });

  test("resuming, then reconstructing under the SAME id (restart-in-place) lands on the SAME file", () => {
    const store = new Context({ id: "restartable", dir: ROOT });
    store.append(USER("x"));
    store.flush();
    const originalFile = store.file;
    store.close();
    // a fresh store built for the SAME id (e.g. /session-delete!'s
    // restart-in-place) adopts the existing file's uuid/name/created —
    // never orphans the old file under a new random uuid8
    const fresh = new Context({ id: "restartable", dir: ROOT, messages: [] });
    expect(fresh.file).toBe(originalFile);
    fresh.flush(); // empty content: this removes the (now stale) file
    expect(existsSync(originalFile)).toBe(false);
  });

  test("a pre-existing \"session-\"-prefixed file (this scheme's own past) still resolves and resumes fine", () => {
    // an OLD file this exact naming scheme once wrote, before the
    // prefix was dropped — findSessionFile/resume must still find it
    // by its metadata id, same as any new prefix-less file
    mkdirSync(ROOT, { recursive: true });
    const legacyFile = join(ROOT, "session-2026-01-01 deadbeef old-label.jsonl");
    writeFileSync(legacyFile, [
      JSON.stringify({ type: "session-metadata", version: 1, id: "old-label", uuid: "deadbeef-0000-0000-0000-000000000000", name: "old-label", cwd: ROOT, created: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify(USER("still here")),
    ].join("\n") + "\n");
    expect(Context.fileOf({ dir: ROOT, id: "old-label" })).toBe(legacyFile);
    const resumed = Context.resume({ id: "old-label", dir: ROOT });
    expect(resumed.messages()).toEqual([USER("still here")]);
    expect(resumed.file).toBe(legacyFile); // pinned — never silently renamed
    resumed.close();
  });

  test("an EMPTY session never gets a file (flush/close write nothing)", () => {
    const store = new Context({ id: "empty1", dir: ROOT });
    store.flush();
    expect(existsSync(store.file)).toBe(false); // nothing to persist
    store.close(); // close flushes — still no file
    expect(existsSync(store.file)).toBe(false);
  });

  test("emptying an ACTIVE session REMOVES its file (rollback to zero)", () => {
    const store = new Context({ id: "empty2", dir: ROOT });
    store.append(USER("one"));
    store.append({ type: 3, content: [{ type: "text", text: "two" }] });
    store.flush();
    expect(existsSync(store.file)).toBe(true);
    store.rollback(0); // the whole conversation goes away
    store.flush();
    expect(store.messages()).toHaveLength(0);
    expect(existsSync(store.file)).toBe(false); // the stale file is gone
  });

  test("flush on an untouched empty session still removes a stale file", () => {
    // a foreign/leftover file under this session's id: not dirty, yet
    // the empty active session owns no file
    const store = new Context({ id: "empty3", dir: ROOT });
    writeFileSync(store.file, JSON.stringify(USER("stale")) + "\n");
    store.flush(); // not dirty — but empty contexts never hold a file
    expect(existsSync(store.file)).toBe(false);
  });
});

describe("Agent session wiring (wholly inside Agent)", () => {
  test("sessionId creates the file store; appends mirror; synced onDone", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    env.toolAdd("t", () => "out", { description: "t", inputSchema: {} });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
      [...TEXT(0, "final"), { type: "done" }],
    ]);
    const agent = new Agent({
      env, model: "p/m", contextId: "wired", context: [USER("go")], createIO: () => io,
    });
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");

    // synced onDone: the file already holds the full mirror — no manual flush
    const records = lines(agent.context.file);
    expect(records).toEqual(agent.context.messages().slice(0)); // full ordered mirror
    expect(records.map((m) => m.type)).toEqual([2, 3, 4, 3]); // seed, assistant, tool result, assistant
  });

  test("resume restores the context; the next run continues it", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const io1 = scriptedIO([[...TEXT(0, "first answer"), { type: "done" }]]);
    const first = new Agent({
      env, model: "p/m", contextId: "cont", context: [USER("q1")], createIO: () => io1,
    });
    await first.run();
    first.context.close();

    const io2 = scriptedIO([[...TEXT(0, "second answer"), { type: "done" }]]);
    const resumed = new Agent({
      env, model: "p/m", contextId: "cont", context: [USER("q2")], createIO: () => io2,
    });
    // loaded history + fresh input CONTINUES the session
    expect(resumed.context.messages()).toEqual([
      USER("q1"),
      { type: 3, content: [{ type: "text", text: "first answer" }] },
      USER("q2"),
    ]);
    await resumed.run();
    expect(resumed.context.at(-1)).toEqual({ type: 3, content: [{ type: "text", text: "second answer" }] });
    expect(io2.writes[0].context).toHaveLength(3); // continued context went to the provider
    // the continuation reached the file
    resumed.context.close();
    const continued = Context.resume({ id: "cont", dir: ROOT });
    expect(continued.messages()).toEqual(resumed.context.messages());
  });

  test("no sessionId/session: purely in-memory, no files appear", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const io = scriptedIO([[{ type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("x")], createIO: () => io });
    await agent.run();
    expect(existsSync(ROOT)).toBe(false);
  });
});

describe("context merging at append (Agent + Context)", () => {
  test("consecutive same-type appends merge into one message", () => {
    const store = new Context({ id: "merge-1", dir: ROOT });
    store.append(USER("queued one"));
    store.append(USER("queued two"));
    expect(store.messages()).toHaveLength(1);
    expect(store.at(0).content).toEqual([{ type: "text", text: "queued one\n\nqueued two" }]);
    store.flush();
    expect(lines(store.file)).toHaveLength(1); // the merge persists
  });

  test("tool results never merge — call→answer linkage stays per-message", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "alpha", {}), ...TOOLCALL(1, "c2", "alpha", {})],
      [...TEXT(0, "done")],
    ]);
    env.toolAdd?.("alpha", async () => "ok"); // programmatic tools when supported
    const agent = new Agent({ env, model: "p/m", createIO: () => io });
    agent._callTool = async () => "ok"; // bypass dispatch: linkage is what matters here
    await agent.run();
    const results = agent.context.messages().filter((m) => m.type === 4);
    expect(results).toHaveLength(2); // one result per call, never folded
    expect(results.map((m) => m.callId)).toEqual(["c1", "c2"]);
  });

  test("a cancel-partial assistant message merges with the next turn's", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const io = scriptedIO([
      [{ type: "error", error: "cancelled", kind: "cancelled", cancelled: true,
         message: { type: 3, content: [{ type: "thinking", text: "half a thought" }] } }],
      [{ type: "thinking_start", contentIndex: 0 },
       { type: "thinking_delta", contentIndex: 0, text: "the rest" },
       { type: "thinking_end", contentIndex: 0 },
       ...TEXT(1, "answer")],
    ]);
    const agent = new Agent({ env, model: "p/m", createIO: () => io });
    await agent.run(); // cancelled: partial assistant persisted
    await agent.run(); // next turn: consecutive assistant messages merge
    const assistants = agent.context.messages().filter((m) => m.type === 3);
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toEqual([
      { type: "thinking", text: "half a thought\n\nthe rest" },
      { type: "text", text: "answer" },
    ]);
  });
});

describe("Context.list / latest (session folder overview)", () => {
  const seed = async () => {
    const older = new Context({ id: "older", dir: ROOT });
    older.append(USER("first question about apples and pears and more fruit besides"));
    older.close();
    await Bun.sleep(20); // distinct mtimes
    const newer = new Context({ id: "newer", dir: ROOT });
    newer.append(USER("second question"));
    newer.append({ type: 3, content: [{ type: "text", text: "second answer" }] });
    newer.close();
  };

  test("lists sessions latest-first with message counts and first-user-message previews", async () => {
    await seed();
    const list = Context.list({ dir: ROOT });
    expect(list.map((s) => s.id)).toEqual(["newer", "older"]);
    expect(list[0].messages).toBe(2);
    expect(list[0].preview).toBe("second question");
    expect(list[1].preview).toContain("first question about apples");
    expect(list[0].file).toContain("newer.jsonl"); // date + uuid8 prefix, then the given name
    expect(list[0].mtime).toBeGreaterThan(list[1].mtime);
  });

  test("long previews truncate with an ellipsis; a system-message-only session persists nothing", async () => {
    await seed();
    const verbose = new Context({ id: "verbose", dir: ROOT });
    verbose.append(USER("x".repeat(200)));
    verbose.close();
    const empty = new Context({ id: "system-only", dir: ROOT });
    empty.append({ type: 1, content: [{ type: "text", text: "no user here" }] });
    empty.close();
    // only system messages = the seeded prompt awaiting the first user
    // message — the conversation hasn't started, so no file exists
    expect(existsSync(empty.file)).toBe(false);
    const list = Context.list({ dir: ROOT });
    const v = list.find((s) => s.id === "verbose");
    expect(v.preview.length).toBe(72);
    expect(v.preview.endsWith("…")).toBe(true);
    expect(list.find((s) => s.id === "system-only")).toBeUndefined();
  });

  test("latest() is the most recently modified session's id; a missing folder lists empty", async () => {
    expect(Context.list({ dir: `${ROOT}/nope` })).toEqual([]);
    expect(Context.latest({ dir: `${ROOT}/nope` })).toBeUndefined();
    await seed();
    expect(Context.latest({ dir: ROOT })).toBe("newer");
  });

  test("listAsync exactly matches synchronous metadata, ordering, and previews", async () => {
    await seed();
    const foreign = new Context({ id: "foreign-async", dir: ROOT, origin: `${ROOT}/elsewhere` });
    foreign.append(USER("foreign question"));
    foreign.close();
    const sync = Context.list({ dir: ROOT, cwd: process.cwd() });
    expect(await Context.listAsync({ dir: ROOT, cwd: process.cwd() })).toEqual(sync);
    expect(await Context.listAsync({ dir: `${ROOT}/nope` })).toEqual([]);
  });

  test("previews start at the first meaningful line: courtesy and intro lines skip, bullets strip", () => {
    const cases = [
      ["Please fix the following issues:\n\n- Displayed previews should skip filler.\n- Second item", "Displayed previews should skip filler."],
      ["Hi! Please help. Refactor the parser.", "Refactor the parser."],
      ["```js\nconst x = 1;\n```\n## Build a CLI", "Build a CLI"],
      ["<context>\n* [ ] ship the release", "ship the release"],
      ["1. First step\n2. Second", "First step"],
      ["Please add a login page", "Please add a login page"], // nothing else: the first line stands
    ];
    for (const [text, preview] of cases) {
      const store = new Context({ id: `p${cases.findIndex((c) => c[0] === text)}`, dir: ROOT });
      store.append(USER(text));
      store.close();
      expect(Context.list({ dir: ROOT }).find((s) => s.id === store.id).preview).toBe(preview);
    }
  });

  test("lists carry a non-default agent name; default agent-N names stay out", () => {
    const named = new Context({ id: "named-agent", dir: ROOT, settings: { name: "reviewer" } });
    named.append(USER("q"));
    named.close();
    const plain = new Context({ id: "plain-agent", dir: ROOT, settings: { name: "agent-3" } });
    plain.append(USER("q"));
    plain.close();
    const list = Context.list({ dir: ROOT });
    expect(list.find((s) => s.id === "named-agent").agent).toBe("reviewer");
    expect("agent" in list.find((s) => s.id === "plain-agent")).toBe(false);
  });

  test("a derived name moves an early-flushed session: the unnamed file goes away, the id lists once", async () => {
    const store = new Context({ dir: ROOT });
    store.append({ type: 3, content: [{ type: "thinking", text: "no text to name by" }] });
    store.flush();
    const unnamed = store.file;
    expect(existsSync(unnamed)).toBe(true);
    store.append({ type: 3, content: [{ type: "text", text: "Named at last" }] });
    store.flush();
    expect(store.file).not.toBe(unnamed);
    expect(existsSync(unnamed)).toBe(false);
    expect(existsSync(store.file)).toBe(true);
    store.close();
    // a leftover copy from before the fix still lists once (newest wins)
    writeFileSync(unnamed, readFileSync(store.file, "utf8").split("\n").slice(0, 2).join("\n") + "\n");
    expect(Context.list({ dir: ROOT }).filter((s) => s.id === store.id)).toHaveLength(1);
    expect((await Context.listAsync({ dir: ROOT })).filter((s) => s.id === store.id)).toHaveLength(1);
  });

  test("renameById / deleteById manage a stored session without a live store", () => {
    const store = new Context({ id: "stored", dir: ROOT });
    store.append(USER("keep me"));
    store.close();
    const renamed = Context.renameById({ id: "stored", name: "renamed", dir: ROOT });
    expect(renamed.id).toBe("renamed");
    expect(Context.list({ dir: ROOT }).map((s) => s.id)).toEqual(["renamed"]);
    expect(Context.list({ dir: ROOT })[0].preview).toBe("keep me");
    expect(Context.deleteById({ id: "renamed", dir: ROOT })).toEqual({ deleted: 1 });
    expect(Context.list({ dir: ROOT })).toEqual([]);
    expect(() => Context.renameById({ id: "gone", name: "x", dir: ROOT })).toThrow(/no session/);
  });
});

describe("Agent.contextNew / contextFork anonymous semantics", () => {
  test("new and fork preserve the current Context save setting", () => {
    const env = new Env({ settingsDir: ROOT, cwd: ROOT, settings: {} });
    const agent = new Agent({ env, contextId: "memory", contextSave: false, createIO: () => null });
    expect(agent.contextNew("next").id).toBe("next");
    expect(agent.context.save).toBe(false);
    expect(agent.contextFork("fork").id).toBe("fork");
    expect(agent.context.save).toBe(false);
    expect(existsSync(agent.context.dir)).toBe(false);
    agent.close();
  });
  test("anonymous spellings (false/0/false/anon) select a session that is not logged; ids never switch logging", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const agent = new Agent({
      env, model: "p/m",
      context: new Context({ id: "named", dir: ROOT }), createIO: () => null,
    });
    for (const id of [false, "anon", "0", "false"]) {
      agent.context.saveSet(true);
      const result = agent.contextNew(id);
      expect(result.save).toBe(false);
      expect(agent.context.save).toBe(false);
      expect(agent.context).toBeInstanceOf(Context); // always a store, never null
      expect(agent.context.id).not.toBe(id); // the spelling is not an id
      expect(existsSync(agent.context.file)).toBe(false);
    }
    // a session that is not logged stays so — with or without a new id
    expect(agent.contextNew().save).toBe(false);
    expect(agent.contextNew("named2").save).toBe(false);
    expect(agent.context.id).toBe("named2");
    // logging is one switch; fork keeps it, an anonymous spelling drops it
    agent.context.saveSet(true);
    expect(agent.contextFork().save).toBe(true);
    expect(agent.contextFork("anon").save).toBe(false);
    agent.close();
  });
  test("session: false (or omitted) gives a memory-only store; logging it later writes the WHOLE conversation", () => {
    const dir = resolve(ROOT, "memory-first-sessions");
    const env = new Env({ settingsDir: ROOT, cwd: ROOT, settings: { sessions: dir } });
    for (const options of [{ session: false }, {}, { session: "anon" }]) {
      const agent = new Agent({ env, context: [USER("keep me")], createIO: () => null, ...options });
      expect(agent.context).toBeInstanceOf(Context);
      expect(agent.context.save).toBe(false);
      expect(agent.context.dir).toBe(dir);
      expect(agent.context.summary).toBe(`${agent.context.id} — not logged (memory only)`);
      agent.context.flush();
      expect(existsSync(agent.context.file)).toBe(false);
      const context = agent.context;
      expect(agent.context.saveSet(true)).toBe(true);
      agent.context.flush();
      expect(agent.context).toBe(context); // the same conversation, now logged
      expect(readFileSync(agent.context.file, "utf8")).toContain("keep me");
      expect(agent.context.summary).toBe(`${agent.context.id} — ${agent.context.file}`);
      agent.close();
    }
    expect(() => new Agent({ env, contextId: null, createIO: () => null })).toThrow(/contextId must be an id or false/);
  });
  test("a session that is not logged can be named first; logging then writes under that name", () => {
    const env = new Env({ settingsDir: ROOT, cwd: ROOT, settings: { sessions: resolve(ROOT, "named-later") } });
    const agent = new Agent({ env, context: [USER("hello")], contextId: false, createIO: () => null });
    expect(agent.context.rename("later").id).toBe("later");
    expect(existsSync(agent.context.file)).toBe(false);
    agent.context.saveSet(true);
    agent.context.flush();
    expect(basename(agent.context.file)).toContain("later");
    expect(existsSync(agent.context.file)).toBe(true);
    agent.close();
  });
  test("fork from a session that is not logged keeps its context under the env's sessions folder", () => {
    const dir = resolve(ROOT, "anonymous-fork-sessions");
    const env = new Env({ settingsDir: ROOT, cwd: ROOT, settings: { sessions: dir } });
    const agent = new Agent({ env, context: [], createIO: () => null });
    agent.context.append(USER("carried"));
    const before = agent.context;
    const forked = agent.contextFork();
    expect(forked.save).toBe(false);
    expect(agent.context.dir).toBe(dir);
    expect(agent.context).not.toBe(before); // a new Context under a new id …
    expect(agent.context.messages()).toEqual(before.messages()); // … carrying the same conversation
    agent.close();
  });
});

describe("Agent.contextResume / Context.list / Context.latest", () => {
  test("contextResume switches the live context to the stored session's", async () => {
    const stored = new Context({ id: "stored", dir: ROOT });
    stored.append(USER("stored question"));
    stored.append({ type: 3, content: [{ type: "text", text: "stored answer" }] });
    stored.close();

    const agent = new Agent({
      env: await testEnv({ sessions: resolve(ROOT) }), model: "p/m",
      context: new Context({ id: "live", dir: ROOT }), createIO: () => null,
    });
    expect(agent.context.messages()).toEqual([]);
    const result = agent.contextResume("stored");
    expect(result.id).toBe("stored");
    expect(agent.context.id).toBe("stored");
    expect(agent.context.messages().map((m) => m.type)).toEqual([2, 3]);
    expect(() => agent.contextResume("missing")).toThrow(/no session "missing"/);
    expect(agent.context.id).toBe("stored"); // unchanged on failure
  });

  test("Context.list/latest read only the ORIGIN folder's sessions", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const a = new Context({ id: "a", dir: ROOT, origin: env.cwd });
    a.append(USER("question a"));
    a.close();
    await Bun.sleep(20); // distinct mtimes
    const live = new Context({ id: "b", dir: ROOT, origin: env.cwd });
    live.append(USER("question b"));
    live.close(); // only flushed sessions have a file to list
    // a session that ran in ANOTHER folder never lists for this project
    const foreign = new Context({ id: "foreign", dir: ROOT, origin: process.cwd() });
    foreign.append(USER("elsewhere"));
    foreign.close();
    const agent = new Agent({
      env, model: "p/m",
      context: new Context({ id: "c", dir: ROOT, origin: env.cwd }), createIO: () => null,
    });
    expect(Context.latest({ dir: agent.env.settings.sessions, cwd: agent.env.cwd })).toBe("b"); // the newest file OF THIS ORIGIN
    const ids = Context.list({ dir: agent.env.settings.sessions, cwd: agent.env.cwd }).map((s) => s.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("foreign"); // filtered by the origin metadata
    // an anonymous agent reads the same folder: the env's sessionsDir
    const anon = new Agent({
      env, model: "p/m",
      createIO: () => null,
    });
    expect(Context.list({ dir: anon.env.settings.sessions, cwd: anon.env.cwd }).map((s) => s.id)).toContain("a");
    // an explicit id resumes even across origins (the user asked by name)
    const resumed = agent.contextResume("foreign");
    expect(resumed.id).toBe("foreign");
  });

  test("contextResume adopts the session's ORIGIN folder as the cwd (resume anywhere)", async () => {
    // a session recorded against ANOTHER folder: resuming it moves the
    // process (and the environment's project-folder surface) there —
    // the bins' shape, where env.cwd IS the process folder
    const elsewhere = `${ROOT}/elsewhere`;
    mkdirSync(elsewhere, { recursive: true });
    const foreign = new Context({ id: "faraway", dir: ROOT, origin: elsewhere });
    foreign.append(USER("from another folder"));
    foreign.close();
    expect(Context.originOf({ id: "faraway", dir: ROOT })).toBe(elsewhere);
    expect(Context.originOf({ id: "missing", dir: ROOT })).toBeUndefined();

    const { Env } = await import("../lib/env.js");
    const env = new Env({ dir: ROOT, cwd: process.cwd(), settings: { sessions: resolve(ROOT), providers: { p: { provider: "test", url: "test://script" } } }, settingsDir: ROOT });
    const agent = new Agent({
      env, model: "p/m",
      context: new Context({ id: "home", dir: ROOT }), createIO: () => null,
    });
    const before = process.cwd();
    const elsewhereAbs = resolve(elsewhere); // BEFORE the chdir below
    try {
      const result = agent.contextResume("faraway");
      expect(result.cwd).toBe(elsewhere);
      expect(result.originMissing).toBe(false);
      expect(process.cwd()).toBe(elsewhereAbs);
      expect(env.cwd).toBe(elsewhere); // the environment followed (the recorded origin)
      expect(env.folders.find((f) => f.kind === "project").path).toBe(elsewhere);
    } finally {
      process.chdir(before); // the rest of the suite runs from the project
    }
  });

  test("contextResume on an EMBEDDED host (env.cwd elsewhere) adopts env-side only", async () => {
    // the process must NOT move when the environment doesn't track it
    const elsewhere = `${ROOT}/embedded-origin`;
    mkdirSync(elsewhere, { recursive: true });
    const foreign = new Context({ id: "embedded", dir: ROOT, origin: elsewhere });
    foreign.append(USER("x"));
    foreign.close();
    const env = await testEnv({ sessions: resolve(ROOT) }); // env.cwd is a temp folder, not the process's
    const agent = new Agent({
      env, model: "p/m",
      context: new Context({ id: "emb-home", dir: ROOT }), createIO: () => null,
    });
    const before = process.cwd();
    const result = agent.contextResume("embedded");
    expect(result.cwd).toBe(elsewhere);
    expect(process.cwd()).toBe(before); // untouched
    expect(env.cwd).toBe(elsewhere); // the environment adopted the origin
  });

  test("contextResume with a VANISHED origin folder stays put and reports it", async () => {
    const gone = `${ROOT}/gone`;
    mkdirSync(gone, { recursive: true });
    const foreign = new Context({ id: "ghost", dir: ROOT, origin: gone });
    foreign.append(USER("from a deleted folder"));
    foreign.close();
    rmSync(gone, { recursive: true, force: true });

    const agent = new Agent({
      env: await testEnv({ sessions: resolve(ROOT) }), model: "p/m",
      context: new Context({ id: "home2", dir: ROOT }), createIO: () => null,
    });
    const before = process.cwd();
    const result = agent.contextResume("ghost");
    expect(result.originMissing).toBe(true);
    expect(result.cwd).toBeUndefined();
    expect(process.cwd()).toBe(before); // stayed
    expect(agent.context.id).toBe("ghost"); // the session itself resumed fine
  });

  test("adoptResumeOrigin (the bins' --resume <id>): chdir, latest/anonymous never move, failures are clear", () => {
    // the helper reads the default namespace sessions folder — point
    // the settings variable at a throwaway settings home
    const settingsHome = `${ROOT}/settings-home`;
    const sessionsDir = `${settingsHome}/${NAMES.sessionsDir}`;
    const elsewhere = `${ROOT}/bin-resume`;
    mkdirSync(elsewhere, { recursive: true });
    const foreign = new Context({ id: "binres", dir: sessionsDir, origin: elsewhere });
    foreign.append(USER("x"));
    foreign.close();

    const before = process.cwd();
    const elsewhereAbs = resolve(elsewhere); // BEFORE the chdir below
    const settingsDir = process.env[NAMES.settingsEnv];
    try {
      process.env[NAMES.settingsEnv] = settingsHome;
      expect(adoptResumeOrigin({ resume: "latest" })).toBeNull();
      expect(adoptResumeOrigin({ resume: undefined })).toBeNull();
      expect(adoptResumeOrigin({ resume: "binres", anonymous: true })).toBeNull();
      expect(adoptResumeOrigin({ resume: "binres" })).toBe(elsewhere);
      expect(process.cwd()).toBe(elsewhereAbs);
      expect(() => adoptResumeOrigin({ resume: "nope" })).toThrow(/no such session/);
    } finally {
      process.chdir(before);
      if (settingsDir === undefined) delete process.env[NAMES.settingsEnv];
      else process.env[NAMES.settingsEnv] = settingsDir;
    }
  });

  test("deleteAll empties the sessions folder (every session file; foreign .jsonl files stay)", () => {
    const target = `${ROOT}/delete-all`;
    for (const id of ["x", "y"]) {
      const store = new Context({ id, dir: target });
      store.append(USER("q"));
      store.close();
    }
    writeFileSync(`${target}/keep.txt`, "foreign");
    writeFileSync(`${target}/notes.jsonl`, "not ours"); // foreign .jsonl: no metadata header
    expect(Context.deleteAll({ dir: target })).toEqual({ deleted: 2 });
    expect(existsSync(`${target}/x.jsonl`)).toBe(false); // new naming: no prefix
    expect(existsSync(`${target}/keep.txt`)).toBe(true); // foreign files stay
    expect(existsSync(`${target}/notes.jsonl`)).toBe(true); // foreign .jsonl stays too
    expect(Context.deleteAll({ dir: target })).toEqual({ deleted: 0 });
  });
});

describe("Session-persisted agent settings (resume restores the configuration)", () => {
  test("Context persists the settings record in the metadata line and carries it on resume", () => {
    const store = new Context({ id: "prefs", dir: ROOT });
    store.append(USER("q"));
    store.settingsSet({ safe: true, thinking: "high", endpoint: "p", model: "m" });
    store.flush();
    const meta = metadata(store.file);
    expect(meta.agent).toEqual({ safe: true, thinking: "high", endpoint: "p", model: "m" });
    store.close();

    const resumed = Context.resume({ id: "prefs", dir: ROOT });
    expect(resumed.settings).toEqual({ safe: true, thinking: "high", endpoint: "p", model: "m" });
    resumed.close();
  });

  test("a session without a settings record resumes with none (tolerant reader)", () => {
    const store = new Context({ id: "plain", dir: ROOT });
    store.append(USER("q"));
    store.close();
    expect(metadata(store.file).agent).toBeUndefined();
    const resumed = Context.resume({ id: "plain", dir: ROOT });
    expect(resumed.settings).toBeUndefined();
    resumed.close();
  });

  test("agent mutations record into the store; contextResume restores them", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const agent = new Agent({
      env, model: "p/m",
      context: new Context({ id: "configured", dir: ROOT, origin: env.cwd }), createIO: () => null,
    });
    agent.context.append(USER("hello"));
    agent.safeSet(true);
    agent.thinkingSet("high");
    agent.modelSet("p1/m");
    agent.nameSet("pilot");
    agent.descriptionSet("the flying one");
    agent.spawnPermissionSet(true);
    agent.context.saveSet(false);
    agent.context.saveSet(true); // net: saving on
    agent.context.flush();
    const meta = metadata(agent.context.file);
    expect(meta.agent).toMatchObject({ safe: true, thinking: "high", endpoint: "p1", model: "m", name: "pilot", description: "the flying one", spawnPermission: true });
    expect(meta.agent.sessionSave).toBeUndefined(); // logging is the context's own flag, not an agent setting

    const bare = new Agent({ env, context: new Context({ id: "scratch", dir: ROOT, origin: env.cwd }), createIO: () => null });
    expect(bare.safe).toBe(false);
    bare.contextResume("configured");
    expect(bare.safe).toBe(true);
    expect(bare.thinking).toBe("high");
    expect(bare.endpoint).toBe("p1");
    expect(bare.model).toBe("m");
    expect(bare.name).toBe("pilot");
    expect(bare.description).toBe("the flying one");
    expect(bare.spawnPermission).toBe(true);
    expect(bare.context.save).toBe(true);
  });

  test("an explicit caller model wins over the stored one; an unnamed agent keeps its name", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const stored = new Agent({
      env, model: "p/m", name: "kept",
      context: new Context({ id: "stored", dir: ROOT, origin: env.cwd }), createIO: () => null,
    });
    stored.context.append(USER("q"));
    stored.context.flush();
    stored.close();

    // constructor resume with an explicit --model: the caller's selection
    // stands — and on close it becomes the session's new stored selection
    const explicit = new Agent({ env, model: "p2/m", contextId: "stored", createIO: () => null });
    expect(explicit.endpoint).toBe("p2");
    expect(explicit.name).toBe("kept"); // stored name fills the default
    explicit.close(); // close flushes: p2/m now rides the file

    // constructor resume with NO model: the stored selection applies
    const plain = new Agent({ env: await testEnv({ sessions: resolve(ROOT) }), contextId: "stored", createIO: () => null });
    expect(plain.endpoint).toBe("p2");
    expect(plain.model).toBe("m");
    plain.close();

    // an explicitly named agent resuming mid-flight keeps ITS name
    const named = new Agent({ env: await testEnv({ sessions: resolve(ROOT) }), name: "explicit-name", context: new Context({ id: "tmp", dir: ROOT }), createIO: () => null });
    named.contextResume("stored");
    expect(named.name).toBe("explicit-name");
    expect(named.endpoint).toBe("p2"); // no caller model: the stored one applies
  });

  test("a stored endpoint gone from the env never breaks resume", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const agent = new Agent({
      env, model: "p/m",
      context: new Context({ id: "gone-endpoint", dir: ROOT, origin: env.cwd }), createIO: () => null,
    });
    agent.context.append(USER("q"));
    agent.context.flush();
    // simulate a provider disappearing: rewrite the metadata with a dead endpoint
    const file = agent.context.file;
    const meta = metadata(file);
    meta.agent = { ...meta.agent, endpoint: "vanished", model: "m" };
    const rest = readFileSync(file, "utf8").split("\n").slice(1).join("\n");
    writeFileSync(file, `${JSON.stringify(meta)}\n${rest}`);
    agent.close();

    const resumed = new Agent({ env, model: "p/m", contextId: "gone-endpoint", createIO: () => null });
    expect(resumed.endpoint).toBe("p"); // the caller's selection stands
    resumed.close();
  });

  test("the default agent-N name never rides the file; a chosen name still does", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const agent = new Agent({
      env, model: "p/m",
      context: new Context({ id: "unnamed", dir: ROOT, origin: env.cwd }), createIO: () => null,
    });
    agent.context.append(USER("q"));
    agent.safeSet(true); // a settings mutation: records the snapshot (name included)
    agent.context.flush();
    expect(metadata(agent.context.file).agent.name).toBeUndefined();
    agent.close();

    // a chosen name still persists — resume restores it onto a default-named agent
    const named = new Agent({
      env, model: "p/m", name: "keeper",
      context: new Context({ id: "named", dir: ROOT, origin: env.cwd }), createIO: () => null,
    });
    named.context.append(USER("q"));
    named.safeSet(true); // record the snapshot
    named.context.flush();
    expect(metadata(named.context.file).agent.name).toBe("keeper");
    named.close();
    const resumed = new Agent({ env, model: "p/m", contextId: "named", createIO: () => null });
    expect(resumed.name).toBe("keeper");
    resumed.close();
  });

});
