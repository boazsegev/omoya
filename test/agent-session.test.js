// test/agent-session.test.js — proof for the JSONL session store:
// the file holds ONE metadata line (the origin-folder record — what
// maps a session to its project) plus the CURRENT context (one
// message per line, rewritten atomically on flush — no change log,
// no {op:} wrappers), buffered until flush, synced onDone + crash
// backstop via lib/finish.js, and resume loads it tolerantly
// (non-message records quietly ignored).
import { NAMES } from "../lib/namespace.js";
import { defaultSettingsDir } from "../lib/env/paths.js";
import { describe, expect, test, afterEach, spyOn } from "bun:test";
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { Context } from "../lib/context.js";
import { loadMessages } from "../lib/context/store.js";
import { adoptResumeOrigin } from "../lib/app/cli.js";
import { Agent } from "../lib/agent.js";
import { Env } from "../lib/env.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

const ROOT = `./ai-tmp/session-${process.pid}`;
afterEach(async () => {
  await Promise.all(Object.values(Env.envs).filter((env) => env.folder === resolve(ROOT) || env.folder.startsWith(`${resolve(ROOT)}/`)).map((env) => env.close()));
  rmSync(ROOT, { recursive: true, force: true });
});

/** The file's MESSAGE lines (the first, metadata, line excluded). */
const lines = (file) => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
  .filter((record) => record?.type !== "session-metadata");
/** The file's metadata record (first line). */
const metadata = (file) => JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]);

describe("Context", () => {
  test("loading and resuming a session without a round or manual edit leaves its file untouched", async () => {
    const env = await Env.open(ROOT, { settingsDir: ROOT, settings: {} });
    const first = await Agent.create({ env, contextId: "read-only-resume", context: [USER("hello")], createIO: () => null });
    first.context.flush();
    const file = first.context.file;
    await first.close();
    const before = { text: readFileSync(file, "utf8"), stat: statSync(file) };
    const assertUntouched = () => {
      expect(readFileSync(file, "utf8")).toBe(before.text);
      expect(statSync(file).ino).toBe(before.stat.ino);
      expect(statSync(file).mtimeMs).toBe(before.stat.mtimeMs);
    };
    const resumed = await Agent.create({ env, contextId: "read-only-resume", createIO: () => null });
    assertUntouched();
    expect(resumed.context.messages().filter((message) => message.type === 2)).toEqual([USER("hello")]);
    assertUntouched();
    await resumed.close();
    assertUntouched();
    await env.close();
  });
  test("Agent with saving disabled never resumes a same-named disk session", async () => {
    const env = await Env.open(ROOT, { settingsDir: ROOT, settings: {} });
    const saved = await Agent.create({ env, contextId: "same-id", context: [USER("saved")], createIO: () => null });
    saved.context.flush();
    await saved.close();

    const memory = await Agent.create({ env, contextId: "same-id", contextSave: false, context: [USER("live")], createIO: () => null });
    expect(memory.context.save).toBe(false);
    expect(memory.context.messages().filter((message) => message.type === 2)).toEqual([USER("live")]);
    memory.context.flush();
    expect(Context.resume({ id: "same-id", dir: env.settings.sessions }).messages().filter((message) => message.type === 2)).toEqual([USER("saved")]);
    await memory.close();
  });

  test("Agent follows the Env sessions folder: <settings folder>/sessions by default", async () => {
    const settingsDir = join(ROOT, "agent-settings");
    const env = await Env.open(ROOT, { settingsDir, settings: {} });
    expect(env.settings.sessions).toBe(join(settingsDir, NAMES.sessionsDir));
    const agent = await Agent.create({ env, contextId: "default-folder", createIO: () => null });
    expect(agent.context.dir).toBe(env.settings.sessions);
    await agent.close();
  });

  test("settings.settings.sessions moves the folder; a relative path resolves against the settings folder", async () => {
    const settingsDir = resolve(ROOT, "agent-settings-configured");
    const first = await Env.open(ROOT, { settingsDir, settings: { sessions: "logs" } });
    expect(first.settings.sessions).toBe(join(settingsDir, "logs"));
    await first.close();
    const absolute = resolve(ROOT, "elsewhere");
    const env = await Env.open(ROOT, { settingsDir, settings: { sessions: absolute } });
    const agent = await Agent.create({ env, contextId: "configured-folder", createIO: () => null });
    expect(agent.context.dir).toBe(absolute);
    await agent.close();
  });

  test("project sessions path resolves relative to the project and isolates its log and resume", async () => {
    const project = resolve(ROOT, "project-redirect");
    const other = resolve(ROOT, "other-project");
    mkdirSync(project, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ sessions: "logs" }));
    const settingsDir = resolve(ROOT, "project-redirect-settings");
    const env = await Env.open(project, { settingsDir });
    const otherEnv = await Env.open(other, { settingsDir });
    await Promise.all([env.ready(), otherEnv.ready()]);
    expect(env.settings.sessions).toBe(join(project, "logs"));
    expect(otherEnv.settings.sessions).toBe(join(settingsDir, NAMES.sessionsDir));
    const agent = await Agent.create({ env, contextId: "isolated", createIO: () => null });
    agent.context.append(USER("saved"));
    agent.context.flush();
    expect(existsSync(agent.context.file)).toBe(true);
    await agent.close();
    const resumed = await Agent.create({ env, contextId: "isolated", createIO: () => null });
    expect(resumed.context.dir).toBe(join(project, "logs"));
    expect(resumed.context.messages()).toContainEqual(USER("saved"));
    await resumed.close();
  });

  test("project auth records cannot redirect the session folder", async () => {
    const project = resolve(ROOT, "auth-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${NAMES.projectAuthPrefix}evil.json`), JSON.stringify({ sessions: "auth-logs" }));
    const settingsDir = resolve(ROOT, "auth-settings");
    const env = await Env.open(project, { settingsDir });
    await env.ready();
    expect(env.settings.sessions).toBe(join(settingsDir, NAMES.sessionsDir));
  });

  test("explicit settings override a project sessions path without changing the project file", async () => {
    const project = resolve(ROOT, "explicit-project");
    mkdirSync(project, { recursive: true });
    const file = join(project, NAMES.projectSettings);
    writeFileSync(file, JSON.stringify({ sessions: "project-logs" }));
    const settingsDir = resolve(ROOT, "explicit-settings");
    const env = await Env.open(project, { settingsDir, settings: { sessions: "caller-logs" } });
    await env.ready();
    expect(env.settings.sessions).toBe(join(settingsDir, "caller-logs"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ sessions: "project-logs" });
    await env.close();
  });

  test("embedded sessionsDir overrides project settings only for that Env, without persistence", async () => {
    const project = resolve(ROOT, "embedded-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ sessions: "configured" }));
    const settingsDir = resolve(ROOT, "embedded-settings");
    const env = await Env.open(project, { settingsDir, sessionsDir: "ephemeral" });
    await env.ready();
    expect(env.settings.sessions).toBe(join(project, "ephemeral"));
    const agent = await Agent.create({ env, contextId: "embedded", createIO: () => null });
    expect(agent.context.dir).toBe(join(project, "ephemeral"));
    agent.context.flush();
    await agent.close();
    await env.close();
    const reloaded = await Env.open(project, { settingsDir });
    await reloaded.ready();
    expect(reloaded.settings.sessions).toBe(join(project, "configured"));
    expect(JSON.parse(readFileSync(join(project, NAMES.projectSettings), "utf8"))).toEqual({ sessions: "configured" });
  });

  test("embedded sessionsDir rejects invalid paths and resolves absolute paths unchanged", async () => {
    await expect(Env.open(ROOT, { settingsDir: null, sessionsDir: "" })).rejects.toThrow(/sessionsDir/);
    await expect(Env.open(ROOT, { settingsDir: null, sessionsDir: 42 })).rejects.toThrow(/sessionsDir/);
    const target = resolve(ROOT, "absolute-logs");
    const env = await Env.open(ROOT, { settingsDir: null, sessionsDir: target });
    expect(env.settings.sessions).toBe(target);
    await env.close();
  });

  test("an Env without a user settings layer uses the default settings folder's sessions", async () => {
    const env = await Env.open(ROOT, { settingsDir: null, settings: {} });
    expect(env.settings.sessions).toBe(join(defaultSettingsDir(), NAMES.sessionsDir));
  });

  test("saving disabled retains context without creating a directory or file, then persists the full live context when enabled", async () => {
    const dir = join(ROOT, "memory-only");
    const store = new Context({ id: "memory", dir, save: false });
    store.append(USER("private"));
    store.flush();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(store.file)).toBe(false);
    expect(store.messages()).toEqual([USER("private")]);
    expect(store.save).toBe(false);

    expect((store.save = true)).toBe(true);
    store.flush();
    expect(lines(store.file)).toEqual([USER("private")]);
    await store.close();
  });

  test("writes the context as plain messages — one metadata line, then one message per line", async () => {
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

  test("flush rewrites the whole file (edits are rewrites, not tombstones)", async () => {
    const store = new Context({ id: "s1b", dir: ROOT });
    store.append(USER("one"));
    store.append({ type: 3, content: [{ type: "text", text: "two" }] });
    store.flush();
    store.pop();
    store.edit(0, USER("ONE"));
    store.flush();
    expect(lines(store.file)).toEqual([USER("ONE")]); // no trace of the removed/edited message
  });

  test("resume loads the file into a fresh in-memory array", async () => {
    const store = new Context({ id: "s2", dir: ROOT });
    store.append(USER("a"));
    store.append({ type: 3, content: [{ type: "text", text: "b" }] });
    store.flush();
    await store.close();

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

  test("resume quietly ignores non-message records (metadata coexists)", async () => {
    const store = new Context({ id: "s2b", dir: ROOT });
    store.append(USER("real"));
    store.flush();
    await store.close();
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

  test("loadMessages reads JSONL, keeping records, ignoring the shapeless", async () => {
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

  test("resume of a missing session is a clear error", async () => {
    expect(() => Context.resume({ id: "nope", dir: ROOT })).toThrow(/no session "nope"/);
  });

  test("pure tail appends flush as just the new lines; edits still rewrite", async () => {
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
    await store.close();
  });

  test("a resumed store appends via the fast-path and stays resumable", async () => {
    const store = new Context({ id: "fast-resume", dir: ROOT });
    store.append(USER("seed"));
    await store.close();
    const resumed = Context.resume({ id: "fast-resume", dir: ROOT });
    const before = readFileSync(resumed.file, "utf8");
    resumed.append({ type: 3, content: [{ type: "text", text: "more" }] }, { merge: false });
    resumed.flush();
    expect(readFileSync(resumed.file, "utf8").startsWith(before)).toBe(true);
    const again = Context.resume({ id: "fast-resume", dir: ROOT });
    expect(again.messages()).toEqual([USER("seed"), { type: 3, content: [{ type: "text", text: "more" }] }]);
    await again.close();
  });

  test("flush is idempotent; close detaches", async () => {
    const store = new Context({ id: "s3", dir: ROOT });
    store.append(USER("x"));
    store.flush();
    store.flush(); // no-op
    const size1 = readFileSync(store.file, "utf8").length;
    store.flush();
    expect(readFileSync(store.file, "utf8").length).toBe(size1);
    await store.close();
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
    expect(store._unflushed).toBeTruthy(); // "append" | "full", never false
    await store.flushAsync();
    expect(lines(store.file)).toEqual([USER("first\n\nsecond")]);
    expect(store._unflushed).toBe(false);
  });
});

describe("Context file naming (date + sessionUUID prefix + name, no \"session-\" noise)", () => {
  const STEM = /^(\d{4}-\d{2}-\d{2}) ([0-9a-f]{8})(?: (.+))?\.jsonl$/;

  test("an EXPLICIT id is the name from the start: date + uuid8 + id", async () => {
    const store = new Context({ id: "my-project", dir: ROOT });
    store.append(USER("hello"));
    store.flush();
    const m = STEM.exec(basename(store.file));
    expect(m).not.toBeNull();
    expect(m[1]).toBe(new Date().toISOString().slice(0, 10));
    expect(m[3]).toBe("my-project");
    expect(metadata(store.file).uuid).toMatch(/^[0-9a-f]{8}-/);
    expect(metadata(store.file).name).toBe("my-project");
    await store.close();
  });

  test("an UNNAMED session (default random-uuid id) derives its name from the first real message, then freezes it", async () => {
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
    await store.close();
  });

  test("a pure-thinking assistant message never qualifies as the first real message", async () => {
    const store = new Context({ dir: ROOT });
    store.append({ type: 3, content: [{ type: "thinking", text: "hmm let me think about this" }] });
    store.append(USER("the actual question, finally"));
    store.flush();
    const m = STEM.exec(basename(store.file));
    expect(m[3]).toBe("the actual question, fin"); // first 24 chars
    await store.close();
  });

  test("rename() keeps the SAME date/uuid8 prefix — only the name segment changes", async () => {
    const store = new Context({ id: "old-name", dir: ROOT });
    store.append(USER("x"));
    store.flush();
    const before = STEM.exec(basename(store.file));
    store.rename("new-name");
    const after = STEM.exec(basename(store.file));
    expect(after[1]).toBe(before[1]); // same date
    expect(after[2]).toBe(before[2]); // same uuid8 — same session, new label
    expect(after[3]).toBe("new-name");
    await store.close();
  });

  test("resuming, then reconstructing under the SAME id (restart-in-place) lands on the SAME file", async () => {
    const store = new Context({ id: "restartable", dir: ROOT });
    store.append(USER("x"));
    store.flush();
    const originalFile = store.file;
    await store.close();
    // a fresh store built for the SAME id (e.g. /session-delete!'s
    // restart-in-place) adopts the existing file's uuid/name/created —
    // never orphans the old file under a new random uuid8
    const fresh = new Context({ id: "restartable", dir: ROOT, messages: [] });
    expect(fresh.file).toBe(originalFile);
    fresh.flush(); // empty content: this removes the (now stale) file
    expect(existsSync(originalFile)).toBe(false);
  });

  test("a pre-existing \"session-\"-prefixed file (this scheme's own past) still resolves and resumes fine", async () => {
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
    await resumed.close();
  });

  test("an EMPTY session never gets a file (flush/close write nothing)", async () => {
    const store = new Context({ id: "empty1", dir: ROOT });
    store.flush();
    expect(existsSync(store.file)).toBe(false); // nothing to persist
    await store.close(); // close flushes — still no file
    expect(existsSync(store.file)).toBe(false);
  });

  test("emptying an ACTIVE session REMOVES its file (rollback to zero)", async () => {
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

  test("flush on an untouched empty session still removes a stale file", async () => {
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
    const agent = await Agent.create({
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
    const first = await Agent.create({
      env, model: "p/m", contextId: "cont", context: [USER("q1")], createIO: () => io1,
    });
    await first.run();
    await first.context.close();

    const io2 = scriptedIO([[...TEXT(0, "second answer"), { type: "done" }]]);
    const resumed = await Agent.create({
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
    await resumed.context.close();
    const continued = Context.resume({ id: "cont", dir: ROOT });
    expect(continued.messages()).toEqual(resumed.context.messages());
  });

  test("no sessionId/session: purely in-memory, no files appear", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const io = scriptedIO([[{ type: "done" }]]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("x")], createIO: () => io });
    await agent.run();
    expect(existsSync(ROOT)).toBe(false);
  });
});

describe("context merging at append (Agent + Context)", () => {
  test("consecutive same-type appends merge into one message", async () => {
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
    const agent = await Agent.create({ env, model: "p/m", createIO: () => io });
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
    const agent = await Agent.create({ env, model: "p/m", createIO: () => io });
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
    await older.close();
    await Bun.sleep(20); // distinct mtimes
    const newer = new Context({ id: "newer", dir: ROOT });
    newer.append(USER("second question"));
    newer.append({ type: 3, content: [{ type: "text", text: "second answer" }] });
    await newer.close();
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
    await verbose.close();
    const empty = new Context({ id: "system-only", dir: ROOT });
    empty.append({ type: 1, content: [{ type: "text", text: "no user here" }] });
    await empty.close();
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
    await foreign.close();
    const sync = Context.list({ dir: ROOT, cwd: process.cwd() });
    expect(await Context.listAsync({ dir: ROOT, cwd: process.cwd() })).toEqual(sync);
    expect(await Context.listAsync({ dir: `${ROOT}/nope` })).toEqual([]);
  });

  test("listAsync refreshes changed files and does not resurrect deleted or renamed files", async () => {
    const store = new Context({ id: "cache-target", dir: ROOT });
    store.append(USER("before")); store.flush();
    const first = await Context.listAsync({ dir: ROOT });
    expect(first.find((item) => item.id === "cache-target")).toMatchObject({ messages: 1, preview: "before" });
    store.append({ type: 3, content: [{ type: "text", text: "after" }] }); store.flush();
    expect(lines(store.file)).toHaveLength(2);
    const second = await Context.listAsync({ dir: ROOT });
    expect(Context.list({ dir: ROOT }).find((item) => item.id === "cache-target")?.messages).toBe(2);
    expect(second.find((item) => item.id === "cache-target")?.messages).toBe(2);
    const oldFile = store.file;
    store.rename("cache-renamed");
    const renamed = await Context.listAsync({ dir: ROOT });
    expect(renamed.some((item) => item.file === oldFile || item.id === "cache-target")).toBe(false);
    expect(renamed.find((item) => item.id === "cache-renamed")?.messages).toBe(2);
    Context.deleteById({ id: "cache-renamed", dir: ROOT });
    expect(await Context.listAsync({ dir: ROOT })).toEqual([]);
  });

  test("listAsync revalidates replacements with the same byte count and timestamp", async () => {
    const store = new Context({ id: "cache-replace", dir: ROOT });
    store.append(USER("aaaa")); await store.close();
    const initial = await Context.listAsync({ dir: ROOT });
    const { statSync, utimesSync, renameSync } = await import("node:fs");
    const { mtime, atime } = statSync(store.file);
    const replacement = `${ROOT}/replacement.tmp`;
    writeFileSync(replacement, readFileSync(store.file, "utf8").replace("aaaa", "bbbb"));
    renameSync(replacement, store.file);
    utimesSync(store.file, atime, mtime);
    expect((await Context.listAsync({ dir: ROOT }))[0].preview).toBe("bbbb");
    expect(initial[0].preview).toBe("aaaa");
  });

  test("previews start at the first meaningful line: courtesy and intro lines skip, bullets strip", async () => {
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
      await store.close();
      expect(Context.list({ dir: ROOT }).find((s) => s.id === store.id).preview).toBe(preview);
    }
  });

  test("an Assistant message before the first User message (a compacted session) is the preview", async () => {
    const compacted = new Context({ id: "compacted", dir: ROOT });
    compacted.append({ type: 1, content: [{ type: "text", text: "system prompt" }] });
    compacted.append({ type: 3, content: [{ type: "text", text: "[context compacted — the summary of the earlier conversation follows]\nRefactored the parser.\n\n[end of summary — continue the work based on it]" }] });
    compacted.append(USER("next question"));
    await compacted.close();
    const thinking = new Context({ id: "thinking-only", dir: ROOT });
    thinking.append({ type: 3, content: [{ type: "thinking", text: "pondering" }] });
    thinking.append(USER("the real question"));
    await thinking.close();
    for (const list of [Context.list({ dir: ROOT }), await Context.listAsync({ dir: ROOT })]) {
      expect(list.find((s) => s.id === "compacted").preview).toBe("Refactored the parser.");
      expect(list.find((s) => s.id === "thinking-only").preview).toBe("the real question"); // no text: scan on
    }
  });

  test("preview capture spans read chunks and handles a torn final candidate", async () => {
    mkdirSync(ROOT, { recursive: true });
    const id = "chunked-preview";
    const header = `${JSON.stringify({ type: "session-metadata", id, cwd: process.cwd() })}\n`;
    const user = JSON.stringify(USER("preview across chunks"));
    const token = '"text":"';
    const emptySystem = JSON.stringify({ type: 1, content: [{ type: "text", text: "" }] });
    const tokenAt = 64 * 1024 - 3;
    const padding = tokenAt - Buffer.byteLength(header) - emptySystem.length - 1 - user.indexOf(token);
    const system = JSON.stringify({ type: 1, content: [{ type: "text", text: "x".repeat(padding) }] });
    const data = header + system + "\n" + user; // no final newline: a torn tail still previews
    expect(Buffer.byteLength(header) + Buffer.byteLength(system) + 1 + user.indexOf(token)).toBe(tokenAt);
    writeFileSync(join(ROOT, "chunked.jsonl"), data);
    const [listed] = await Context.listAsync({ dir: ROOT });
    expect(listed).toMatchObject({ id, messages: 1, preview: "preview across chunks" });
  });

  test("preview scanning does not concatenate text-less candidate lines", async () => {
    const store = new Context({ id: "tokenless-candidates", dir: ROOT });
    for (let index = 0; index < 8; index++) {
      store.append({ type: 3, content: [{ type: "thinking", text: `thought ${index}` }] });
      store.append({ type: 2, content: [{ type: "binary", mime: "application/octet-stream", content: "AA==" }] });
    }
    store.append(USER("the visible question"));
    await store.close();
    const concat = spyOn(Buffer, "concat");
    let listed;
    let concatenations;
    try {
      listed = Context.list({ dir: ROOT });
      concatenations = concat.mock.calls.length;
    } finally { concat.mockRestore(); }
    expect(concatenations).toBe(0);
    expect(listed.find((item) => item.id === store.id)).toMatchObject({ messages: 16, preview: "the visible question" });
  });

  test("lists carry a non-default agent name; default agent-N names stay out", async () => {
    const named = new Context({ id: "named-agent", dir: ROOT, settings: { name: "reviewer" } });
    named.append(USER("q"));
    await named.close();
    const plain = new Context({ id: "plain-agent", dir: ROOT, settings: { name: "agent-3" } });
    plain.append(USER("q"));
    await plain.close();
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
    await store.close();
    // a leftover copy from before the fix still lists once (newest wins)
    writeFileSync(unnamed, readFileSync(store.file, "utf8").split("\n").slice(0, 2).join("\n") + "\n");
    expect(Context.list({ dir: ROOT }).filter((s) => s.id === store.id)).toHaveLength(1);
    expect((await Context.listAsync({ dir: ROOT })).filter((s) => s.id === store.id)).toHaveLength(1);
  });

  test("renameById / deleteById manage a stored session without a live store", async () => {
    const store = new Context({ id: "stored", dir: ROOT });
    store.append(USER("keep me"));
    await store.close();
    const renamed = Context.renameById({ id: "stored", name: "renamed", dir: ROOT });
    expect(renamed.id).toBe("renamed");
    expect(Context.list({ dir: ROOT }).map((s) => s.id)).toEqual(["renamed"]);
    expect(Context.list({ dir: ROOT })[0].preview).toBe("keep me");
    expect(Context.deleteById({ id: "renamed", dir: ROOT })).toEqual({ deleted: 1 });
    expect(Context.list({ dir: ROOT })).toEqual([]);
    expect(() => Context.renameById({ id: "gone", name: "x", dir: ROOT })).toThrow(/no session/);
  });
});

describe("Agent constructor conversation lifetime and anonymous semantics", () => {
  test("each new Agent owns a deep-cloned seed and starts with fresh usage, pending messages and tool state", async () => {
    const env = await Env.open(ROOT, { settingsDir: ROOT, settings: {} });
    const seed = [USER("original")];
    const first = await Agent.create({ env, context: seed, createIO: () => null });
    const second = await Agent.create({ env, context: seed, createIO: () => null });
    seed[0].content[0].text = "changed outside";
    first.context.at(-1).content[0].text = "changed first";
    expect(second.context.messages().filter((message) => message.type === 2)).toEqual([USER("original")]);
    expect(second.context).not.toBe(first.context);
    expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
    expect(second.pending).toEqual([]);
    expect(second._activeTools.size).toBe(0);
    await first.close(); await second.close(); await env.close();
  });
  test("new Agents and forked Contexts preserve explicit memory-only saving without replacing the original", async () => {
    const env = await Env.open(ROOT, { settingsDir: ROOT, settings: {} });
    const original = await Agent.create({ env, contextId: "memory", contextSave: false, context: [USER("carried")], createIO: () => null });
    const next = await Agent.create({ env, contextId: "next", contextSave: original.context.save, createIO: () => null });
    const fork = new Context({ id: "fork", messages: original.context.messages(), dir: env.settings.sessions,
      origin: env.folder, save: original.context.save, settings: original.context.settings });
    const forked = await Agent.create({ env, context: fork, createIO: () => null });
    expect(next.context.id).toBe("next");
    expect(next.context.save).toBe(false);
    expect(forked.context).toBe(fork);
    expect(forked.context.messages()).toEqual(original.context.messages());
    expect(forked.context.save).toBe(false);
    expect(forked.usage).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
    expect(forked.pending).toEqual([]);
    expect(forked._activeTools.size).toBe(0);
    expect(original.context.id).toBe("memory");
    expect(original.context.messages().filter((m) => m.type === 2)).toEqual([USER("carried")]);
    expect(existsSync(original.context.dir)).toBe(false);
    await forked.close(); await next.close(); await original.close();
  });
  test("anonymous spellings (false/0/false/anon) create memory-only Agents; explicit ids control logging independently", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    for (const id of [false, "anon", "0", "false", undefined]) {
      const agent = await Agent.create({ env, model: "p/m", contextId: id, context: [USER("private")], createIO: () => null });
      expect(agent.context.save).toBe(false);
      expect(agent.context).toBeInstanceOf(Context);
      expect(!agent.context.id).toBe(true);
      agent.context.flush();
      expect(existsSync(agent.context.file)).toBe(false);
      await agent.close();
    }
    const named = await Agent.create({ env, model: "p/m", contextId: "named", context: [USER("saved")], createIO: () => null });
    expect(named.context.save).toBe(true);
    named.context.flush();
    expect(existsSync(named.context.file)).toBe(true);
    await named.close();
    const privateNamed = await Agent.create({ env, model: "p/m", contextId: "named", contextSave: false, createIO: () => null });
    expect(privateNamed.context.save).toBe(false);
    expect(privateNamed.context.messages().filter((m) => m.type === 2)).toEqual([]);
    await privateNamed.close();
  });
  test("session: false (or omitted) gives a memory-only store; logging it later writes the WHOLE conversation", async () => {
    const dir = resolve(ROOT, "memory-first-sessions");
    const env = await Env.open(ROOT, { settingsDir: ROOT, settings: { sessions: dir } });
    for (const options of [{ session: false }, {}, { session: "anon" }]) {
      const agent = await Agent.create({ env, context: [USER("keep me")], createIO: () => null,
        ...(options.session === undefined ? {} : { contextId: options.session }) });
      expect(agent.context).toBeInstanceOf(Context);
      expect(agent.context.save).toBe(false);
      expect(agent.context.dir).toBe(dir);
      expect(agent.context.summary).toBe(`${agent.context.id} — not logged (memory only)`);
      agent.context.flush();
      expect(existsSync(agent.context.file)).toBe(false);
      const context = agent.context;
      expect((agent.context.save = true)).toBe(true);
      agent.context.flush();
      expect(agent.context).toBe(context); // the same conversation, now logged
      expect(readFileSync(agent.context.file, "utf8")).toContain("keep me");
      expect(agent.context.summary).toBe(`${agent.context.id} — ${agent.context.file}`);
      await agent.close();
    }
    await expect(Agent.create({ env, contextId: null, createIO: () => null })).rejects.toThrow(/contextId must be an id or false/);
  });
  test("a session that is not logged can be named first; logging then writes under that name", async () => {
    const env = await Env.open(ROOT, { settingsDir: ROOT, settings: { sessions: resolve(ROOT, "named-later") } });
    const agent = await Agent.create({ env, context: [USER("hello")], contextId: false, createIO: () => null });
    expect(agent.context.rename("later").id).toBe("later");
    expect(existsSync(agent.context.file)).toBe(false);
    (agent.context.save = true);
    agent.context.flush();
    expect(basename(agent.context.file)).toContain("later");
    expect(existsSync(agent.context.file)).toBe(true);
    await agent.close();
  });
  test("fork from a session that is not logged keeps its context under the env's sessions folder", async () => {
    const dir = resolve(ROOT, "anonymous-fork-sessions");
    const env = await Env.open(ROOT, { settingsDir: ROOT, settings: { sessions: dir } });
    const agent = await Agent.create({ env, context: [], createIO: () => null });
    agent.context.append(USER("carried"));
    const before = agent.context;
    const forkedContext = new Context({ messages: before.messages(), dir: env.settings.sessions,
      origin: env.folder, save: before.save, settings: before.settings });
    const forked = await Agent.create({ env, context: forkedContext, createIO: () => null });
    expect(forked.context.save).toBe(false);
    expect(forked.context.dir).toBe(dir);
    expect(forked.context).not.toBe(before);
    expect(forked.context.messages()).toEqual(before.messages());
    expect(agent.context).toBe(before);
    await forked.close(); await agent.close();
  });
});

describe("Agent construction / Context.list / Context.latest", () => {
  test("constructor resumes stored history while a missing Context.resume leaves the original Agent unchanged", async () => {
    const stored = new Context({ id: "stored", dir: ROOT });
    stored.append(USER("stored question"));
    stored.append({ type: 3, content: [{ type: "text", text: "stored answer" }] });
    await stored.close();

    const agent = await Agent.create({
      env: await testEnv({ sessions: resolve(ROOT), system: "" }, { cwd: process.cwd() }), model: "p/m",
      context: new Context({ id: "live", dir: ROOT }), createIO: () => null,
    });
    expect(agent.context.messages().filter((message) => message.type === 2)).toEqual([]);
    const resumed = await Agent.create({ env: agent.env, model: "p/m", contextId: "stored", createIO: () => null });
    expect(resumed.context.id).toBe("stored");
    expect(resumed.context.messages().map((m) => m.type)).toEqual([2, 3]);
    expect(() => Context.resume({ id: "missing", dir: ROOT })).toThrow(/no session "missing"/);
    const missing = await Agent.create({ env: agent.env, model: "p/m", contextId: "missing", createIO: () => null });
    expect(missing.context.id).toBe("missing");
    expect(agent.context.id).toBe("live");
    expect(agent.context.messages().filter((m) => m.type === 2)).toEqual([]);
    await missing.close(); await resumed.close(); await agent.close();
  });

  test("Context.list/latest read only the ORIGIN folder's sessions", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const a = new Context({ id: "a", dir: ROOT, origin: env.folder });
    a.append(USER("question a"));
    await a.close();
    await Bun.sleep(20); // distinct mtimes
    const live = new Context({ id: "b", dir: ROOT, origin: env.folder });
    live.append(USER("question b"));
    await live.close(); // only flushed sessions have a file to list
    // a session that ran in ANOTHER folder never lists for this project
    const foreign = new Context({ id: "foreign", dir: ROOT, origin: process.cwd() });
    foreign.append(USER("elsewhere"));
    await foreign.close();
    const agent = await Agent.create({
      env, model: "p/m",
      context: new Context({ id: "c", dir: ROOT, origin: env.folder }), createIO: () => null,
    });
    expect(Context.latest({ dir: agent.env.settings.sessions, cwd: agent.env.folder })).toBe("b"); // the newest file OF THIS ORIGIN
    const ids = Context.list({ dir: agent.env.settings.sessions, cwd: agent.env.folder }).map((s) => s.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("foreign"); // filtered by the origin metadata
    // an anonymous agent reads the same folder: the env's sessionsDir
    const anon = await Agent.create({
      env, model: "p/m",
      createIO: () => null,
    });
    expect(Context.list({ dir: anon.env.settings.sessions, cwd: anon.env.folder }).map((s) => s.id)).toContain("a");
    // Explicit ids also remain confined to this Env's project.
    await expect(Agent.create({ env, model: "p/m", contextId: "foreign", createIO: () => null })).rejects.toThrow(/belongs to .*resume it in that project/);
    expect(agent.context.id).toBe("c");
  });

  test("construction refuses a foreign origin even when it exists", async () => {
    // a session recorded against ANOTHER folder: resume is confined to env.folder,
    // so neither the process nor the Env moves there
    const elsewhere = `${ROOT}/elsewhere`;
    mkdirSync(elsewhere, { recursive: true });
    const foreign = new Context({ id: "faraway", dir: ROOT, origin: elsewhere });
    foreign.append(USER("from another folder"));
    await foreign.close();
    expect(Context.originOf({ id: "faraway", dir: ROOT })).toBe(elsewhere);
    expect(Context.originOf({ id: "missing", dir: ROOT })).toBeUndefined();

    const { Env } = await import("../lib/env.js");
    const env = await Env.open(resolve(ROOT, "home"), { dir: ROOT, settings: { sessions: resolve(ROOT), providers: { p: { provider: "test", url: "test://script" } } }, settingsDir: ROOT, init: { providers: false, tools: false, detect: false, models: false } });
    const agent = await Agent.create({
      env, model: "p/m",
      context: new Context({ id: "home", dir: ROOT }), createIO: () => null,
    });
    const before = process.cwd();
    await expect(Agent.create({ env, model: "p/m", contextId: "faraway", createIO: () => null })).rejects.toThrow(/belongs to .*resume it in that project/);
    expect(process.cwd()).toBe(before);
    expect(env.folder).toBe(resolve(ROOT, "home"));
    expect(agent.context.id).toBe("home");
  });

  test("construction on an embedded host refuses another project's origin", async () => {
    // an embedded host (env.folder not the process folder) is confined the same way
    const elsewhere = `${ROOT}/embedded-origin`;
    mkdirSync(elsewhere, { recursive: true });
    const foreign = new Context({ id: "embedded", dir: ROOT, origin: elsewhere });
    foreign.append(USER("x"));
    await foreign.close();
    const env = await testEnv({ sessions: resolve(ROOT) }); // env.folder is a temp folder, not the process's
    const agent = await Agent.create({
      env, model: "p/m",
      context: new Context({ id: "emb-home", dir: ROOT }), createIO: () => null,
    });
    const before = process.cwd();
    await expect(Agent.create({ env, model: "p/m", contextId: "embedded", createIO: () => null })).rejects.toThrow(/belongs to .*resume it in that project/);
    expect(process.cwd()).toBe(before);
    expect(env.folder).not.toBe(resolve(elsewhere));
  });

  test("construction refuses a vanished foreign origin without changing state", async () => {
    const gone = `${ROOT}/gone`;
    mkdirSync(gone, { recursive: true });
    const foreign = new Context({ id: "ghost", dir: ROOT, origin: gone });
    foreign.append(USER("from a deleted folder"));
    await foreign.close();
    rmSync(gone, { recursive: true, force: true });

    const agent = await Agent.create({
      env: await testEnv({ sessions: resolve(ROOT) }), model: "p/m",
      context: new Context({ id: "home2", dir: ROOT }), createIO: () => null,
    });
    const before = process.cwd();
    await expect(Agent.create({ env: agent.env, model: "p/m", contextId: "ghost", createIO: () => null })).rejects.toThrow(/belongs to .*resume it in that project/);
    expect(process.cwd()).toBe(before);
    expect(agent.context.id).toBe("home2");
  });

  test("adoptResumeOrigin (the bins' --resume <id>): chdir, latest/anonymous never move, failures are clear", async () => {
    // the helper reads the default namespace sessions folder — point
    // the settings variable at a throwaway settings home
    const settingsHome = `${ROOT}/settings-home`;
    const sessionsDir = `${settingsHome}/${NAMES.sessionsDir}`;
    const elsewhere = `${ROOT}/bin-resume`;
    mkdirSync(elsewhere, { recursive: true });
    const foreign = new Context({ id: "binres", dir: sessionsDir, origin: elsewhere });
    foreign.append(USER("x"));
    await foreign.close();

    const before = process.cwd();
    const elsewhereAbs = resolve(elsewhere); // BEFORE the chdir below
    const settingsDir = process.env[NAMES.settingsEnv];
    try {
      process.env[NAMES.settingsEnv] = settingsHome;
      expect(await adoptResumeOrigin({ resume: "latest" })).toBeNull();
      expect(await adoptResumeOrigin({ resume: undefined })).toBeNull();
      expect(await adoptResumeOrigin({ resume: "binres", anonymous: true })).toBeNull();
      expect(await adoptResumeOrigin({ resume: "binres" })).toBe(elsewhere);
      expect(process.cwd()).toBe(elsewhereAbs);
      await expect(adoptResumeOrigin({ resume: "nope" })).rejects.toThrow(/no such session/);
    } finally {
      process.chdir(before);
      if (settingsDir === undefined) delete process.env[NAMES.settingsEnv];
      else process.env[NAMES.settingsEnv] = settingsDir;
    }
  });

  test("deleteAll empties the sessions folder (every session file; foreign .jsonl files stay)", async () => {
    const target = `${ROOT}/delete-all`;
    for (const id of ["x", "y"]) {
      const store = new Context({ id, dir: target });
      store.append(USER("q"));
      await store.close();
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
  test("Context persists the settings record in the metadata line and carries it on resume", async () => {
    const store = new Context({ id: "prefs", dir: ROOT });
    store.append(USER("q"));
    (store.settings = { safe: true, thinking: "high", model: "p/m" });
    store.flush();
    const meta = metadata(store.file);
    expect(meta.agent).toEqual({ safe: true, thinking: "high", model: "p/m" });
    await store.close();

    const resumed = Context.resume({ id: "prefs", dir: ROOT });
    expect(resumed.settings).toEqual({ safe: true, thinking: "high", model: "p/m" });
    await resumed.close();
  });

  test("a session without a settings record resumes with none (tolerant reader)", async () => {
    const store = new Context({ id: "plain", dir: ROOT });
    store.append(USER("q"));
    await store.close();
    expect(metadata(store.file).agent).toBeUndefined();
    const resumed = Context.resume({ id: "plain", dir: ROOT });
    expect(resumed.settings).toBeUndefined();
    await resumed.close();
  });

  test("agent mutations record into the store; a new Agent restores them", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const agent = await Agent.create({
      env, model: "p/m",
      context: new Context({ id: "configured", dir: ROOT, origin: env.folder }), createIO: () => null,
    });
    agent.context.append(USER("hello"));
    (agent.can.write = false);
    (agent.thinking = "high");
    (agent.model = "p1/m");
    (agent.name = "pilot");
    (agent.description = "the flying one");
    (agent.can.delegate = true);
    (agent.context.save = false);
    (agent.context.save = true); // net: saving on
    agent.context.flush();
    const meta = metadata(agent.context.file);
    expect(meta.agent).toMatchObject({ thinking: "high", model: "p1/m", name: "pilot", description: "the flying one", can: { write: false, delegate: true } });
    expect(meta.agent.sessionSave).toBeUndefined(); // logging is the context's own flag, not an agent setting

    const bare = await Agent.create({ env, contextId: "configured", createIO: () => null });
    expect(bare.can.write).toBe(false);
    expect(bare.thinking).toBe("high");
    expect(bare.model).toBe("p1/m");
    expect(meta.agent.endpoint).toBeUndefined();
    expect(bare.name).toBe("pilot");
    expect(bare.description).toBe("the flying one");
    expect(bare.can.delegate).toBe(true);
    expect(bare.context.save).toBe(true);
  });

  test("an explicit caller model wins over the stored one; an unnamed agent keeps its name", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const stored = await Agent.create({
      env, model: "p/m", name: "kept", contextId: "stored", createIO: () => null,
    });
    stored.context.append(USER("q"));
    stored.context.flush();
    await stored.close();

    // A launch override applies in memory without rewriting the session.
    const explicit = await Agent.create({ env, model: "p2/m", contextId: "stored", createIO: () => null });
    expect(explicit.model).toBe("p2/m");
    expect(explicit.name).toBe("kept"); // stored name fills the default
    await explicit.close();

    // Without a completed round or a manual update, the stored selection remains.
    const plain = await Agent.create({ env, contextId: "stored", createIO: () => null });
    expect(plain.model).toBe("p/m");
    plain.model = "p2/m"; // manual update is durable
    await plain.close();
    const updated = await Agent.create({ env, contextId: "stored", createIO: () => null });
    expect(updated.model).toBe("p2/m");
    await updated.close();

    // an explicitly named agent resuming mid-flight keeps ITS name
    const named = await Agent.create({ env, name: "explicit-name", contextId: "stored", createIO: () => null });
    expect(named.name).toBe("explicit-name");
    expect(named.model).toBe("p2/m"); // no caller model: the stored one applies
  });

  test("a resumed launch model override is stored after a completed round", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const initial = await Agent.create({ env, model: "p/m", contextId: "round-model", context: [USER("q")], createIO: () => null });
    initial.context.flush();
    await initial.close();
    const file = initial.context.file;
    const original = statSync(file).ino;
    const resumed = await Agent.create({ env, model: "p2/m", contextId: "round-model", createIO: () => scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]) });
    expect(statSync(file).ino).toBe(original);
    expect(metadata(file).agent.model).toBe("p/m");
    expect((await resumed.run()).type).toBe("done");
    expect(metadata(file).agent.model).toBe("p2/m");
    await resumed.close();
  });

  test("a stored endpoint gone from the env never breaks resume", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const agent = await Agent.create({
      env, model: "p/m",
      context: new Context({ id: "gone-endpoint", dir: ROOT, origin: env.folder }), createIO: () => null,
    });
    agent.context.append(USER("q"));
    agent.context.flush();
    // simulate a provider disappearing: rewrite the metadata with a dead endpoint
    const file = agent.context.file;
    const meta = metadata(file);
    meta.agent = { ...meta.agent, model: "vanished/m" };
    const rest = readFileSync(file, "utf8").split("\n").slice(1).join("\n");
    writeFileSync(file, `${JSON.stringify(meta)}\n${rest}`);
    await agent.close();

    const resumed = await Agent.create({ env, model: "p/m", contextId: "gone-endpoint", createIO: () => null });
    expect(resumed.model).toBe("p/m"); // the caller's selection stands
    await resumed.close();
  });

  test("the default agent-N name never rides the file; a chosen name still does", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const agent = await Agent.create({
      env, model: "p/m",
      context: new Context({ id: "unnamed", dir: ROOT, origin: env.folder }), createIO: () => null,
    });
    agent.context.append(USER("q"));
    (agent.can.write = false); // a settings mutation: records the snapshot (name included)
    agent.context.flush();
    expect(metadata(agent.context.file).agent.name).toBeUndefined();
    await agent.close();

    // a chosen name still persists — resume restores it onto a default-named agent
    const named = await Agent.create({
      env, model: "p/m", name: "keeper",
      context: new Context({ id: "named", dir: ROOT, origin: env.folder }), createIO: () => null,
    });
    named.context.append(USER("q"));
    (named.can.write = false); // record the snapshot
    named.context.flush();
    expect(metadata(named.context.file).agent.name).toBe("keeper");
    await named.close();
    const resumed = await Agent.create({ env, model: "p/m", contextId: "named", createIO: () => null });
    expect(resumed.name).toBe("keeper");
    await resumed.close();
  });

});
