// test/agent-session.test.js — proof for the JSONL session store:
// the file holds ONE metadata line (the origin-folder record — what
// maps a session to its project) plus the CURRENT context (one
// message per line, rewritten atomically on flush — no change log,
// no {op:} wrappers), buffered until flush, synced onDone + crash
// backstop via lib/finish.js, and resume loads it tolerantly
// (non-message records quietly ignored).
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, afterEach } from "bun:test";
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { SessionStore, loadMessages, findSessionFile } from "../lib/agent.js";
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

describe("SessionStore", () => {
  test("Agent with saving disabled never resumes a same-named disk session", () => {
    const env = new Env({ settingsDir: ROOT, cwd: ROOT, settings: {} });
    const saved = new Agent({ env, session: "same-id", context: [USER("saved")], createIO: () => null });
    saved.session.flush();
    saved.close();

    const memory = new Agent({ env, session: "same-id", sessionSave: false, context: [USER("live")], createIO: () => null });
    expect(memory.sessionSave).toBe(false);
    expect(memory.context.filter((message) => message.type === 2)).toEqual([USER("live")]);
    memory.session.flush();
    expect(SessionStore.resume({ id: "same-id", dir: memory._sessionDir }).context.filter((message) => message.type === 2)).toEqual([USER("saved")]);
    memory.close();
  });

  test("Agent defaults sessions to its Env settings folder", () => {
    const settingsDir = join(ROOT, "agent-settings");
    const env = new Env({ settingsDir, cwd: ROOT, settings: {} });
    const agent = new Agent({ env, session: "default-folder", createIO: () => null });
    expect(agent._sessionDir).toBe(join(settingsDir, NAMES.sessionsDir));
    expect(agent.session.dir).toBe(join(settingsDir, NAMES.sessionsDir));
    agent.close();
  });

  test("Agent with a user-layer-disabled Env still uses the default settings sessions folder", () => {
    const env = new Env({ settingsDir: null, cwd: ROOT, settings: {} });
    const agent = new Agent({ env, session: "disabled-layer", createIO: () => null });
    expect(agent._sessionDir).toBe(join(Env.defaultSettingsDir(), NAMES.sessionsDir));
    agent.close();
  });

  test("saving disabled retains context without creating a directory or file, then persists the full live context when enabled", () => {
    const dir = join(ROOT, "memory-only");
    const store = new SessionStore({ id: "memory", dir, save: false });
    store.append(USER("private"));
    store.flush();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(store.file)).toBe(false);
    expect(store.context).toEqual([USER("private")]);
    expect(store.save).toBe(false);

    expect(store.saveSet(true)).toBe(true);
    store.flush();
    expect(lines(store.file)).toEqual([USER("private")]);
    store.close();
  });

  test("writes the context as plain messages — one metadata line, then one message per line", () => {
    const store = new SessionStore({ id: "s1", dir: ROOT });
    store.append(USER("one"));
    store.append({ type: 3, content: [{ type: "text", text: "two" }] });
    expect(existsSync(store.file)).toBe(false); // buffered until flush
    store.flush();

    const records = lines(store.file);
    expect(records).toEqual([USER("one"), { type: 3, content: [{ type: "text", text: "two" }] }]);
    expect(records.every((m) => typeof m.type === "number" && m.op === undefined)).toBe(true);
    expect(store.file).toContain("s1.jsonl"); // date + uuid8 prefix, then the given name
    expect(store.context).toHaveLength(2);
    // the metadata line maps the session to its origin folder
    const meta = metadata(store.file);
    expect(meta.type).toBe("session-metadata");
    expect(meta.id).toBe("s1");
    expect(meta.cwd).toBe(process.cwd());
    expect(typeof meta.created).toBe("string");
  });

  test("flush rewrites the whole file (edits are rewrites, not tombstones)", () => {
    const store = new SessionStore({ id: "s1b", dir: ROOT });
    store.append(USER("one"));
    store.append({ type: 3, content: [{ type: "text", text: "two" }] });
    store.flush();
    store.pop();
    store.edit(0, USER("ONE"));
    store.flush();
    expect(lines(store.file)).toEqual([USER("ONE")]); // no trace of the removed/edited message
  });

  test("resume loads the file into a fresh in-memory array", () => {
    const store = new SessionStore({ id: "s2", dir: ROOT });
    store.append(USER("a"));
    store.append({ type: 3, content: [{ type: "text", text: "b" }] });
    store.flush();
    store.close();

    const resumed = SessionStore.resume({ id: "s2", dir: ROOT });
    expect(resumed.context).toEqual([USER("a"), { type: 3, content: [{ type: "text", text: "b" }] }]);
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
    const store = new SessionStore({ id: "s2b", dir: ROOT });
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

    const resumed = SessionStore.resume({ id: "s2b", dir: ROOT });
    expect(resumed.context).toEqual([USER("real")]); // only the message survives
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
    expect(() => SessionStore.resume({ id: "nope", dir: ROOT })).toThrow(/no session "nope"/);
  });

  test("pure tail appends flush as just the new lines; edits still rewrite", () => {
    const store = new SessionStore({ id: "fast-path", dir: ROOT });
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
    const store = new SessionStore({ id: "fast-resume", dir: ROOT });
    store.append(USER("seed"));
    store.close();
    const resumed = SessionStore.resume({ id: "fast-resume", dir: ROOT });
    const before = readFileSync(resumed.file, "utf8");
    resumed.append({ type: 3, content: [{ type: "text", text: "more" }] }, { merge: false });
    resumed.flush();
    expect(readFileSync(resumed.file, "utf8").startsWith(before)).toBe(true);
    const again = SessionStore.resume({ id: "fast-resume", dir: ROOT });
    expect(again.context).toEqual([USER("seed"), { type: 3, content: [{ type: "text", text: "more" }] }]);
    again.close();
  });

  test("flush is idempotent; close detaches", () => {
    const store = new SessionStore({ id: "s3", dir: ROOT });
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
    const store = new SessionStore({ id: "async-race", dir: ROOT });
    store.append(USER("first"));
    const pending = store._flushAsync();
    store.append(USER("second"));
    store.flush();
    await pending;
    expect(lines(store.file)).toEqual([USER("first\nsecond")]);
  });

  test("a stale live async snapshot leaves the later mutation dirty for the next async flush", async () => {
    const store = new SessionStore({ id: "async-dirty", dir: ROOT });
    store.append(USER("first"));
    const pending = store._flushAsync();
    store.append(USER("second"));
    await pending;
    expect(store._dirty).toBeTruthy(); // "append" | "full", never false
    await store._flushAsync();
    expect(lines(store.file)).toEqual([USER("first\nsecond")]);
    expect(store._dirty).toBe(false);
  });
});

describe("SessionStore file naming (date + sessionUUID prefix + name, no \"session-\" noise)", () => {
  const STEM = /^(\d{4}-\d{2}-\d{2}) ([0-9a-f]{8})(?: (.+))?\.jsonl$/;

  test("an EXPLICIT id is the name from the start: date + uuid8 + id", () => {
    const store = new SessionStore({ id: "my-project", dir: ROOT });
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
    const store = new SessionStore({ dir: ROOT }); // no id: a fresh random UUID
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
    const store = new SessionStore({ dir: ROOT });
    store.append({ type: 3, content: [{ type: "thinking", text: "hmm let me think about this" }] });
    store.append(USER("the actual question, finally"));
    store.flush();
    const m = STEM.exec(basename(store.file));
    expect(m[3]).toBe("the actual question, fin"); // first 24 chars
    store.close();
  });

  test("rename() keeps the SAME date/uuid8 prefix — only the name segment changes", () => {
    const store = new SessionStore({ id: "old-name", dir: ROOT });
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
    const store = new SessionStore({ id: "restartable", dir: ROOT });
    store.append(USER("x"));
    store.flush();
    const originalFile = store.file;
    store.close();
    // a fresh store built for the SAME id (e.g. /session-delete!'s
    // restart-in-place) adopts the existing file's uuid/name/created —
    // never orphans the old file under a new random uuid8
    const fresh = new SessionStore({ id: "restartable", dir: ROOT, context: [] });
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
    expect(findSessionFile(ROOT, "old-label")).toBe(legacyFile);
    const resumed = SessionStore.resume({ id: "old-label", dir: ROOT });
    expect(resumed.context).toEqual([USER("still here")]);
    expect(resumed.file).toBe(legacyFile); // pinned — never silently renamed
    resumed.close();
  });

  test("an EMPTY session never gets a file (flush/close write nothing)", () => {
    const store = new SessionStore({ id: "empty1", dir: ROOT });
    store.flush();
    expect(existsSync(store.file)).toBe(false); // nothing to persist
    store.close(); // close flushes — still no file
    expect(existsSync(store.file)).toBe(false);
  });

  test("emptying an ACTIVE session REMOVES its file (rollback to zero)", () => {
    const store = new SessionStore({ id: "empty2", dir: ROOT });
    store.append(USER("one"));
    store.append({ type: 3, content: [{ type: "text", text: "two" }] });
    store.flush();
    expect(existsSync(store.file)).toBe(true);
    store.rollback(0); // the whole conversation goes away
    store.flush();
    expect(store.context).toHaveLength(0);
    expect(existsSync(store.file)).toBe(false); // the stale file is gone
  });

  test("flush on an untouched empty session still removes a stale file", () => {
    // a foreign/leftover file under this session's id: not dirty, yet
    // the empty active session owns no file
    const store = new SessionStore({ id: "empty3", dir: ROOT });
    writeFileSync(store.file, JSON.stringify(USER("stale")) + "\n");
    store.flush(); // not dirty — but empty contexts never hold a file
    expect(existsSync(store.file)).toBe(false);
  });
});

describe("Agent session wiring (wholly inside Agent)", () => {
  test("sessionId creates the file store; appends mirror; synced onDone", async () => {
    const env = await testEnv();
    env.registerTool("t", () => "out", { description: "t", inputSchema: {} });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "t", {}), { type: "done" }],
      [...TEXT(0, "final"), { type: "done" }],
    ]);
    const agent = new Agent({
      env, model: "p/m", session: "wired", sessionDir: ROOT,
      context: [USER("go")], createIO: () => io,
    });
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");

    // synced onDone: the file already holds the full mirror — no manual flush
    const records = lines(agent.session.file);
    expect(records).toEqual(agent.context.slice(0)); // full ordered mirror
    expect(records.map((m) => m.type)).toEqual([2, 3, 4, 3]); // seed, assistant, tool result, assistant
  });

  test("resume restores the context; the next run continues it", async () => {
    const env = await testEnv();
    const io1 = scriptedIO([[...TEXT(0, "first answer"), { type: "done" }]]);
    const first = new Agent({
      env, model: "p/m", session: "cont", sessionDir: ROOT,
      context: [USER("q1")], createIO: () => io1,
    });
    await first.run();
    first.session.close();

    const io2 = scriptedIO([[...TEXT(0, "second answer"), { type: "done" }]]);
    const resumed = new Agent({
      env, model: "p/m", session: "cont", sessionDir: ROOT,
      context: [USER("q2")], createIO: () => io2,
    });
    // loaded history + fresh input CONTINUES the session
    expect(resumed.context).toEqual([
      USER("q1"),
      { type: 3, content: [{ type: "text", text: "first answer" }] },
      USER("q2"),
    ]);
    await resumed.run();
    expect(resumed.context.at(-1)).toEqual({ type: 3, content: [{ type: "text", text: "second answer" }] });
    expect(io2.writes[0].context).toHaveLength(3); // continued context went to the provider
    // the continuation reached the file
    resumed.session.close();
    const continued = SessionStore.resume({ id: "cont", dir: ROOT });
    expect(continued.context).toEqual(resumed.context);
  });

  test("no sessionId/session: purely in-memory, no files appear", async () => {
    const env = await testEnv();
    const io = scriptedIO([[{ type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("x")], createIO: () => io });
    await agent.run();
    expect(existsSync(ROOT)).toBe(false);
  });
});

describe("context merging at append (Agent + SessionStore)", () => {
  test("consecutive same-type appends merge into one message", () => {
    const store = new SessionStore({ id: "merge-1", dir: ROOT });
    store.append(USER("queued one"));
    store.append(USER("queued two"));
    expect(store.context).toHaveLength(1);
    expect(store.context[0].content).toEqual([{ type: "text", text: "queued one\nqueued two" }]);
    store.flush();
    expect(lines(store.file)).toHaveLength(1); // the merge persists
  });

  test("tool results never merge — call→answer linkage stays per-message", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "alpha", {}), ...TOOLCALL(1, "c2", "alpha", {})],
      [...TEXT(0, "done")],
    ]);
    env.registerTool?.("alpha", async () => "ok"); // programmatic tools when supported
    const agent = new Agent({ env, model: "p/m", createIO: () => io });
    agent._callTool = async () => "ok"; // bypass dispatch: linkage is what matters here
    await agent.run();
    const results = agent.context.filter((m) => m.type === 4);
    expect(results).toHaveLength(2); // one result per call, never folded
    expect(results.map((m) => m.callId)).toEqual(["c1", "c2"]);
  });

  test("a cancel-partial assistant message merges with the next turn's", async () => {
    const env = await testEnv();
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
    const assistants = agent.context.filter((m) => m.type === 3);
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toEqual([
      { type: "thinking", text: "half a thought\nthe rest" },
      { type: "text", text: "answer" },
    ]);
  });
});

describe("SessionStore.list / latest (session folder overview)", () => {
  const seed = async () => {
    const older = new SessionStore({ id: "older", dir: ROOT });
    older.append(USER("first question about apples and pears and more fruit besides"));
    older.close();
    await Bun.sleep(20); // distinct mtimes
    const newer = new SessionStore({ id: "newer", dir: ROOT });
    newer.append(USER("second question"));
    newer.append({ type: 3, content: [{ type: "text", text: "second answer" }] });
    newer.close();
  };

  test("lists sessions latest-first with message counts and first-user-message previews", async () => {
    await seed();
    const list = SessionStore.list({ dir: ROOT });
    expect(list.map((s) => s.id)).toEqual(["newer", "older"]);
    expect(list[0].messages).toBe(2);
    expect(list[0].preview).toBe("second question");
    expect(list[1].preview).toContain("first question about apples");
    expect(list[0].file).toContain("newer.jsonl"); // date + uuid8 prefix, then the given name
    expect(list[0].mtime).toBeGreaterThan(list[1].mtime);
  });

  test("long previews truncate with an ellipsis; a system-message-only session persists nothing", async () => {
    await seed();
    const verbose = new SessionStore({ id: "verbose", dir: ROOT });
    verbose.append(USER("x".repeat(200)));
    verbose.close();
    const empty = new SessionStore({ id: "system-only", dir: ROOT });
    empty.append({ type: 1, content: [{ type: "text", text: "no user here" }] });
    empty.close();
    // only system messages = the seeded prompt awaiting the first user
    // message — the conversation hasn't started, so no file exists
    expect(existsSync(empty.file)).toBe(false);
    const list = SessionStore.list({ dir: ROOT });
    const v = list.find((s) => s.id === "verbose");
    expect(v.preview.length).toBe(72);
    expect(v.preview.endsWith("…")).toBe(true);
    expect(list.find((s) => s.id === "system-only")).toBeUndefined();
  });

  test("latest() is the most recently modified session's id; a missing folder lists empty", async () => {
    expect(SessionStore.list({ dir: `${ROOT}/nope` })).toEqual([]);
    expect(SessionStore.latest({ dir: `${ROOT}/nope` })).toBeUndefined();
    await seed();
    expect(SessionStore.latest({ dir: ROOT })).toBe("newer");
  });

  test("listAsync exactly matches synchronous metadata, ordering, and previews", async () => {
    await seed();
    const foreign = new SessionStore({ id: "foreign-async", dir: ROOT, origin: `${ROOT}/elsewhere` });
    foreign.append(USER("foreign question"));
    foreign.close();
    const sync = SessionStore.list({ dir: ROOT, cwd: process.cwd() });
    expect(await SessionStore.listAsync({ dir: ROOT, cwd: process.cwd() })).toEqual(sync);
    expect(await SessionStore.listAsync({ dir: `${ROOT}/nope` })).toEqual([]);
  });
});

describe("Agent.newSession / forkSession anonymous semantics", () => {
  test("new and fork preserve the current SessionStore save setting", () => {
    const env = new Env({ settingsDir: ROOT, cwd: ROOT, settings: {} });
    const agent = new Agent({ env, session: "memory", sessionSave: false, createIO: () => null });
    expect(agent.newSession("next").id).toBe("next");
    expect(agent.sessionSave).toBe(false);
    expect(agent.fork("fork").id).toBe("fork");
    expect(agent.sessionSave).toBe(false);
    expect(existsSync(agent.session.dir)).toBe(false);
    agent.close();
  });
  test("anon/0/false all select an anonymous session; /session-new from anonymous STAYS anonymous", async () => {
    const env = await testEnv();
    const agent = new Agent({
      env, model: "p/m",
      session: new SessionStore({ id: "named", dir: ROOT }), createIO: () => null,
    });
    // the anonymous spellings
    for (const id of ["anon", "0", "false"]) {
      const result = agent.newSession(id);
      expect(result.anonymous).toBe(true);
      expect(agent.session).toBeNull();
      const named = agent.newSession(`n-${id}`); // back to persisted
      expect(named.anonymous).toBeUndefined();
      expect(agent.session.id).toBe(`n-${id}`);
    }
    // anonymous STAYS anonymous: no id from an anonymous session must
    // not silently start persisting
    agent.newSession("anon");
    const again = agent.newSession();
    expect(again.anonymous).toBe(true);
    expect(agent.session).toBeNull();
    // fork accepts the anon spelling too
    agent.newSession("named2");
    const forked = agent.fork("anon");
    expect(forked.anonymous).toBe(true);
    expect(agent.session).toBeNull();
  });
});

describe("Agent.resumeSession / listSessions / latestSessionId", () => {
  test("resumeSession switches the live context to the stored session's", async () => {
    const stored = new SessionStore({ id: "stored", dir: ROOT });
    stored.append(USER("stored question"));
    stored.append({ type: 3, content: [{ type: "text", text: "stored answer" }] });
    stored.close();

    const agent = new Agent({
      env: await testEnv(), model: "p/m",
      session: new SessionStore({ id: "live", dir: ROOT }), createIO: () => null,
    });
    expect(agent.context).toEqual([]);
    const result = agent.resumeSession("stored");
    expect(result.id).toBe("stored");
    expect(agent.session.id).toBe("stored");
    expect(agent.context.map((m) => m.type)).toEqual([2, 3]);
    expect(() => agent.resumeSession("missing")).toThrow(/no session "missing"/);
    expect(agent.session.id).toBe("stored"); // unchanged on failure
  });

  test("listSessions/latestSessionId read only the agent ORIGIN folder's sessions", async () => {
    const env = await testEnv();
    const a = new SessionStore({ id: "a", dir: ROOT, origin: env.cwd });
    a.append(USER("question a"));
    a.close();
    await Bun.sleep(20); // distinct mtimes
    const live = new SessionStore({ id: "b", dir: ROOT, origin: env.cwd });
    live.append(USER("question b"));
    live.close(); // only flushed sessions have a file to list
    // a session that ran in ANOTHER folder never lists for this project
    const foreign = new SessionStore({ id: "foreign", dir: ROOT, origin: process.cwd() });
    foreign.append(USER("elsewhere"));
    foreign.close();
    const agent = new Agent({
      env, model: "p/m",
      session: new SessionStore({ id: "c", dir: ROOT, origin: env.cwd }), createIO: () => null,
    });
    expect(agent.latestSessionId()).toBe("b"); // the newest file OF THIS ORIGIN
    const ids = agent.listSessions().map((s) => s.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("foreign"); // filtered by the origin metadata
    // an anonymous agent reads the same folder via its sessionDir
    const anon = new Agent({
      env, model: "p/m",
      sessionDir: ROOT, createIO: () => null,
    });
    expect(anon.listSessions().map((s) => s.id)).toContain("a");
    // an explicit id resumes even across origins (the user asked by name)
    const resumed = agent.resumeSession("foreign");
    expect(resumed.id).toBe("foreign");
  });

  test("resumeSession adopts the session's ORIGIN folder as the cwd (resume anywhere)", async () => {
    // a session recorded against ANOTHER folder: resuming it moves the
    // process (and the environment's project-folder surface) there —
    // the bins' shape, where env.cwd IS the process folder
    const elsewhere = `${ROOT}/elsewhere`;
    mkdirSync(elsewhere, { recursive: true });
    const foreign = new SessionStore({ id: "faraway", dir: ROOT, origin: elsewhere });
    foreign.append(USER("from another folder"));
    foreign.close();
    expect(SessionStore.originOf({ id: "faraway", dir: ROOT })).toBe(elsewhere);
    expect(SessionStore.originOf({ id: "missing", dir: ROOT })).toBeUndefined();

    const { Env } = await import("../lib/env.js");
    const env = new Env({ dir: ROOT, cwd: process.cwd(), settings: { providers: { p: { provider: "test", url: "test://script" } } }, settingsDir: ROOT });
    const agent = new Agent({
      env, model: "p/m",
      session: new SessionStore({ id: "home", dir: ROOT }), createIO: () => null,
    });
    const before = process.cwd();
    const elsewhereAbs = resolve(elsewhere); // BEFORE the chdir below
    try {
      const result = agent.resumeSession("faraway");
      expect(result.cwd).toBe(elsewhere);
      expect(result.originMissing).toBe(false);
      expect(process.cwd()).toBe(elsewhereAbs);
      expect(env.cwd).toBe(elsewhere); // the environment followed (the recorded origin)
      expect(env.environment.folders.find((f) => f.title === "project folder").path).toBe(elsewhere);
    } finally {
      process.chdir(before); // the rest of the suite runs from the project
    }
  });

  test("resumeSession on an EMBEDDED host (env.cwd elsewhere) adopts env-side only", async () => {
    // the process must NOT move when the environment doesn't track it
    const elsewhere = `${ROOT}/embedded-origin`;
    mkdirSync(elsewhere, { recursive: true });
    const foreign = new SessionStore({ id: "embedded", dir: ROOT, origin: elsewhere });
    foreign.append(USER("x"));
    foreign.close();
    const env = await testEnv(); // env.cwd is a temp folder, not the process's
    const agent = new Agent({
      env, model: "p/m",
      session: new SessionStore({ id: "emb-home", dir: ROOT }), createIO: () => null,
    });
    const before = process.cwd();
    const result = agent.resumeSession("embedded");
    expect(result.cwd).toBe(elsewhere);
    expect(process.cwd()).toBe(before); // untouched
    expect(env.cwd).toBe(elsewhere); // the environment adopted the origin
  });

  test("resumeSession with a VANISHED origin folder stays put and reports it", async () => {
    const gone = `${ROOT}/gone`;
    mkdirSync(gone, { recursive: true });
    const foreign = new SessionStore({ id: "ghost", dir: ROOT, origin: gone });
    foreign.append(USER("from a deleted folder"));
    foreign.close();
    rmSync(gone, { recursive: true, force: true });

    const agent = new Agent({
      env: await testEnv(), model: "p/m",
      session: new SessionStore({ id: "home2", dir: ROOT }), createIO: () => null,
    });
    const before = process.cwd();
    const result = agent.resumeSession("ghost");
    expect(result.originMissing).toBe(true);
    expect(result.cwd).toBeUndefined();
    expect(process.cwd()).toBe(before); // stayed
    expect(agent.session.id).toBe("ghost"); // the session itself resumed fine
  });

  test("adoptResumeOrigin (the bins' --resume <id>): chdir, latest/anonymous never move, failures are clear", () => {
    // the helper reads the default namespace sessions folder — point
    // the settings variable at a throwaway settings home
    const settingsHome = `${ROOT}/settings-home`;
    const sessionsDir = `${settingsHome}/${NAMES.sessionsDir}`;
    const elsewhere = `${ROOT}/bin-resume`;
    mkdirSync(elsewhere, { recursive: true });
    const foreign = new SessionStore({ id: "binres", dir: sessionsDir, origin: elsewhere });
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
      const store = new SessionStore({ id, dir: target });
      store.append(USER("q"));
      store.close();
    }
    writeFileSync(`${target}/keep.txt`, "foreign");
    writeFileSync(`${target}/notes.jsonl`, "not ours"); // foreign .jsonl: no metadata header
    expect(SessionStore.deleteAll({ dir: target })).toEqual({ deleted: 2 });
    expect(existsSync(`${target}/x.jsonl`)).toBe(false); // new naming: no prefix
    expect(existsSync(`${target}/keep.txt`)).toBe(true); // foreign files stay
    expect(existsSync(`${target}/notes.jsonl`)).toBe(true); // foreign .jsonl stays too
    expect(SessionStore.deleteAll({ dir: target })).toEqual({ deleted: 0 });
  });
});
