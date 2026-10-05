// test/web-app-server.test.js — the web front end's server/session/protocol,
// over the real public Agent/Env surfaces (never GTUI). The SPA is a client
// of these packets; every check here drives the wire, not the DOM.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { serve, MAX_WS_PAYLOAD_LENGTH } from "../lib/app/web/server.js";
import { parseClientMessage } from "../lib/app/web/protocol.js";
import { AgentSession } from "../lib/app/web/session.js";
import { renderMarkdown } from "../lib/app/web/public/markdown.js";
import Agent from "../lib/agent.js";
import Context from "../lib/context.js";
import { TEXT, TOOLCALL, scriptedIO, testEnv } from "./fakes.js";
import { authSetOf, namesOf, providerAdd } from "./env-internals.js";

const { messageUser } = Context;

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = (web) => `http://127.0.0.1:${web.port}`;
function connect(web, received = [], path = "/ws", host = "127.0.0.1") {
  const socket = new WebSocket(`ws://127.0.0.1:${web.port}${path}`, { headers: { Origin: `http://${host}:${web.port}`, Host: `${host}:${web.port}` } });
  socket.onmessage = (event) => received.push(JSON.parse(event.data));
  return new Promise((resolve, reject) => { socket.onopen = () => resolve(socket); socket.onerror = reject; });
}
const scripted = (env, lines, reply) => {
  const io = scriptedIO([[{ type: "start" }, ...TEXT(0, reply), { type: "done" }]]);
  return new Agent({ env, model: "p/m", context: [], createIO: () => io });
};

test("protocol validates client packets and rejects malformed input", () => {
  expect(parseClientMessage(JSON.stringify({ type: "chat.submit", text: "hi" }))).toEqual({ type: "chat.submit", text: "hi" });
  expect(parseClientMessage(JSON.stringify({ type: "chat.submit", text: "", attachments: ["a"] }))).toEqual({ type: "chat.submit", text: "", attachments: ["a"] });
  expect(() => parseClientMessage(JSON.stringify({ type: "chat.submit", text: "hi", attachments: ["a", "a"] }))).toThrow();
  expect(parseClientMessage(JSON.stringify({ type: "chat.unqueue" }))).toEqual({ type: "chat.unqueue" });
  expect(parseClientMessage(JSON.stringify({ type: "settings.safe", on: true })).on).toBe(true);
  expect(parseClientMessage(JSON.stringify({ type: "settings.session-save", on: true }))).toEqual({ type: "settings.session-save", on: true });
  expect(parseClientMessage(JSON.stringify({ type: "question.answer", requestId: "q1", answers: null })).answers).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "session.fork", id: "branch" }))).toEqual({ type: "session.fork", id: "branch" });
  expect(parseClientMessage(JSON.stringify({ type: "session.close", agentId: "agent-1" }))).toEqual({ type: "session.close", agentId: "agent-1" });
  expect(parseClientMessage(JSON.stringify({ type: "context.edit-text", messageIndex: 0, blockIndex: 0, text: "revised" }))).toMatchObject({ type: "context.edit-text", text: "revised" });
  expect(parseClientMessage(JSON.stringify({ type: "tool.call", name: "read", args: { path: "README.md" } }))).toMatchObject({ type: "tool.call", name: "read" });
  expect(() => parseClientMessage("{}")).toThrow();
  expect(() => parseClientMessage(JSON.stringify({ type: "chat.submit" }))).toThrow();
  expect(() => parseClientMessage(JSON.stringify({ type: "nope" }))).toThrow();
  expect(() => parseClientMessage(JSON.stringify({ type: "question.answer", requestId: "q1", answers: "x" }))).toThrow();
});

test("hello names the served project; root is the all-projects view, the project URL its own view", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "unused");
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [], scoped = [];
  try {
    const socket = await connect(web, received); await tick();
    const name = env.cwd.split(/[\\/]/).filter(Boolean).at(-1);
    expect(received.find((m) => m.type === "hello")).toMatchObject({ projects: [{ name, path: env.cwd, url: `/${name}/`, current: true }], scope: "all", canManageProjects: true });
    expect(received.find((m) => m.type === "hello").agent.project).toBe(env.cwd);
    const own = await connect(web, scoped, `/${name}/ws`); await tick();
    expect(scoped.find((m) => m.type === "hello")).toMatchObject({ scope: "project", agent: { project: env.cwd } });
    socket.close(); own.close();
  } finally { web.stop(); }
});

test("project.add gates local connections and validates directories; broadcast and prefixed routing work", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, session: { kind: "anonymous" }, envOptions: { settingsDir: env._settingsDir, settings: { providers: { p: { provider: "test", url: "test://script" } } } } });
  const root = [], alternate = [];
  const waitFor = async (messages, type) => { const deadline = Date.now() + 4000; while (Date.now() < deadline && !messages.some((m) => m.type === type)) await tick(); return messages.findLast((m) => m.type === type); };
  try {
    const socket = await connect(web, root);
    expect((await waitFor(root, "hello")).canManageProjects).toBe(true);
    const send = (path) => socket.send(JSON.stringify({ type: "project.add", path }));
    send("relative"); expect((await waitFor(root, "error")).message).toContain("absolute"); root.length = 0;
    send("~other/x"); expect((await waitFor(root, "error")).message).toContain("absolute"); root.length = 0;
    const absolute = (await import("node:path")).resolve(env.cwd);
    send(`${absolute}/missing`); expect((await waitFor(root, "error")).message).toContain("does not exist"); root.length = 0;
    send(absolute); expect((await waitFor(root, "error")).message).toContain("already served"); root.length = 0;
    const path = `${absolute}/other`; (await import("node:fs")).mkdirSync(path);
    send(path);
    // The all-projects view switches to the added project in place.
    const moved = await waitFor(root, "hello");
    expect(moved.projects.find((p) => p.current)).toMatchObject({ url: "/other/", path });
    expect(moved).toMatchObject({ scope: "all", agent: { project: path } });
    expect(root.findLast((m) => m.type === "projects")?.projects).toHaveLength(2);
    // A project view navigates to the added project instead.
    const startup = root.find((m) => m.type === "projects").projects.find((p) => p.path !== path);
    const scopedReceived = [];
    const scoped = await connect(web, scopedReceived, startup.url + "ws");
    const third = `${absolute}/third`; (await import("node:fs")).mkdirSync(third);
    scoped.send(JSON.stringify({ type: "project.add", path: third }));
    expect((await waitFor(scopedReceived, "project.added")).url).toBe("/third/");
    scoped.close();
    expect((await fetch(`${origin(web)}/other`, { redirect: "manual" })).status).toBe(301);
    expect((await fetch(`${origin(web)}/other/app.js`)).status).toBe(200);
    expect((await fetch(`${origin(web)}/not-served/app.js`)).status).toBe(404);
    expect((await fetch(`${origin(web)}/not-served/style.css`)).status).toBe(404);
    expect((await fetch(`${origin(web)}/not-served`)).status).toBe(404);
    const second = await connect(web, alternate, "/other/ws");
    expect((await waitFor(alternate, "hello")).projects.find((p) => p.current)?.url).toBe("/other/");
    send(path); expect((await waitFor(root, "error")).message).toContain("already served");
    second.close(); socket.close();
  } finally { web.stop(); }
});

test("the all-projects view lists, switches, and manages agents across projects", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, session: { kind: "anonymous" }, envOptions: { settingsDir: env._settingsDir, settings: { providers: { p: { provider: "test", url: "test://script" } } } } });
  const all = [], mine = [];
  const waitFor = async (messages, test) => { const deadline = Date.now() + 4000; while (Date.now() < deadline && !messages.some(test)) await tick(); return messages.findLast(test); };
  const sessionsWith = (count) => (m) => m.type === "sessions" && m.agents.length === count;
  try {
    const { resolve } = await import("node:path");
    const path = `${resolve(env.cwd)}/second`; (await import("node:fs")).mkdirSync(path);
    const root = await connect(web, all);
    const first = (await waitFor(all, (m) => m.type === "hello")).agent;
    root.send(JSON.stringify({ type: "project.add", path }));
    // Moving to the new project opens its first agent (none yet: a new one).
    const second = (await waitFor(all, (m) => m.type === "hello" && m.agent.project === path)).agent;
    const listed = await waitFor(all, sessionsWith(2));
    expect(listed.agents.map((a) => [a.project, a.id])).toEqual([[env.cwd, first.id], [path, second.id]]);
    expect(listed.agents.find((a) => a.active).project).toBe(path);
    // A project view sees only its own agents, and cannot address others.
    const scoped = await connect(web, mine, "/second/ws");
    expect((await waitFor(mine, (m) => m.type === "sessions")).agents.map((a) => a.project)).toEqual([path]);
    scoped.send(JSON.stringify({ type: "session.switch", agentId: first.id, project: env.cwd }));
    expect((await waitFor(mine, (m) => m.type === "error")).message).toBe("unknown agent");
    // Switching to another project's agent moves the socket and updates the project indicator.
    all.length = 0;
    root.send(JSON.stringify({ type: "session.switch", agentId: first.id, project: env.cwd }));
    const back = await waitFor(all, (m) => m.type === "hello");
    expect(back.agent).toMatchObject({ id: first.id, project: env.cwd });
    expect(back.projects.find((p) => p.current).path).toBe(env.cwd);
    // Selecting a project opens its first agent; the same project is a no-op.
    all.length = 0;
    root.send(JSON.stringify({ type: "project.select", path }));
    expect((await waitFor(all, (m) => m.type === "hello")).agent).toMatchObject({ id: second.id, project: path });
    // Agent changes in one project refresh all-projects viewers attached elsewhere.
    root.send(JSON.stringify({ type: "session.switch", agentId: first.id, project: env.cwd }));
    await waitFor(all, (m) => m.type === "hello" && m.agent.project === env.cwd);
    all.length = 0;
    scoped.send(JSON.stringify({ type: "session.add" }));
    expect((await waitFor(all, sessionsWith(3))).agents.filter((a) => a.project === path)).toHaveLength(2);
    // Managing another project's agent runs in that project.
    all.length = 0;
    root.send(JSON.stringify({ type: "agent.rename", agentId: second.id, name: "Renamed", project: path }));
    expect((await waitFor(all, (m) => m.type === "sessions" && m.agents.some((a) => a.name === "Renamed"))).agents.find((a) => a.name === "Renamed").project).toBe(path);
    root.send(JSON.stringify({ type: "session.close", agentId: "Renamed", project: path }));
    expect((await waitFor(all, sessionsWith(2))).agents.every((a) => a.name !== "Renamed")).toBe(true);
    root.send(JSON.stringify({ type: "session.switch", agentId: "missing", project: path }));
    expect((await waitFor(all, (m) => m.type === "error")).message).toBe("unknown agent");
    root.close(); scoped.close();
  } finally { web.stop(); }
});

test("the all-projects view lists and manages every project's saved sessions; a project view only its own", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, session: { kind: "anonymous" }, envOptions: { settingsDir: env._settingsDir, settings: { providers: { p: { provider: "test", url: "test://script" } } } } });
  const all = [], mine = [];
  const waitFor = async (messages, check) => { const deadline = Date.now() + 4000; while (Date.now() < deadline && !messages.some(check)) await tick(); return messages.findLast(check); };
  const save = (id, origin) => { const context = new Context({ id, dir: env.settings.sessions, origin, save: true, messages: [messageUser(`hello ${id}`)] }); context.flush(); };
  const ids = (packet, project) => packet.recent.filter((s) => s.project === project).map((s) => s.id).sort();
  try {
    const { resolve } = await import("node:path");
    const path = `${resolve(env.cwd)}/second`; (await import("node:fs")).mkdirSync(path);
    const root = await connect(web, all);
    await waitFor(all, (m) => m.type === "hello");
    root.send(JSON.stringify({ type: "project.add", path }));
    await waitFor(all, (m) => m.type === "hello" && m.agent.project === path);
    const home = resolve(env.cwd);
    save("home-a", home); save("home-b", home); save("second-a", path);
    all.length = 0;
    root.send(JSON.stringify({ type: "session.list" }));
    const listed = await waitFor(all, (m) => m.type === "sessions" && m.recent.length >= 3);
    expect(ids(listed, env.cwd)).toEqual(["home-a", "home-b"]);
    expect(ids(listed, path)).toEqual(["second-a"]);
    // A project view lists only its own saved sessions.
    const scoped = await connect(web, mine, "/second/ws");
    const own = await waitFor(mine, (m) => m.type === "sessions");
    expect(own.recent.map((s) => s.project)).toEqual([path]);
    // Resuming another project's session moves the socket there, onto a new agent.
    all.length = 0;
    root.send(JSON.stringify({ type: "session.resume", id: "home-a", project: env.cwd }));
    expect((await waitFor(all, (m) => m.type === "hello")).agent).toMatchObject({ project: env.cwd, session: "home-a" });
    // Renaming and deleting another project's saved session run in that project.
    all.length = 0;
    root.send(JSON.stringify({ type: "session.rename", id: "second-a", name: "second-b", project: path }));
    expect(ids(await waitFor(all, (m) => m.type === "sessions" && m.recent.some((s) => s.id === "second-b")), path)).toEqual(["second-b"]);
    root.send(JSON.stringify({ type: "session.delete", id: "second-b", project: path }));
    expect(ids(await waitFor(all, (m) => m.type === "sessions" && !m.recent.some((s) => s.id === "second-b")), path)).toEqual([]);
    root.send(JSON.stringify({ type: "session.resume", id: "missing", project: path }));
    expect((await waitFor(all, (m) => m.type === "error")).message).toBe("unknown session");
    root.close(); scoped.close();
  } finally { web.stop(); }
});

test("group views show their member projects; a project URL wins over a group URL; leaving the group moves its viewers", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, session: { kind: "anonymous" }, envOptions: { settingsDir: env._settingsDir, settings: { providers: { p: { provider: "test", url: "test://script" } } } } });
  const all = [], grouped = [];
  const waitFor = async (messages, check) => { const deadline = Date.now() + 4000; while (Date.now() < deadline && !messages.some(check)) await tick(); return messages.findLast(check); };
  try {
    const { resolve } = await import("node:path");
    const { mkdirSync } = await import("node:fs");
    const home = resolve(env.cwd);
    const red = `${home}/red`, blue = `${home}/blue`, clash = `${home}/group:blue`;
    for (const path of [red, blue, clash]) mkdirSync(path);
    const root = await connect(web, all);
    await waitFor(all, (m) => m.type === "hello");
    for (const path of [red, blue]) { root.send(JSON.stringify({ type: "project.add", path })); await waitFor(all, (m) => m.type === "hello" && m.agent.project === path); }
    expect((await fetch(`${origin(web)}/group:warm/`)).status).toBe(404); // no member yet
    for (const path of [home, red]) root.send(JSON.stringify({ type: "project.group", path, group: "warm", member: true }));
    await waitFor(all, (m) => m.type === "projects" && m.projects.filter((p) => p.groups.includes("warm")).length === 2);
    expect(() => parseClientMessage(JSON.stringify({ type: "project.group", path: red, group: "a/b", member: true }))).toThrow("no /");
    // The group view: scope "group", only member projects' agents; non-members are out of reach.
    expect((await fetch(`${origin(web)}/group:warm`, { redirect: "manual" })).headers.get("location")).toBe("/group:warm/");
    expect((await fetch(`${origin(web)}/group:warm/`)).status).toBe(200);
    const view = await connect(web, grouped, "/group:warm/ws");
    const hello = await waitFor(grouped, (m) => m.type === "hello");
    expect(hello).toMatchObject({ scope: "group", group: "warm" });
    const sessions = await waitFor(grouped, (m) => m.type === "sessions" && m.agents.length > 0);
    expect([...new Set(sessions.agents.map((a) => a.project))].sort()).toEqual([home, red].sort());
    view.send(JSON.stringify({ type: "project.select", path: blue }));
    expect((await waitFor(grouped, (m) => m.type === "error")).message).toBe("unknown project");
    view.send(JSON.stringify({ type: "project.select", path: red }));
    expect((await waitFor(grouped, (m) => m.type === "hello" && m.agent.project === red)).scope).toBe("group");
    // Leaving the group moves its viewers onto another member.
    grouped.length = 0;
    root.send(JSON.stringify({ type: "project.group", path: red, group: "warm", member: false }));
    expect((await waitFor(grouped, (m) => m.type === "hello")).agent.project).toBe(home);
    // A served project whose URL is /group:blue/ wins over the group view.
    root.send(JSON.stringify({ type: "project.group", path: blue, group: "blue", member: true }));
    root.send(JSON.stringify({ type: "project.add", path: clash }));
    const listed = await waitFor(all, (m) => m.type === "projects" && m.projects.some((p) => p.path === clash));
    expect(listed.projects.find((p) => p.path === clash).url).toBe("/group%3Ablue/");
    const clashView = [];
    const clashed = await connect(web, clashView, "/group:blue/ws");
    expect((await waitFor(clashView, (m) => m.type === "hello"))).toMatchObject({ scope: "project", agent: { project: clash } });
    root.close(); view.close(); clashed.close();
  } finally { web.stop(); }
});

test("/session-resume reaches any open project's saved session: in place in a multi-project view, by navigation elsewhere", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, session: { kind: "anonymous" }, envOptions: { settingsDir: env._settingsDir, settings: { providers: { p: { provider: "test", url: "test://script" } } } } });
  const all = [], mine = [], landed = [];
  const waitFor = async (messages, check) => { const deadline = Date.now() + 4000; while (Date.now() < deadline && !messages.some(check)) await tick(); return messages.findLast(check); };
  try {
    const { resolve } = await import("node:path");
    const path = `${resolve(env.cwd)}/second`; (await import("node:fs")).mkdirSync(path);
    const root = await connect(web, all);
    await waitFor(all, (m) => m.type === "hello");
    root.send(JSON.stringify({ type: "project.add", path }));
    await waitFor(all, (m) => m.type === "hello" && m.agent.project === path);
    for (const [id, origin] of [["far-a", path], ["far-b", path]]) new Context({ id, dir: env.settings.sessions, origin, save: true, messages: [messageUser(id)] }).flush();
    // The root view (now in `second`) moves home, then resumes `second`'s session in place.
    root.send(JSON.stringify({ type: "project.select", path: env.cwd }));
    await waitFor(all, (m) => m.type === "hello" && m.agent.project === env.cwd);
    all.length = 0;
    root.send(JSON.stringify({ type: "chat.submit", text: "/session-resume far-a" }));
    expect((await waitFor(all, (m) => m.type === "hello")).agent).toMatchObject({ project: path, session: "far-a" });
    // A project view navigates to the owning project's URL, which resumes the session on connect.
    const homeUrl = all.findLast((m) => m.type === "hello").projects.find((p) => p.path === env.cwd).url;
    const scoped = await connect(web, mine, `${homeUrl}ws`);
    expect((await waitFor(mine, (m) => m.type === "hello")).scope).toBe("project");
    scoped.send(JSON.stringify({ type: "chat.submit", text: "/session-resume far-b" }));
    expect((await waitFor(mine, (m) => m.type === "navigate")).url).toBe("/second/?resume=far-b");
    const arrived = await connect(web, landed, "/second/ws?resume=far-b");
    expect((await waitFor(landed, (m) => m.type === "hello")).agent).toMatchObject({ project: path, session: "far-b" });
    // An unknown id stays this project's resume (and its error); an unknown ?resume= opens normally.
    mine.length = 0;
    scoped.send(JSON.stringify({ type: "chat.submit", text: "/session-resume nowhere" }));
    expect((await waitFor(mine, (m) => m.type === "error")).message).toContain("nowhere");
    const plain = [];
    const unknown = await connect(web, plain, "/second/ws?resume=nowhere");
    expect((await waitFor(plain, (m) => m.type === "hello")).agent.session).not.toBe("nowhere");
    root.close(); scoped.close(); arrived.close(); unknown.close();
  } finally { web.stop(); }
});

test("projects are pinned to projects.json, served at the next start, and removed with their viewers redirected", async () => {
  const env = await testEnv();
  const { resolve, join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const envOptions = { settingsDir: env._settingsDir, settings: { providers: { p: { provider: "test", url: "test://script" } } } };
  const path = `${resolve(env.cwd)}/pinned`; mkdirSync(path);
  const waitFor = async (messages, check) => { const deadline = Date.now() + 4000; while (Date.now() < deadline && !messages.some(check)) await tick(); return messages.findLast(check); };
  const listed = (messages, pinned) => (m) => m.type === "projects" && m.projects.find((p) => p.path === path)?.pinned === pinned;
  const projectsFile = () => JSON.parse(readFileSync(join(env._settingsDir, "projects.json"), "utf8")).projects;
  let web = await serve({ port: 0, env, session: { kind: "anonymous" }, envOptions });
  const first = [];
  try {
    const root = await connect(web, first);
    root.send(JSON.stringify({ type: "project.add", path }));
    await waitFor(first, (m) => m.type === "hello" && m.agent.project === path);
    root.send(JSON.stringify({ type: "project.pin", path, pinned: true }));
    await waitFor(first, listed(first, true));
    await tick(50); // coalesced settings write
    // the pin seeds the model its agent runs; the listed name is env.name
    expect(Object.keys(projectsFile()[path].models)).toEqual([`p/${first.findLast((m) => m.type === "hello").agent.model}`]);
    expect(first.findLast(listed(first, true)).projects.find((p) => p.path === path).name).toBe("pinned");
    // groups live in the pin record: joining lists and persists them, leaving the last drops the key
    const grouped = (names) => (m) => m.type === "projects" && JSON.stringify(m.projects.find((p) => p.path === path)?.groups) === JSON.stringify(names);
    root.send(JSON.stringify({ type: "project.group", path, group: "ruby", member: true }));
    root.send(JSON.stringify({ type: "project.group", path, group: "c", member: true }));
    await waitFor(first, grouped(["c", "ruby"]));
    await tick(50);
    expect(projectsFile()[path].groups).toEqual({ ruby: true, c: true });
    root.send(JSON.stringify({ type: "project.group", path, group: "c", member: false }));
    root.send(JSON.stringify({ type: "project.group", path, group: "ruby", member: false }));
    await waitFor(first, grouped([]));
    await tick(50);
    expect(projectsFile()[path].groups).toBeUndefined();
    expect(projectsFile()[path].models).toBeDefined();
    root.close();
  } finally { web.stop(); }
  env.close(); // one open Env per folder: the restarted server opens the folder again

  // A new server with the same user settings serves the pinned project from the start.
  const restarted = new (await import("../lib/env.js")).Env({ dir: env._dir, cwd: env.cwd, settingsDir: env._settingsDir, settings: { providers: { p: { provider: "test", url: "test://script" } } } });
  web = await serve({ port: 0, env: restarted, session: { kind: "anonymous" }, envOptions });
  const all = [], scoped = [];
  try {
    const root = await connect(web, all);
    const hello = await waitFor(all, (m) => m.type === "hello");
    expect(hello.projects.find((p) => p.path === path)).toMatchObject({ pinned: true, url: "/pinned/" });
    const own = await connect(web, scoped, "/pinned/ws");
    await waitFor(scoped, (m) => m.type === "hello");
    root.send(JSON.stringify({ type: "project.select", path }));
    await waitFor(all, (m) => m.type === "hello" && m.agent.project === path);
    all.length = 0;
    root.send(JSON.stringify({ type: "project.remove", path }));
    // the project view is redirected; the all-projects view moves to a served project
    expect((await waitFor(scoped, (m) => m.type === "project.removed")).url).toBe("/");
    expect((await waitFor(all, (m) => m.type === "hello")).agent.project).toBe(restarted.cwd);
    expect((await waitFor(all, (m) => m.type === "projects" && m.projects.length === 1)).projects[0].path).toBe(restarted.cwd);
    await tick(50);
    expect(projectsFile()[path]).toBeUndefined();
    root.send(JSON.stringify({ type: "project.remove", path: restarted.cwd }));
    expect((await waitFor(all, (m) => m.type === "error")).message).toContain("last served project");
    root.close(); own.close();
  } finally { web.stop(); }
});

test("project.add denies a non-loopback Host even when its peer is loopback", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  const received = [];
  try {
    const socket = await connect(web, received, "/ws", "localhost");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "hello")) await tick();
    expect(received.find((m) => m.type === "hello").canManageProjects).toBe(true);
    socket.close();
    // Host allowlist accepts the bound machine name, but it is not a loopback name.
    const { hostname } = await import("node:os");
    if (["localhost", "127.0.0.1"].includes(hostname().toLowerCase())) return;
    const count = received.filter((m) => m.type === "hello").length;
    const remote = await connect(web, received, "/ws", hostname());
    while (Date.now() < deadline && received.filter((m) => m.type === "hello").length === count) await tick();
    expect(received.findLast((m) => m.type === "hello").canManageProjects).toBe(false);
    remote.send(JSON.stringify({ type: "project.add", path: env.cwd }));
    while (Date.now() < deadline && !received.some((m) => m.type === "error")) await tick();
    expect(received.findLast((m) => m.type === "error")?.message).toContain("local connection");
    remote.close();
  } finally { web.stop(); }
});

test("uploads are origin and connection bound, bounded, and consumed as text-first binary blocks", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "uploaded");
  const web = await serve({ port: 0, env, uploadLimits: { fileBytes: 8, totalBytes: 16 }, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received); await tick();
    const key = received.find((m) => m.type === "hello")?.uploadKey;
    expect(key).toMatch(/^[0-9a-f]{48}$/);
    const form = new FormData(); form.append("file", new File(["data"], "note.txt", { type: "text/plain" }));
    expect((await fetch(`${origin(web)}/upload`, { method: "POST", body: form })).status).toBe(403);
    const response = await fetch(`${origin(web)}/upload`, { method: "POST", headers: { Origin: origin(web), "X-Omoya-Upload": key }, body: form });
    expect(response.status).toBe(200);
    const upload = await response.json();
    socket.send(JSON.stringify({ type: "chat.submit", text: "read this", attachments: [upload.id] }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !agent.context.messages().some((message) => message.type === 2 && message.content.length === 2)) await tick();
    const user = agent.context.messages().findLast((message) => message.type === 2);
    expect(user.content.map((block) => block.type)).toEqual(["text", "binary"]);
    expect(Buffer.from(user.content[1].content, "base64").toString()).toBe("data");
    socket.close();
  } finally { web.stop(); }
});

test("context images replay as immutable capability media URLs", async () => {
  const env = await testEnv();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
  const context = [
    { type: 2, content: [{ type: "text", text: "look" }, { type: "binary", mimetype: "image/png", filename: "shot.png", content: png.toString("base64") }, { type: "binary", mimetype: "application/pdf", filename: "doc.pdf", content: "AAAA" }] },
    { type: 3, content: [{ type: "toolCall", callId: "c1", name: "read", arguments: {} }] },
    { type: 4, callId: "c1", name: "read", content: [{ type: "text", text: "ok" }, { type: "image", mimetype: "image/svg+xml", content: svg.toString("base64") }] },
  ];
  const agent = new Agent({ env, model: "p/m", context, createIO: () => scriptedIO([]) });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received); await tick();
    const history = received.find((m) => m.type === "hello").history;
    const [image, pdf] = history.find((block) => block.kind === "user").attachments;
    expect(image).toMatchObject({ name: "shot.png", mime: "image/png", size: png.length });
    expect(pdf).toEqual({ name: "doc.pdf", mime: "application/pdf", size: 3 });
    expect(JSON.stringify(history)).not.toContain(png.toString("base64"));
    const response = await fetch(`${origin(web)}/${image.url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
    const tool = history.find((block) => block.kind === "tool-answer").attachments[0];
    expect(tool.mime).toBe("image/svg+xml");
    expect(await (await fetch(`${origin(web)}/${tool.url}`)).text()).toBe(svg.toString());
    // A wrong capability, a stale content version, or a non-image block misses.
    const [, key, m, b, version] = image.url.split("/");
    expect((await fetch(`${origin(web)}/media/${"0".repeat(48)}/${m}/${b}/${version}`)).status).toBe(404);
    expect((await fetch(`${origin(web)}/media/${key}/${m}/${b}/0`)).status).toBe(404);
    expect((await fetch(`${origin(web)}/media/${key}/0/2/${version}`)).status).toBe(404);
    expect((await fetch(origin(web))).headers.get("content-security-policy")).toContain("img-src 'self'");
    socket.close();
  } finally { web.stop(); }
});

test("the context inspector previews file blocks and display images without their bytes", async () => {
  const env = await testEnv();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]).toString("base64");
  const gif = Buffer.from("GIF89a-display").toString("base64");
  const context = [
    { type: 2, content: [{ type: "text", text: "look" }, { type: "binary", mimetype: "image/png", filename: "shot.png", content: png }] },
    { type: 3, content: [{ type: "toolCall", callId: "c1", name: "snap", arguments: {} }] },
    { type: 4, callId: "c1", name: "snap", content: [{ type: "text", text: "ok" }], display: [{ type: "image", mimetype: "image/gif", content: gif }] },
  ];
  const agent = new Agent({ env, model: "p/m", context, createIO: () => scriptedIO([]) });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received); await tick();
    socket.send(JSON.stringify({ type: "context.inspect" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "context")) await tick();
    const packet = received.find((m) => m.type === "context");
    expect(JSON.stringify(packet)).not.toContain(png);
    expect(JSON.stringify(packet)).not.toContain(gif);
    const image = packet.blocks[0].content[1];
    expect(image).toMatchObject({ text: null, attachment: { name: "shot.png", mime: "image/png", size: 11 }, data: { filename: "shot.png", content: "<11 bytes, base64 omitted>" } });
    expect(Buffer.from(await (await fetch(`${origin(web)}/${image.attachment.url}`)).arrayBuffer()).toString("base64")).toBe(png);
    const display = packet.blocks[2].content.find((block) => block.viewerType === "tool display");
    expect(display).toMatchObject({ blockIndex: 1, text: null, attachment: { mime: "image/gif" } });
    expect(Buffer.from(await (await fetch(`${origin(web)}/${display.attachment.url}`)).arrayBuffer()).toString("base64")).toBe(gif);
    socket.close();
  } finally { web.stop(); }
});

test("live tool results send image URLs instead of image bytes", async () => {
  const env = await testEnv();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]).toString("base64");
  env.toolAdd("snap", async () => ({ content: [{ type: "image", mimetype: "image/png", content: png }] }), {
    description: "Returns an image.", inputSchema: { type: "object", properties: {} }, safe: true,
  });
  const io = scriptedIO([
    [{ type: "start" }, ...TOOLCALL(0, "c1", "snap", {}), { type: "done" }],
    [{ type: "start" }, ...TEXT(0, "seen"), { type: "done" }],
  ]);
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received); await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "take one" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "tool.result")) await tick();
    const packet = received.find((m) => m.type === "tool.result");
    expect(JSON.stringify(packet.result)).not.toContain(png);
    expect(packet.attachments).toMatchObject([{ mime: "image/png", size: 12 }]);
    const response = await fetch(`${origin(web)}/${packet.attachments[0].url}`);
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(png);
    socket.close();
  } finally { web.stop(); }
});

test("server enforces origin, frame size, and serves the SPA with CSP", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  try {
    const home = await fetch(origin(web));
    expect(home.status).toBe(200);
    expect(home.headers.get("content-security-policy")).toContain("default-src");
    expect((await fetch(`${origin(web)}/app.js`)).headers.get("content-type")).toContain("javascript");
    const copyModule = await fetch(`${origin(web)}/copy-markdown.js`);
    expect(copyModule.status).toBe(200);
    expect(copyModule.headers.get("content-type")).toContain("javascript");
    expect(await copyModule.text()).toContain("selectedMarkdown");
    const logo = await fetch(`${origin(web)}/logo.svg`);
    expect(logo.headers.get("content-type")).toContain("image/svg+xml");
    expect(await logo.text()).toContain("Omoya logo");
    expect((await fetch(`${origin(web)}/markdown/inline.js`)).status).toBe(200); // shared with the TUI
    for (const path of ["/..%2Fhost.js", "/app/..%2F..%2Fhost.js", "/.hidden.js", "/AI-MEMORY.md", "/app/missing.js", "/style.css.map"]) {
      expect((await fetch(`${origin(web)}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${origin(web)}/ws`)).status).toBe(403);
    expect((await fetch(`${origin(web)}/ws`, { headers: { Origin: "http://evil.invalid" } })).status).toBe(403);
    const socket = await connect(web);
    const closed = new Promise((resolve) => { socket.onclose = (event) => resolve(event.code); });
    socket.send("x".repeat(MAX_WS_PAYLOAD_LENGTH + 1));
    expect([1009, 1006]).toContain(await closed);
  } finally { web.stop(); }
});

test("server refuses foreign Host names (DNS rebinding) and accepts this machine's names", async () => {
  // A rebinding page reaches the loopback port from the local browser, so the
  // peer address is loopback; only the Host name it used gives it away.
  const { hostname, networkInterfaces } = await import("node:os");
  const env = await testEnv();
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  const as = (host, path = "/", extra = {}) => fetch(`${origin(web)}${path}`, { headers: { Host: host, ...extra } });
  try {
    const rebound = `evil.example:${web.port}`;
    expect((await as(rebound)).status).toBe(403);
    expect((await as(rebound, "/ws", { Origin: `http://${rebound}` })).status).toBe(403);
    expect((await as(rebound, "/upload", { Origin: `http://${rebound}` })).status).toBe(403);
    expect((await as(`127.0.0.1:${web.port + 1}`)).status).toBe(403); // not our port
    // Allowed names: a non-upgrade /ws request passes the Host/Origin gate and fails the upgrade (400).
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]", hostname()]) {
      expect((await as(`${host}:${web.port}`)).status, host).toBe(200);
      expect((await as(`${host}:${web.port}`, "/ws", { Origin: `http://${host.toLowerCase()}:${web.port}` })).status, host).toBe(400); // browsers lowercase Origin
    }
    const lan = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal);
    if (lan) expect((await as(`${lan.address}:${web.port}`)).status).toBe(200); // --host 0.0.0.0 LAN use
  } finally { web.stop(); }
});

test("completion reconciles final Markdown when assembled text differs from streamed text", async () => {
  const env = await testEnv();
  const io = {
    state: "idle",
    async write(_context, callbacks) {
      callbacks.onStart?.({ type: "start" });
      callbacks.onTextDelta?.({ type: "text_delta", contentIndex: 0, text: "**draft" });
      return { type: "done", message: { type: 3, content: [{ type: "text", text: "**final** and $x^2$" }] } };
    },
    async close() { this.state = "closed"; },
  };
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const session = new AgentSession(agent);
  const packets = [];
  session.addSink((packet) => packets.push(packet));
  try {
    agent.send(messageUser("hello"));
    await agent.run();
    const delta = packets.find((packet) => packet.type === "turn.delta");
    const history = packets.find((packet) => packet.type === "turn.end")?.history;
    expect(delta.text).toBe("**draft");
    expect(history?.at(-1)).toMatchObject({ kind: "text", text: "**final** and $x^2$", done: true });
    expect(renderMarkdown(history.at(-1).text)).toContain("<strong>final</strong>");
    expect(renderMarkdown(history.at(-1).text)).toContain('role="math"');
  } finally { session.dispose(); }
});

test("a running turn reports live activity (Stop/composer state) without an agent switch", async () => {
  const env = await testEnv();
  let release;
  const io = {
    state: "idle",
    async write(_context, callbacks) {
      callbacks.onStart?.({ type: "start" });
      callbacks.onTextDelta?.({ type: "text", text: "working reply" });
      return await new Promise((resolve) => { release = () => { callbacks.onDone?.({ type: "done" }); resolve({ type: "done" }); }; });
    },
    async close() { this.state = "closed"; },
  };
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    expect(received.find((m) => m.type === "hello")?.agent?.busy).toBe(false);
    socket.send(JSON.stringify({ type: "chat.submit", text: "go" }));
    const deadline = Date.now() + 4000;
    // turn.start carries busy:true immediately (the composer animation and
    // Stop button read it), and the pushed agent snapshot says busy too.
    while (Date.now() < deadline && !received.some((m) => m.type === "turn.start")) await tick();
    expect(received.findLast((m) => m.type === "turn.start")?.busy).toBe(true);
    while (Date.now() < deadline && !(received.findLast((m) => m.type === "agent")?.agent?.busy)) await tick();
    expect(received.findLast((m) => m.type === "agent")?.agent?.state).toBe("working");
    expect(received.findLast((m) => m.type === "sessions")?.agents?.[0]?.busy).toBe(true);
    release();
    // When the run settles, the SAME stream reports idle again. Wait for
    // the run to actually settle first: earlier turn.end packets (tool
    // rounds, queued-message continuations) legitimately carry busy:true.
    while (Date.now() < deadline && received.findLast((m) => m.type === "turn.end")?.busy !== false) await tick();
    while (Date.now() < deadline && received.findLast((m) => m.type === "agent")?.agent?.busy !== false) await tick();
    expect(received.findLast((m) => m.type === "agent")?.agent?.state).toBe("idle");
    socket.close();
  } finally { web.stop(); }
});

test("reconnecting selects the first running agent before creating a session", async () => {
  const env = await testEnv();
  const first = scripted(env, 0, "first");
  const second = scripted(env, 0, "second");
  let created = 0;
  const web = await serve({ port: 0, env, createSession: async () => { created++; return { agent: scripted(env, 0, "new") }; } });
  const received = [];
  try {
    const socket = await connect(web, received);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((message) => message.type === "hello")) await tick();
    expect(received.find((message) => message.type === "hello")?.agent?.id).toBe(first.name);
    expect(created).toBe(0);
    expect(env.agents()).toEqual([first, second]);
    socket.close();
  } finally { web.stop(); }
});

test("an agent is ready at connection time so settings work before chat, and chat streams turn deltas", async () => {
  const env = await testEnv();
  let created = 0;
  const web = await serve({ port: 0, env, createSession: async () => { created++; return { agent: scripted(env, 0, "web scripted reply") }; } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    expect(created).toBe(1); // Ghost-mode agent is ready before the first message.
    socket.send(JSON.stringify({ type: "settings.safe", on: true }));
    await tick();
    expect(received.findLast((m) => m.type === "settings")?.safe).toBe(true);
    socket.send(JSON.stringify({ type: "chat.submit", text: "hello" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "turn.end")) await tick();
    const text = JSON.stringify(received);
    expect(created).toBe(1);
    expect(received.some((m) => m.type === "hello")).toBe(true);
    expect(received.some((m) => m.type === "chat.user")).toBe(true);
    expect(received.some((m) => m.type === "turn.delta" && m.kind === "text" && m.text.includes("web scripted reply"))).toBe(true);
    expect(text).toContain("web scripted reply");
    socket.close();
  } finally { web.stop(); }
});

test("session logging settings update persisted agents; an agent that is not logged opts in and logs the same conversation", async () => {
  const env = await testEnv();
  const saved = new Agent({ env, model: "p/m", context: [], contextId: "web-session", createIO: () => scriptedIO([[{ type: "done" }]]) });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: saved }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    expect(received.find((m) => m.type === "settings")?.sessionSave).toBe(true);
    socket.send(JSON.stringify({ type: "settings.session-save", on: false }));
    await tick();
    expect(saved.context.save).toBe(false);
    expect(received.findLast((m) => m.type === "settings")?.sessionSave).toBe(false);
    socket.close();
  } finally { web.stop(); }

  const anonymousEnv = await testEnv();
  const anonymous = scripted(anonymousEnv);
  const anonymousWeb = await serve({ port: 0, env: anonymousEnv, createSession: async () => ({ agent: anonymous }) });
  const anonymousReceived = [];
  try {
    const socket = await connect(anonymousWeb, anonymousReceived);
    await tick();
    expect(anonymousReceived.find((m) => m.type === "settings")?.sessionSave).toBe(false);
    const transcript = anonymous.context;
    const transcriptLength = transcript.length;
    socket.send(JSON.stringify({ type: "settings.session-save", on: true }));
    // The toggle is always accessible: opting in on an agent that is not
    // logged logs ITS conversation — the transcript continues persisted.
    // Wait for the server's response instead of a bare tick: session
    // creation can take longer than one tick.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && anonymousReceived.findLast((m) => m.type === "settings")?.sessionSave !== true) await tick();
    expect(anonymous.context.save).toBe(true);
    expect(anonymous.context).toBe(transcript); // the same conversation, now saved — not a fresh one
    expect(anonymous.context.messages()).toHaveLength(transcriptLength);
    expect(anonymousReceived.findLast((m) => m.type === "settings")?.sessionSave).toBe(true);
    const listed = anonymousReceived.findLast((m) => m.type === "sessions")?.agents?.find((a) => a.id === anonymous.name);
    expect(listed?.session).toBe(anonymous.context.id);
    socket.close();
  } finally { anonymousWeb.stop(); }
});

test("web sessions are saved by default; --session anon starts not logged", async () => {
  const savedEnv = await testEnv();
  const savedWeb = await serve({ port: 0, env: savedEnv, createSession: async () => ({
    agent: new Agent({ env: savedEnv, model: "p/m", context: [], contextId: crypto.randomUUID(), createIO: () => scriptedIO([[{ type: "done" }]]) }),
  }) });
  const received = [];
  try {
    const socket = await connect(savedWeb, received);
    await tick(60);
    const hello = received.find((m) => m.type === "hello");
    expect(typeof hello.agent.session).toBe("string");
    expect(received.find((m) => m.type === "settings")?.sessionSave).toBe(true);
    // The session file flushes under the agent's session directory — the
    // settings folder's sessions/ by default (asserted above).
    socket.send(JSON.stringify({ type: "chat.submit", text: "persist me" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "turn.end")) await tick();
    const agent = savedWeb.env.agents()[0];
    expect(agent.context.dir.replace(/^\.\//, "")).toBe(`${savedEnv._settingsDir}/sessions`.replace(/^\.\//, ""));
    // The live-turn flush is yielded to the event loop (Agent._flushLive):
    // poll until the JSONL lands instead of assuming a synchronous write.
    const readFiles = () => readdirSync(agent.context.dir).filter((name) => name.endsWith(".jsonl"));
    while (Date.now() < deadline && readFiles().length === 0) await tick();
    expect(readFiles().length).toBe(1);
    socket.close();
  } finally { savedWeb.stop(); }

  const ghostEnv = await testEnv();
  const ghostWeb = await serve({ port: 0, env: ghostEnv, session: { kind: "anonymous" } });
  const ghostReceived = [];
  try {
    const socket = await connect(ghostWeb, ghostReceived);
    await tick(60);
    expect(ghostReceived.find((m) => m.type === "hello")?.agent?.logged).toBe(false);
    socket.close();
  } finally { ghostWeb.stop(); }
});

test("tool-call response events stream as distinct wire packets", async () => {
  const env = await testEnv();
  const io = {
    state: "idle",
    async write(_context, callbacks) {
      callbacks.onStart?.({ type: "start" });
      callbacks.onThinkingDelta?.({ type: "thinking", text: "reasoning" });
      callbacks.onToolCallStart?.({ type: "toolCall", text: "read" });
      callbacks.onToolCallDelta?.({ type: "toolCall", delta: " README.md" });
      callbacks.onToolCallEnd?.({ type: "toolCall" });
      callbacks.onDone?.({ type: "done" });
      return { type: "done" };
    },
    async close() { this.state = "closed"; },
  };
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "hello" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "turn.end")) await tick();
    expect(received.filter((m) => m.type.startsWith("tool.call.")).map((m) => [m.type, m.text])).toEqual([
      ["tool.call.start", "read"], ["tool.call.delta", " README.md"], ["tool.call.end", ""],
    ]);
    expect(received.some((m) => m.type === "turn.delta" && m.kind === "thinking")).toBe(true);
    socket.close();
  } finally { web.stop(); }
});

test("the web server uses an explicit theme background and otherwise preserves system fallback", async () => {
  const env = await testEnv();
  env.settings.tui = { themes: {
    night: { background: { bg: "#101820" }, text: { fg: "#eeeeee" } },
    inherited: { text: { fg: "#222222" } },
  } };
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  try {
    const css = await (await fetch(`${origin(web)}/themes.css`)).text();
    expect(css).toContain(':root[data-theme="night"]{--page:#101820');
    expect(css).toContain(':root[data-theme="night"]{--page:#101820;--surface:#101820');
    expect(css).toContain(':root[data-theme="inherited"]{--fg:#222222}');
    expect(css).not.toContain(':root[data-theme="inherited"]{--page:');
  } finally { web.stop(); }
});

test("the web server publishes loaded theme CSS and initial usage status", async () => {
  const env = await testEnv();
  env.settings.tui = { themes: { ember: { text: { fg: "#123456" }, accent: { fg: "#abcdef" }, "status.busy": { animation: { type: "wave", period: 720 } }, "input.border.active.bottom": { animation: { type: "comet", crossing: 1300 } } } } };
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  const received = [];
  try {
    const css = await (await fetch(`${origin(web)}/themes.css`)).text();
    expect(css).toContain('[data-theme="ember"]');
    expect(css).toContain("#123456");
    expect(css).toContain("--working-animation-name:web-wave");
    expect(css).toContain("--working-duration:720ms");
    expect(css).toContain("--input-border-animation-name:web-comet");
    expect(css).toContain("--input-border-duration:1300ms");
    const socket = await connect(web, received);
    await tick();
    const hello = received.find((m) => m.type === "hello");
    expect(hello.status).toMatchObject({ input: 0, output: 0, used: expect.any(Number), available: expect.any(Number) });
    expect(received.find((m) => m.type === "settings")?.prefs.themes).toContain("ember");
    socket.close();
  } finally { web.stop(); }
});

test("statusSnapshot() carries the provider's plan/quota report (mirrors tui-app's planUsage readout)", async () => {
  const env = await testEnv();
  const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "hi"), { type: "done" }]]);
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const session = new AgentSession(agent);
  expect(session.statusSnapshot().plan).toBeNull();
  agent.send(messageUser("hi"));
  io.planUsage = { quotas: { requests: { total: 500, remaining: 470 } } };
  await agent.run();
  expect(session.statusSnapshot().plan).toEqual({ quotas: { requests: { total: 500, remaining: 470 } } });
});

test("the settings packet carries settings.web display prefs (defaults + overrides)", async () => {
  const env = await testEnv();
  env.settings.web = { theme: "dark", collapse: { thinking: false } };
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick(60);
    const packet = received.find((m) => m.type === "settings");
    expect(packet).toBeDefined();
    expect(packet.prefs).not.toHaveProperty("toolLines"); // previews follow the theme
    expect(packet.prefs.theme).toBe("dark");
    expect(packet.prefs.collapse.thinking).toBe(false);
    expect(packet.prefs.collapse.tools).toBe(true); // untouched default
    expect(packet.prefs.autocomplete).toBe(true);   // untouched default
    expect(packet.prefs.thinkingLevels).toContain("xhigh");
    socket.close();
  } finally { web.stop(); }
});

test("closing the browser leaves its server-owned agent running", async () => {
  const env = await testEnv();
  let release;
  const io = {
    state: "idle",
    async write(_context, callbacks) {
      callbacks.onStart?.({ type: "start" });
      return await new Promise((resolve) => { release = () => {
        callbacks.onDone?.({ type: "done" });
        resolve({ type: "done" });
      }; });
    },
    async close() { this.state = "closed"; },
  };
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "continue without me" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !agent.busy) await tick();
    expect(agent.busy).toBe(true);
    const closed = new Promise((resolve) => { socket.onclose = resolve; });
    socket.close();
    await closed;
    expect(agent.busy).toBe(true);
    release();
    while (Date.now() < deadline && agent.busy) await tick();
    expect(agent.busy).toBe(false);
  } finally { web.stop(); }
});

test("queued web messages can be unqueued for editing before the active turn settles", async () => {
  const env = await testEnv();
  let release;
  const io = {
    state: "idle",
    async write(_context, callbacks) {
      callbacks.start?.({ type: "start" });
      return await new Promise((resolve) => { release = () => resolve({ type: "done" }); });
    },
    async close() { this.state = "closed"; },
  };
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "active" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !agent.busy) await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "revise me" }));
    while (Date.now() < deadline && !received.findLast((m) => m.type === "chat.queue")) await tick();
    expect(agent.pending).toHaveLength(1);
    expect(received.findLast((m) => m.type === "chat.queue")?.messages).toEqual(["revise me"]);
    socket.send(JSON.stringify({ type: "chat.unqueue" }));
    while (Date.now() < deadline && agent.pending.length !== 0) await tick();
    expect(received.findLast((m) => m.type === "chat.queue")?.messages).toEqual([]);
    release();
    socket.close();
  } finally { web.stop(); }
});

test("queued messages clear and enter the stream when the active turn delivers them", async () => {
  const env = await testEnv();
  let release;
  let writes = 0;
  const io = {
    state: "idle",
    async write(_context, callbacks) {
      callbacks.onStart?.({ type: "start" });
      if (++writes === 1) return await new Promise((resolve) => { release = () => resolve({ type: "done" }); });
      callbacks.onDone?.({ type: "done" });
      return { type: "done" };
    },
    async close() { this.state = "closed"; },
  };
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "active" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !agent.busy) await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "delivered later" }));
    while (Date.now() < deadline && agent.pending.length !== 1) await tick();
    release();
    while (Date.now() < deadline && (agent.pending.length || !received.some((m) => m.type === "chat.user" && m.message?.text === "delivered later"))) await tick();
    expect(agent.pending).toHaveLength(0);
    expect(received.findLast((m) => m.type === "chat.queue")?.messages).toEqual([]);
    expect(received.some((m) => m.type === "chat.user" && m.message?.text === "delivered later")).toBe(true);
    socket.close();
  } finally { web.stop(); }
});

test("context inspection separates viewer block types and tool display", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "idle");
  agent.context.update((messages) => { messages.push(
    { type: 1, content: [{ type: "text", text: "system" }] },
    { type: 2, content: [{ type: "text", text: "user" }] },
    { type: 3, content: [{ type: "thinking", text: "thought" }, { type: "text", text: "reply" }, { type: "toolCall", name: "read", arguments: {} }] },
    { type: 4, name: "read", content: [{ type: "text", text: "answer" }], display: ["display"] },
  ); return true; });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "context.inspect" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "context")) await tick();
    const types = received.findLast((m) => m.type === "context").blocks.flatMap((message) => message.content.map((block) => block.viewerType));
    expect(types).toEqual(expect.arrayContaining(["system", "user", "thinking", "assistant", "tool call", "tool answer", "tool display"]));
    // tool blocks name their tool for the block viewer's title; others carry no name
    const blocks = received.findLast((m) => m.type === "context").blocks.flatMap((message) => message.content);
    expect(blocks.filter((block) => block.viewerType.startsWith("tool")).map((block) => block.name)).toEqual(["read", "read", "read"]);
    expect(blocks.filter((block) => !block.viewerType.startsWith("tool")).every((block) => block.name === undefined)).toBe(true);
    socket.close();
  } finally { web.stop(); }
});

test("context deletion removes selected messages through the web protocol", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "idle");
  agent.context.update((messages) => { messages.push(
    { type: 2, content: [{ type: "text", text: "first" }] },
    { type: 2, content: [{ type: "text", text: "second" }] },
    { type: 2, content: [{ type: "text", text: "third" }] },
  ); return true; });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "context.delete", messageIndexes: [0, 2] }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && agent.context.length !== 1) await tick();
    expect(agent.context.messages().map((message) => message.content[0].text)).toEqual(["second"]);
    expect(received.findLast((m) => m.type === "context")?.blocks).toHaveLength(1);
    socket.close();
  } finally { web.stop(); }
});

test("the web protocol exposes context inspection/editing and direct tool calls", async () => {
  const env = await testEnv();
  env.toolAdd("echo", async ({ value }) => ({ content: [{ type: "text", text: String(value) }] }), {
    description: "Returns the supplied value.", inputSchema: { type: "object", properties: { value: { type: "string" } } }, safe: true,
  });
  const agent = scripted(env, 0, "idle");
  agent.context.append({ type: 2, content: [{ type: "text", text: "before" }] });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "context.inspect" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "context")) await tick();
    expect(received.findLast((m) => m.type === "context")?.blocks[0].content[0].text).toBe("before");
    socket.send(JSON.stringify({ type: "context.edit-text", messageIndex: 0, blockIndex: 0, text: "after" }));
    while (Date.now() < deadline && agent.context.at(0).content[0].text !== "after") await tick();
    expect(agent.context.at(0).content[0].text).toBe("after");
    socket.send(JSON.stringify({ type: "tool.call", name: "echo", args: { value: "tool result" } }));
    while (Date.now() < deadline && !JSON.stringify(received).includes("tool result")) await tick();
    expect(JSON.stringify(received)).toContain("tool result");
    socket.close();
  } finally { web.stop(); }
});

test("web startup replaces an invalid last model with the first available combo alphabetically", async () => {
  const env = await testEnv();
  env._endpoints.p.models = { m: {} };
  env._endpoints.zed = { provider: "test", url: "test://zed", models: { omega: {} } };
  env._endpoints.alpha = { provider: "test", url: "test://alpha", models: { beta: {}, alpha: {} } };
  writeFileSync(`${env._settingsDir}/last-model.json`, JSON.stringify({ endpoint: "p", model: "removed" }));
  const web = await serve({ port: 0, env, session: { kind: "anonymous" } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick(60);
    const hello = received.find((message) => message.type === "hello");
    expect(`${hello.agent.endpoint}/${hello.agent.model}`).toBe("alpha/alpha");
    socket.close();
  } finally { web.stop(); }
});

test("the model menu lists clean endpoint/model combos, never completion noise", async () => {
  const env = await testEnv();
  env._endpoints.acme = { provider: "test", url: "test://script" };
  authSetOf(env, "acme", { token: "t", models: { "acme-pro": null, "acme-mini": null } });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick(60);
    const models = received.find((m) => m.type === "settings")?.models ?? [];
    // Only concrete combos — never a bare endpoint or a bare model id.
    expect(models).toContain("acme/acme-pro");
    expect(models).toContain("acme/acme-mini");
    expect(models).not.toContain("acme");
    expect(models).not.toContain("acme-pro");
    expect(models.every((m) => m.includes("/"))).toBe(true);
    socket.close();
  } finally { web.stop(); }
});

test("session.fork branches under the new id and keeps the logging setting", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env, 0, "idle") }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    expect(received.find((m) => m.type === "hello")?.agent?.logged).toBe(false);
    socket.send(JSON.stringify({ type: "session.fork", id: "web-branch" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && received.findLast((m) => m.type === "hello")?.agent?.session !== "web-branch") await tick();
    expect(received.findLast((m) => m.type === "hello")?.agent).toMatchObject({ session: "web-branch", logged: false });
    socket.close();
  } finally { web.stop(); }
});

test("session.new replaces the viewed agent with a fresh one", async () => {
  const env = await testEnv();
  const agents = [];
  const web = await serve({ port: 0, env, createSession: async () => {
    const agent = scripted(env, 0, "idle");
    agents.push(agent);
    return { agent };
  } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    const first = agents[0];
    socket.send(JSON.stringify({ type: "session.new" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && agents.length < 2) await tick();
    expect(first.closed).toBe(true);
    expect(agents[1].context.save).toBe(false);
    expect(received.findLast((m) => m.type === "hello")?.agent?.id).toBe(agents[1].name);
    socket.close();
  } finally { web.stop(); }
});

test("resuming a saved session replaces the viewed agent", async () => {
  const env = await testEnv();
  const agents = [];
  const web = await serve({ port: 0, env, createSession: async () => {
    const agent = scripted(env, 0, "idle");
    agents.push(agent);
    return { agent };
  } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    const originalList = Agent.Context.listAsync;
    Agent.Context.listAsync = async () => [{ id: "saved", preview: "saved", messages: 0 }];
    try {
      socket.send(JSON.stringify({ type: "session.resume", id: "saved" }));
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && agents.length < 2) await tick();
      expect(agents[0].closed).toBe(true);
      expect(received.findLast((m) => m.type === "hello")?.agent?.id).toBe(agents[1].name);
    } finally { Agent.Context.listAsync = originalList; }
    socket.close();
  } finally { web.stop(); }
});

test("saved sessions rename and delete by id from the sidebar", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env, 0, "idle") }) });
  const received = [];
  const Store = Agent.Context;
  const original = { listAsync: Store.listAsync, renameById: Store.renameById, deleteById: Store.deleteById };
  const calls = [];
  Store.listAsync = async () => [{ id: "saved", preview: "saved", messages: 1 }];
  Store.renameById = (options) => { calls.push(["rename", options.id, options.name]); return { id: options.name, file: "x" }; };
  Store.deleteById = (options) => { calls.push(["delete", options.id]); return { deleted: 1 }; };
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "session.rename", id: "saved", name: "kept" }));
    socket.send(JSON.stringify({ type: "session.delete", id: "saved" }));
    socket.send(JSON.stringify({ type: "session.delete", id: "missing" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "error")) await tick();
    expect(calls).toEqual([["rename", "saved", "kept"], ["delete", "saved"]]);
    expect(received.filter((m) => m.type === "command.result").map((m) => m.text)).toEqual(["session named: kept", "session deleted: saved"]);
    expect(received.find((m) => m.type === "error")?.message).toContain("unknown session");
    socket.close();
  } finally { Object.assign(Store, original); web.stop(); }
});

test("deleting a live saved session closes its agent and moves all viewers before deleting its file", async () => {
  const env = await testEnv();
  const agents = [];
  const web = await serve({ port: 0, env, createSession: async () => {
    const agent = new Agent({ env, model: "p/m", contextId: agents.length ? `replacement-${agents.length}` : "target", createIO: () => scriptedIO([[{ type: "done" }]]) });
    agents.push(agent);
    if (agents.length === 1) { agent.context.append(messageUser("keep this conversation")); agent.context.flush(); }
    return { agent };
  } });
  const first = [], second = [];
  try {
    const a = await connect(web, first);
    const b = await connect(web, second);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !first.some((m) => m.type === "sessions" && m.recent.some((s) => s.id === "target" && s.live))) await tick();
    expect(first.findLast((m) => m.type === "sessions").recent).toContainEqual(expect.objectContaining({ id: "target", live: true }));
    a.send(JSON.stringify({ type: "session.delete", id: "target" }));
    while (Date.now() < deadline && !first.some((m) => m.type === "command.result" && m.text.includes("session deleted"))) await tick();
    const refreshed = Date.now() + 4000;
    while (Date.now() < refreshed && [first, second].some((packets) => packets.findLast((m) => m.type === "sessions")?.recent.some((s) => s.id === "target"))) await tick();
    expect(agents[0].closed).toBe(true);
    expect(first.findLast((m) => m.type === "hello")?.agent?.id).toBe(agents[1].name);
    expect(second.findLast((m) => m.type === "hello")?.agent?.id).toBe(agents[2].name);
    expect(first.findLast((m) => m.type === "sessions")?.recent.some((s) => s.id === "target")).toBe(false);
    expect(readdirSync(env.settings.sessions).some((name) => name.includes("target"))).toBe(false);
    a.close(); b.close();
  } finally { web.stop(); }
});

test("switching sessions keeps the current model unless the session stored its own", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, model: { model: "p1/launch" } });
  const received = [];
  const hellos = () => received.filter((m) => m.type === "hello");
  const nextHello = async (count) => { const deadline = Date.now() + 4000; while (Date.now() < deadline && hellos().length < count) await tick(); return hellos().at(-1)?.agent; };
  const stored = (id, settings) => { const store = new Agent.Context({ id, dir: env.settings.sessions, origin: env.cwd, settings }); store.append({ type: 2, content: [{ type: "text", text: id }] }); store.close(); };
  try {
    const socket = await connect(web, received);
    expect(await nextHello(1)).toMatchObject({ endpoint: "p1", model: "launch" });
    env.agents()[0].model = "p2/picked"; // the user switched models since launch
    socket.send(JSON.stringify({ type: "session.new" }));
    expect(await nextHello(2)).toMatchObject({ endpoint: "p2", model: "picked" }); // not the launch last-model
    stored("with-model", { model: "x/own" });
    stored("without-model", { name: "plain" });
    socket.send(JSON.stringify({ type: "session.resume", id: "with-model" }));
    expect(await nextHello(3)).toMatchObject({ endpoint: "x", model: "own" }); // the session's own model
    socket.send(JSON.stringify({ type: "session.resume", id: "without-model" }));
    expect(await nextHello(4)).toMatchObject({ endpoint: "x", model: "own" }); // no model stored: the current one stays
    socket.close();
  } finally { web.stop(); }
});

test("settings and session.add retain qualified Agent models while displaying native model IDs", async () => {
  const env = await testEnv();
  env._endpoints.p.models = { m: {}, "team/nested": {} };
  const web = await serve({ port: 0, env, model: { model: "p/m" } });
  const received = [];
  try {
    const socket = await connect(web, received);
    expect(await until(() => received.some((packet) => packet.type === "settings"))).toBe(true);
    socket.send(JSON.stringify({ type: "settings.model", model: "p/team/nested" }));
    expect(await until(() => env.agents()[0]?.model === "p/team/nested")).toBe(true);
    expect(received.findLast((packet) => packet.type === "settings")).toMatchObject({ endpoint: "p", model: "team/nested" });
    socket.send(JSON.stringify({ type: "session.add", model: "p/team/nested" }));
    expect(await until(() => env.agents().length === 2)).toBe(true);
    expect(env.agents()[1].model).toBe("p/team/nested");
    expect(received.findLast((packet) => packet.type === "hello")?.agent).toMatchObject({ endpoint: "p", model: "team/nested" });
    socket.close();
  } finally { web.stop(); }
});

test("session.add creates an additional agent while keeping the current one", async () => {
  const env = await testEnv();
  let created = 0;
  const web = await serve({ port: 0, env, createSession: async () => { created++; return { agent: scripted(env, 0, `reply-${created}`) }; } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "first" }));
    const d1 = Date.now() + 4000;
    while (Date.now() < d1 && !received.some((m) => m.type === "turn.end")) await tick();
    expect(created).toBe(1);
    socket.send(JSON.stringify({ type: "session.add" }));
    const d2 = Date.now() + 4000;
    while (Date.now() < d2 && created < 2) await tick();
    expect(created).toBe(2); // an ADDITIONAL agent, not a replacement
    socket.close();
  } finally { web.stop(); }
});

test("session.close closes an open agent and replaces its attached view", async () => {
  const env = await testEnv();
  const agents = [];
  const web = await serve({ port: 0, env, createSession: async () => {
    const agent = scripted(env, 0, "idle");
    agents.push(agent);
    return { agent };
  } });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    const first = agents[0];
    socket.send(JSON.stringify({ type: "session.close", agentId: first.name }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && agents.length < 2) await tick();
    expect(first.closed).toBe(true);
    expect(env.agents()).not.toContain(first);
    expect(agents).toHaveLength(2);
    expect(received.findLast((m) => m.type === "hello")?.agent?.id).toBe(agents[1].name);
    socket.close();
  } finally { web.stop(); }
});

test("attaching to an agent replays context user messages as history blocks", async () => {
  const env = await testEnv();
  const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "seeded reply"), { type: "done" }]]);
  const agent = new Agent({ env, model: "p/m", context: [messageUser("context-only question")], createIO: () => io });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    // Drive one turn so the context holds a user + assistant exchange.
    socket.send(JSON.stringify({ type: "chat.submit", text: "seeded question" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.some((m) => m.type === "turn.end")) await tick();
    // A second connection switching to the same agent replays the history.
    const bMsgs = [];
    const b = await connect(web, bMsgs);
    await tick();
    b.send(JSON.stringify({ type: "session.switch", agentId: agent.name }));
    const sw = Date.now() + 4000;
    let hello;
    while (Date.now() < sw && !(hello = bMsgs.find((m) => m.type === "hello"))) await tick();
    expect(hello).toBeDefined();
    const history = JSON.stringify(hello.history ?? []);
    expect(history).toContain("context-only question");
    expect(history).toContain("seeded question");
    expect(history).toContain("seeded reply");
    socket.close(); b.close();
  } finally { web.stop(); }
});

test("re-entering an agent replays a response streamed while it was in the background", async () => {
  const env = await testEnv();
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const firstIO = {
    state: "idle",
    async close() {},
    async write(_context, callbacks) {
      callbacks.onStart?.({ type: "start" });
      callbacks.onTextDelta?.({ type: "text", text: "before switch " });
      await paused;
      callbacks.onTextDelta?.({ type: "text", text: "after switch" });
      callbacks.onDone?.({ type: "done" });
      return { type: "done" };
    },
  };
  const first = new Agent({ env, model: "p/m", context: [], createIO: () => firstIO });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: first }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "background me" }));
    const started = Date.now() + 4000;
    while (Date.now() < started && !JSON.stringify(received).includes("before switch")) await tick();
    socket.send(JSON.stringify({ type: "session.add" }));
    await tick();
    release();
    await tick(60);
    socket.send(JSON.stringify({ type: "session.switch", agentId: first.name }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.findLast((m) => m.type === "hello")?.history?.some((block) => block.text?.includes("after switch"))) await tick();
    const hello = received.findLast((m) => m.type === "hello");
    expect(hello.history.map((block) => block.text).join("")).toContain("before switch after switch");
    socket.close();
  } finally { web.stop(); }
});

test("reconnected views share the selected running agent's stream", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "shared reply");
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const aMsgs = []; const bMsgs = [];
  try {
    const a = await connect(web, aMsgs);
    const b = await connect(web, bMsgs);
    await tick();
    a.send(JSON.stringify({ type: "chat.submit", text: "A" }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !bMsgs.some((m) => m.type === "turn.end")) await tick();
    expect(JSON.stringify(aMsgs)).toContain("shared reply");
    expect(JSON.stringify(bMsgs)).toContain("shared reply");
    a.close(); b.close();
  } finally { web.stop(); }
});

// The question bridge is the AgentSession's seam for interactive tools. We
// drive it through the PUBLIC setQuestion surface (an interactive tool calls
// exactly this) rather than the full tool-sandbox e2e — the latter is the
// Agent's concern and covered by agent-question tests.
test("a timed-out bridge question closes over the wire and rejects a late answer", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "idle");
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    const question = agent._question.ask([{ question: "Allow?", header: "Worker", options: [{ label: "Allow", description: "yes" }] }]);
    let opened;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !(opened = received.find((m) => m.type === "question.open"))) await tick();
    agent._question.timeout(); // mirrors Agent's timeout boundary
    while (Date.now() < deadline && !received.some((m) => m.type === "question.close")) await tick();
    await expect(question).resolves.toBeNull();
    socket.send(JSON.stringify({ type: "question.answer", requestId: opened.requestId, answers: [{ labels: ["Allow"] }] }));
    await tick();
    expect(received.filter((m) => m.type === "question.close")).toHaveLength(1);
    socket.close();
  } finally { web.stop(); }
});

// The question bridge is the AgentSession's seam for interactive tools. We
// drive it through the PUBLIC setQuestion surface (an interactive tool calls
// exactly this) rather than the full tool-sandbox e2e — the latter is the
// Agent's concern and covered by agent-question tests.
test("a question asked through the bridge opens over the wire and an answer resolves it", async () => {
  const env = await testEnv();
  const agent = scripted(env, 0, "idle");
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    // The connection's ready agent has an AgentSession-installed question
    // bridge. Ask through it (an interactive tool calls exactly this): it must open a
    // question over the wire and resolve with the user's answer.
    let opened;
    const openDeadline = Date.now() + 4000;
    const bridgePromise = agent._question.ask([{ question: "Pick", header: "Choice", options: [{ label: "A", description: "a" }] }]);
    while (Date.now() < openDeadline && !(opened = received.find((m) => m.type === "question.open"))) await tick();
    expect(opened).toBeDefined();
    expect(JSON.stringify(opened.questions)).toContain("Pick");
    socket.send(JSON.stringify({ type: "question.answer", requestId: opened.requestId, answers: [{ question: "Pick", answer: "A" }] }));
    await expect(bridgePromise).resolves.toEqual([{ question: "Pick", answer: "A" }]);
    socket.close();
  } finally { web.stop(); }
});

/* ------------------------------------------------ TUI-parity packets */

const until = async (predicate, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !predicate()) await tick();
  return predicate();
};

test("every SPA asset the page references is served (no dangling module paths)", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  try {
    for (const path of ["/", "/app.js", "/style.css", "/themes.css", "/markdown.js", "/markdown/browser.js", "/markdown/math.js", "/markdown/inline.js", "/read-preview.js", "/text-safe.js", "/format.js", "/favicon.svg", "/logo.svg"]) {
      const response = await fetch(`${origin(web)}${path}`);
      expect([path, response.status]).toEqual([path, 200]);
    }
  } finally { web.stop(); }
});

test("protocol validates the TUI-parity packets", () => {
  expect(parseClientMessage(JSON.stringify({ type: "session.new", anonymous: true, safe: true }))).toEqual({ type: "session.new", anonymous: true, safe: true });
  expect(parseClientMessage(JSON.stringify({ type: "session.add", model: "p/m" }))).toEqual({ type: "session.add", safe: false, model: "p/m" });
  expect(parseClientMessage(JSON.stringify({ type: "agent.rename", name: "  scribe " }))).toEqual({ type: "agent.rename", name: "scribe" });
  expect(parseClientMessage(JSON.stringify({ type: "settings.spawn", value: "Ask" }))).toEqual({ type: "settings.spawn", value: null });
  expect(parseClientMessage(JSON.stringify({ type: "endpoint.login", scope: "package", name: "e", provider: "p", url: "u" }))).toEqual({ type: "endpoint.login", scope: "package", name: "e", provider: "p", url: "u" });
  expect(() => parseClientMessage(JSON.stringify({ type: "endpoint.login", scope: "global", name: "e", provider: "p", url: "u" }))).toThrow("invalid scope");
  expect(() => parseClientMessage(JSON.stringify({ type: "session.rename", name: "   " }))).toThrow("invalid name");
  expect(parseClientMessage(JSON.stringify({ type: "session.rename", name: "n", id: "s" }))).toEqual({ type: "session.rename", name: "n", id: "s" });
  expect(parseClientMessage(JSON.stringify({ type: "session.delete", id: "s" }))).toEqual({ type: "session.delete", id: "s" });
  expect(parseClientMessage(JSON.stringify({ type: "chat.continue" }))).toEqual({ type: "chat.continue" });
});

test("agents are renamed, delegation is set, and the web theme persists independently of tui.theme", async () => {
  const env = await testEnv({ theme: "night", tui: { theme: "default", themes: { night: { background: { bg: "#101820" }, text: { fg: "#eeeeee" } } } } });
  const agent = scripted(env);
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    expect(await until(() => received.some((m) => m.type === "settings"))).toBe(true);
    expect(received.findLast((m) => m.type === "settings").prefs.activeTheme).toBe("night");
    socket.send(JSON.stringify({ type: "agent.rename", name: "scribe" }));
    socket.send(JSON.stringify({ type: "settings.spawn", value: false }));
    socket.send(JSON.stringify({ type: "settings.theme", name: "night" }));
    expect(await until(() => env.settings.web.theme === "night" && agent.name === "scribe" && agent.spawnPermission === false)).toBe(true);
    expect(agent.name).toBe("scribe");
    expect(agent.spawnPermission).toBe(false);
    expect(env.settings.web.theme).toBe("night");
    expect(env.settings.tui.theme).toBe("default");
    expect(await until(() => { try { return JSON.parse(readFileSync(`${env._settingsDir}/settings.json`, "utf8")).web?.theme === "night"; } catch { return false; } })).toBe(true);
    expect(received.findLast((m) => m.type === "settings").prefs.themeModes.night).toBe("dark");
    expect(received.some((m) => m.type === "agent" && m.agent.name === "scribe")).toBe(true);
    const css = await (await fetch(`${origin(web)}/themes.css`)).text();
    expect(css).toContain('.theme-card[data-theme="night"]{');
    socket.send(JSON.stringify({ type: "settings.theme", name: "system" }));
    expect(await until(() => env.settings.web.theme === "system")).toBe(true);
    expect(env.settings.tui.theme).toBe("default");
    socket.close();
  } finally { web.stop(); }
});

test("dual-mode theme CSS merges inherited shared roles and mode colors per swatch", async () => {
  const env = await testEnv();
  env.settings.tui = { themes: {
    base: { text: { fg: "#eeeeee" }, background: { bg: "#123456" }, dark: { background: { bg: "#000000" } } },
    child: { parent: "base", text: { bold: true }, light: { text: { bg: "#abcdef" } }, dark: { text: { bg: "#654321" } } },
  } };
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  try {
    const css = await (await fetch(`${origin(web)}/themes.css`)).text();
    expect(css).toContain(':root[data-theme="child"][data-mode="light"]{--page:#123456;--surface:#123456;--surface-2:#123456;--fg:#eeeeee}');
    expect(css).toContain(':root[data-theme="child"][data-mode="dark"]{--page:#000000;--surface:#000000;--surface-2:#000000;--fg:#eeeeee}');
    expect(css).toContain('.theme-card[data-theme="child"][data-mode="dark"]{--page:#000000;');
    expect(css).toContain('.theme-card[data-theme="child"][data-mode="light"]{--page:#123456;');
    const received = [];
    const socket = await connect(web, received);
    expect(await until(() => received.some((m) => m.type === "settings"))).toBe(true);
    expect(received.findLast((m) => m.type === "settings").prefs.dualThemes).toContain("child");
    socket.close();
  } finally { web.stop(); }
});

// A verifiable no-network protocol (the CLI login tests' fake): login
// always runs a connection test and a model listing.
class LoginProtocol {
  static provider = { label: "Login", capabilities: {} };
  static login({ token }) { return { type: "api_key", token }; }
  static async testConnection() { return { models: 1 }; }
  static async models() { return { "model-1": { label: "Model 1" } }; }
}

test("endpoints are listed, signed in (direct form) and signed out over the wire", async () => {
  const env = await testEnv();
  providerAdd(env, "wire", LoginProtocol);
  const agent = scripted(env);
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "endpoint.list" }));
    expect(await until(() => received.some((m) => m.type === "endpoints"))).toBe(true);
    expect(received.find((m) => m.type === "endpoints")).toMatchObject({ endpoints: expect.any(Array), presets: expect.any(Array), removable: expect.any(Array) });
    socket.send(JSON.stringify({ type: "endpoint.login", scope: "package", name: "added", provider: "wire", url: "https://added.test/v1", token: "t" }));
    await until(() => received.some((m) => m.type === "command.result" && m.text.startsWith("endpoint saved: added")) || received.some((m) => m.type === "error"));
    expect(received.filter((m) => m.type === "error")).toEqual([]);
    expect(agent.model).toBe("added/model-1");
    expect(namesOf(env)).toContain("added");
    socket.send(JSON.stringify({ type: "endpoint.logout", name: "added" }));
    expect(await until(() => received.some((m) => m.type === "command.result" && m.text.startsWith("endpoint removed: added")))).toBe(true);
    expect(namesOf(env)).not.toContain("added");
    expect(agent.model).toBeUndefined();
    socket.close();
  } finally { web.stop(); }
});

test("endpoint policies (disabled, endpoint/model maxActive) are listed and set over the wire", async () => {
  const env = await testEnv();
  providerAdd(env, "wire", LoginProtocol);
  const agent = scripted(env);
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  /** The newest endpoints packet's policy for one endpoint. */
  const policy = (name) => received.findLast((m) => m.type === "endpoints")?.policies?.find((entry) => entry.name === name);
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "endpoint.login", scope: "package", name: "budget", provider: "wire", url: "https://budget.test/v1", token: "t" }));
    expect(await until(() => policy("budget") !== undefined)).toBe(true);
    expect(policy("budget")).toMatchObject({ disabled: false, models: [{ id: "model-1" }] });
    socket.send(JSON.stringify({ type: "endpoint.policy", selector: "budget/model-1", change: { maxActive: 2 } }));
    expect(await until(() => policy("budget")?.models[0].maxActive === 2)).toBe(true);
    socket.send(JSON.stringify({ type: "endpoint.policy", selector: "budget/model-1", change: { maxActive: null } }));
    expect(await until(() => policy("budget")?.models[0].maxActive === undefined)).toBe(true);
    socket.send(JSON.stringify({ type: "endpoint.policy", selector: "budget", change: { disabled: true } }));
    expect(await until(() => policy("budget")?.disabled === true)).toBe(true);
    expect(received.findLast((m) => m.type === "endpoints").endpoints.map((entry) => entry.name)).not.toContain("budget");
    expect(() => env.connection("budget/model-1")).toThrow(/disabled/);
    socket.send(JSON.stringify({ type: "endpoint.policy", selector: "budget", change: { maxActive: -1 } }));
    expect(await until(() => received.some((m) => m.type === "error"))).toBe(true);
    socket.close();
  } finally { web.stop(); }
});

test("a pending question is re-opened for a view that attaches later (reload)", async () => {
  const env = await testEnv();
  const agent = scripted(env);
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const first = [];
  const second = [];
  try {
    const socketA = await connect(web, first);
    await tick();
    const answer = agent._question.ask([{ question: "Pick", header: "H", options: [{ label: "A" }] }]);
    expect(await until(() => first.some((m) => m.type === "question.open"))).toBe(true);
    socketA.close();
    const socketB = await connect(web, second);
    expect(await until(() => second.some((m) => m.type === "question.open"))).toBe(true);
    const { requestId } = second.find((m) => m.type === "question.open");
    socketB.send(JSON.stringify({ type: "question.answer", requestId, answers: [{ labels: ["A"] }] }));
    expect(await answer).toEqual([{ labels: ["A"] }]);
    socketB.close();
  } finally { web.stop(); }
});

test("a run that throws ends the turn with an error terminal (indicators never stick)", async () => {
  const env = await testEnv();
  const agent = new Agent({ env, model: "p/m", context: [], createIO: () => { throw new Error("no usable endpoint"); } });
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    await tick();
    socket.send(JSON.stringify({ type: "chat.submit", text: "hi" }));
    expect(await until(() => received.some((m) => m.type === "turn.end"))).toBe(true);
    const end = received.find((m) => m.type === "turn.end");
    expect(end.terminal).toMatchObject({ type: "error" });
    expect(end.busy).toBe(false);
    socket.close();
  } finally { web.stop(); }
});

test("collapsed-preview rows come from each theme's <role>.preview.maxRows (TUI defaults otherwise)", async () => {
  const env = await testEnv();
  env.settings.tui = { themes: {
    tall: { "tool.preview": { maxRows: 12 }, "message.thinking.preview": { maxRows: false } },
    child: { parent: "tall", "message.system.preview": { maxRows: 3 } },
    broken: { "tool.preview": { maxRows: -1 } },
  } };
  const web = await serve({ port: 0, env, createSession: async () => ({ agent: scripted(env) }) });
  const received = [];
  try {
    const socket = await connect(web, received);
    expect(await until(() => received.some((m) => m.type === "settings"))).toBe(true);
    const rows = received.find((m) => m.type === "settings").prefs.previewRows;
    expect(rows.default).toEqual({ system: 8, thinking: 8, tool: 7 });
    expect(rows.tall).toEqual({ system: 8, thinking: false, tool: 12 });
    expect(rows.child).toEqual({ system: 3, thinking: false, tool: 12 }); // parent chain
    expect(rows.broken.tool).toBe(7); // invalid values fall back
    socket.close();
  } finally { web.stop(); }
});

test("a failed response replays as an error block; retracting it resyncs the browser", async () => {
  const env = await testEnv({ retry: { attempts: 1 } });
  const failed = { type: 3, content: [], error: "socket hang up" };
  const io = scriptedIO([[{ type: "start" }, { type: "error", error: "socket hang up", kind: "network", message: failed }], [{ type: "start" }, ...TEXT(0, "answer"), { type: "done" }]]);
  const agent = new Agent({ env, model: "p/m", context: [Context.messageUser("go")], createIO: () => io });
  const session = new AgentSession(agent);
  const sent = [];
  session.addSink((packet) => sent.push(packet));
  await agent.run();
  expect(session.historySnapshot().at(-1)).toMatchObject({ kind: "error", text: "socket hang up", retry: true });

  await agent.run(); // continue without a reply: the failed response is retracted
  const resync = sent.find((packet) => packet.type === "history");
  expect(resync.history.some((block) => block.kind === "error")).toBe(false);
  expect(session.historySnapshot().some((block) => block.kind === "error")).toBe(false);
  session.dispose();
});
