import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Env from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { scriptedIO, USER, TEXT } from "./fakes.js";

function fixture() {
  const root = mkdtempSync("./ai-tmp/env-hooks-");
  const host = join(root, "host"), user = join(root, "user"), project = join(root, "project");
  for (const dir of [host, user, project]) mkdirSync(dir, { recursive: true });
  return { root, host, user, project };
}
function put(root, file, source) {
  const path = join(root, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source);
}
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

// This recorder is the trusted host's stand-in; no Agent event is invented.
globalThis.__omoyaHookEvents = [];
const observer = (tag) => `export function hooks(env) { return {
  12: (payload, agent) => globalThis.__omoyaHookEvents.push([${JSON.stringify(tag)}, payload, agent, env]),
}; }\n`;

describe("trusted extension Agent hooks", () => {
  test("package/user/extension only, all agents and asynchronous observer delivery", async () => {
    const f = fixture();
    try {
      const ext = join(f.user, "node_modules", "sample-extension");
      put(ext, "package.json", '{"name":"sample-extension"}');
      put(f.user, "settings.json", '{"extensions":["sample-extension"]}');
      put(f.host, "hooks/package.js", observer("host"));
      put(ext, "hooks/extension.js", observer("ext"));
      put(f.user, "hooks/user.js", observer("user"));
      put(f.project, "hooks/project.js", "throw new Error('untrusted hook imported');\n");
      put(f.project, "hooks/private/nested.js", "throw new Error('nested hook imported');\n");
      globalThis.__omoyaHookEvents = [];
      const env = await Env.create({ dir: f.host, settingsDir: f.user, cwd: f.project }, { tools: false, providers: false });
      const agent = env.agentCreate();
      const payload = { role: "assistant", content: "hi" };
      agent._emit(Agent.EVENT.MESSAGE_COMMITTED, payload);
      expect(globalThis.__omoyaHookEvents).toHaveLength(0); // event delivery is never held for hooks
      await flush();
      expect(globalThis.__omoyaHookEvents.map(([tag, item, owner, source]) => {
        expect(item).toBe(payload);
        expect(owner).toBe(agent);
        expect(source).toBe(env);
        return tag;
      })).toEqual(["host", "ext", "user"]);
      const later = env.agentCreate();
      later._emit(Agent.EVENT.MESSAGE_COMMITTED, payload);
      await flush();
      expect(globalThis.__omoyaHookEvents.slice(3).map(([, , owner]) => owner)).toEqual([later, later, later]);
      agent.close(); later.close(); env.close();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("sync throws and async rejections report once and cannot break event delivery", async () => {
    const f = fixture();
    try {
      put(f.host, "hooks/failure.js", `export const hooks = () => ({
        12: () => { throw new Error('sync failure'); },
        19: async () => { throw new Error('async failure'); },
      });\n`);
      const env = await Env.create({ dir: f.host, settingsDir: f.user, cwd: f.project }, { tools: false, providers: false });
      const agent = env.agentCreate();
      const logs = [];
      const received = [];
      agent.onEvent(Agent.EVENT.LOG, (line) => logs.push(line));
      agent.onEvent(Agent.EVENT.MESSAGE_COMMITTED, (payload) => received.push(payload));
      for (let i = 0; i < 3; i++) {
        agent._emit(Agent.EVENT.MESSAGE_COMMITTED, i);
        agent._emit(Agent.EVENT.SENT_MESSAGE, i);
      }
      expect(received).toEqual([0, 1, 2]);
      await flush();
      expect(logs).toHaveLength(2);
      expect(logs.join(" ")).toContain("sync failure");
      expect(logs.join(" ")).toContain("async failure");
      agent.close(); env.close();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("a failing hook does not alter a real provider turn", async () => {
    const f = fixture();
    try {
      put(f.host, "hooks/fail.js", "export const hooks = () => ({ 12: () => { throw Error('ignored'); } });\n");
      const env = await Env.create({ dir: f.host, settingsDir: f.user, cwd: f.project }, { tools: false, providers: false });
      env._endpoints.fake = { provider: "fake", models: { m: {} } };
      const io = scriptedIO([[...TEXT(0, "response"), { type: "done" }]]);
      const agent = env.agentCreate({ model: "fake/m", context: [USER("hello")], createIO: () => io });
      const logs = [];
      agent.onEvent(Agent.EVENT.LOG, (line) => logs.push(line));
      expect((await agent.run()).type).toBe("done");
      await flush();
      expect(logs).toHaveLength(1);
      agent.close(); env.close();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("tool-refresh reloads hooks on already-created agents, absent folder stays empty", async () => {
    const f = fixture();
    try {
      const env = await Env.create({ dir: f.host, settingsDir: f.user, cwd: f.project }, { tools: false, providers: false });
      const agent = env.agentCreate();
      expect(env._hookEntries).toEqual([]);
      expect(env._hookHandles.size).toBe(0);
      globalThis.__omoyaHookEvents = [];
      put(f.user, "hooks/new.js", observer("added"));
      await env.toolCall("tool-refresh", {});
      agent._emit(Agent.EVENT.MESSAGE_COMMITTED, "first");
      await flush();
      expect(globalThis.__omoyaHookEvents).toHaveLength(1);
      await env.toolCall("tool-refresh", {});
      agent._emit(Agent.EVENT.MESSAGE_COMMITTED, "second");
      await flush();
      expect(globalThis.__omoyaHookEvents).toHaveLength(2); // no duplicate registrations
      agent.close(); env.close();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
