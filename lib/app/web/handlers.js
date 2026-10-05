/** Client packet domain tables; no state escapes a Workspace instance. */
import Agent from "../../agent.js";
import IO from "../../io.js";
import CLI from "../../cli.js";
import { adoptEndpoint, removeEndpoint } from "./commands.js";
import { modelParts } from "../shared/format.js";

function sessionHandlers(workspace) {
  const { registry, env, uploads, send, sendSessions, replaceViewed, makeSession, knownSession, closeAgent, broadcastSessions, broadcast, greet, sendSettings, attach, sendEndpoints, runOAuth, oauth, broadcastEndpoints, broadcastSettings, sendContext, refreshTools, handleCommand, agentInfo, listRecent } = workspace;
  return {
    "project.add": async (entry, parsed) => {
      if (!entry.local) throw new TypeError("adding projects requires a local connection");
      const { url, path } = await registry.add(parsed.path);
      // A multi-project view showing the new project switches in place; other views navigate.
      if (entry.multi && registry.visible(path, entry.group)) await registry.move(entry.ws, path);
      else send(entry, { type: "project.added", url });
    },
    "project.pin": async (entry, parsed) => {
      if (!entry.local) throw new TypeError("pinning projects requires a local connection");
      await registry.pin(parsed.path, parsed.pinned);
    },
    "project.group": async (entry, parsed) => {
      if (!entry.local) throw new TypeError("grouping projects requires a local connection");
      await registry.group(parsed.path, parsed.group, parsed.member);
    },
    "project.remove": async (entry, parsed) => {
      if (!entry.local) throw new TypeError("removing projects requires a local connection");
      await registry.remove(parsed.path);
    },
    "project.select": async (entry, parsed) => {
      if (!entry.multi) throw new TypeError("switching projects in place needs a multi-project view");
      if (parsed.path !== env.cwd) await registry.move(entry.ws, parsed.path);
    },
    "session.list": async (entry, parsed) => { return void await sendSessions(entry); },
    "session.new": async (entry, parsed) => { return void await replaceViewed(entry, parsed.anonymous ? false : undefined, { safe: parsed.safe }); },
    "session.add": async (entry, parsed) => {
      let model;
      if (parsed.model) {
        const combo = await CLI.resolveModelCombo(parsed.model, env, {});
        if (!combo || !modelParts(combo).model) throw new TypeError(`unknown model "${parsed.model}"`);
        model = combo;
      }
      return void await makeSession(entry, undefined, { model, safe: parsed.safe });
    },
    "session.rename": async (entry, parsed) => {
      // no id: the viewed agent's session; an id: that saved session —
      // through the running agent holding it, else on disk directly
      const owner = parsed.id === undefined ? entry.agent : env.agents().find((a) => a.context.id === parsed.id);
      if (parsed.id !== undefined && !owner) {
        await knownSession(parsed.id);
        const result = Agent.Context.renameById({ id: parsed.id, name: parsed.name, dir: env.settings.sessions });
        send(entry, { type: "command.result", text: `session named: ${result.id}` });
        broadcastSessions();
        return;
      }
      if (!owner) throw new TypeError("no active agent");
      const result = owner.context.rename(parsed.name);
      send(entry, { type: "command.result", text: `session named: ${result.id}` });
      broadcast((candidate) => { if (candidate.agent === owner) { greet(candidate); sendSettings(candidate); } });
      broadcastSessions();
      return;
    },
    "session.delete": async (entry, parsed) => {
      await knownSession(parsed.id);
      const owners = env.agents().filter((agent) => agent.context.id === parsed.id);
      if (owners.some((agent) => agent.busy)) throw new TypeError("stop the running turn before deleting this session");
      for (const owner of owners) await closeAgent(owner);
      const { deleted } = Agent.Context.deleteById({ id: parsed.id, dir: env.settings.sessions });
      send(entry, { type: "command.result", text: `session deleted: ${parsed.id}${deleted > 1 ? ` (${deleted} files)` : ""}` });
      broadcastSessions();
      return;
    },
    "session.clear": async (entry, parsed) => {
      if (!entry.agent) throw new TypeError("no active agent");
      if (entry.agent.busy) throw new TypeError("stop the running turn first");
      entry.session.clear();
      greet(entry); broadcastSessions();
      return;
    },
    "agent.rename": async (entry, parsed) => {
      const target = parsed.agentId === undefined ? entry.agent : env.agents().find((a) => a.name === parsed.agentId);
      if (!target) throw new TypeError("unknown agent");
      if (env.agents().some((a) => a !== target && a.name === parsed.name)) throw new TypeError(`another agent is already named "${parsed.name}"`);
      (target.name = parsed.name);
      broadcast((candidate) => { if (candidate.agent === target) send(candidate, { type: "agent", agent: agentInfo(target, target) }); });
      broadcastSessions();
      return;
    },
    "session.fork": async (entry, parsed) => {
      if (!entry.agent) throw new TypeError("no active agent");
      entry.agent.contextFork(parsed.id);
      greet(entry);
      await sendSessions(entry);
      return;
    },
    "session.switch": async (entry, parsed) => {
      const agent = env.agents().find((a) => a.name === parsed.agentId);
      if (!agent) throw new TypeError("unknown agent");
      attach(entry, agent);
      greet(entry);
      await sendSessions(entry);
      sendSettings(entry);
      return;
    },
    "session.close": async (entry, parsed) => {
      const agent = env.agents().find((a) => a.name === parsed.agentId);
      if (!agent) throw new TypeError("unknown agent");
      await closeAgent(agent);
      return;
    },
    "session.resume": async (entry, parsed) => {
      const recent = await listRecent();
      if (!recent.some((item) => item.id === parsed.id)) throw new TypeError("unknown session");
      return void await replaceViewed(entry, parsed.id);
    },
  };
}

function turnHandlers(workspace) {
  const { env, uploads, send, sendSessions, replaceViewed, makeSession, knownSession, closeAgent, broadcastSessions, broadcast, greet, sendSettings, attach, sendEndpoints, runOAuth, oauth, broadcastEndpoints, broadcastSettings, sendContext, refreshTools, handleCommand, agentInfo, listRecent } = workspace;
  return {
    "chat.continue": async (entry, parsed) => {
      if (!entry.session) throw new TypeError("no active agent");
      if (!entry.session.busy) entry.session.continue();
      return;
    },
    "tool.call": async (entry, parsed) => { await entry.session.callTool(parsed.name, parsed.args); await refreshTools(); return; },
    "chat.submit": async (entry, parsed) => {
      if (!entry.agent) await makeSession(entry, null);
      const attachments = parsed.attachments?.length ? await uploads.take(entry.uploadKey, parsed.attachments) : [];
      if (parsed.text.trimStart().startsWith("/")) {
        if (attachments.length) throw new TypeError("commands cannot include attachments");
        await handleCommand(entry, parsed.text);
      } else entry.session.submit(parsed.text, attachments);
      broadcastSessions();
      return;
    },
    "chat.cancel": async (entry, parsed) => { entry.session?.cancel(); return; },
    "chat.unqueue": async (entry, parsed) => {
      const queue = entry.session?.unqueue() ?? { text: "", messages: [] };
      send(entry, { type: "chat.unqueued", ...queue });
      return;
    },
  };
}

function endpointsHandlers(workspace) {
  const { env, uploads, send, sendSessions, replaceViewed, makeSession, knownSession, closeAgent, broadcastSessions, broadcast, greet, sendSettings, attach, sendEndpoints, runOAuth, runMcpOAuth, oauth, broadcastEndpoints, broadcastSettings, sendContext, refreshTools, handleCommand, agentInfo, listRecent } = workspace;
  return {
    "mcp.oauth": async (entry, parsed) => { void runMcpOAuth(parsed.name).catch((error) => send(entry, { type: "error", message: error.message })); },
    "mcp.oauth-paste": async (entry, parsed) => { oauth({ state: "log", text: env.mcpPaste(parsed.input) ? "MCP redirect received" : "no MCP sign-in in progress" }); },
    "endpoint.list": async (entry, parsed) => { sendEndpoints(entry); return; },
    "endpoint.login": async (entry, parsed) => {
      const result = await CLI.loginEndpoint(env, { scope: parsed.scope, name: parsed.name, provider: parsed.provider, url: parsed.url, token: parsed.token });
      const selected = entry.agent ? adoptEndpoint(entry.agent, result.name) : result.name;
      send(entry, { type: "command.result", text: `endpoint saved: ${result.name} (${parsed.provider} at ${parsed.url}, ${parsed.scope}) — model: ${selected}` });
      broadcastEndpoints();
      return;
    },
    "endpoint.oauth": async (entry, parsed) => { void runOAuth(entry, parsed.name).catch((error) => send(entry, { type: "error", message: error?.message ?? String(error) })); return; },
    "endpoint.oauth-paste": async (entry, parsed) => {
      const accepted = CLI.completeOAuthPaste(parsed.input);
      oauth({ state: "log", text: accepted ? "sign-in redirect received — completing the login" : "no browser sign-in is in progress" });
      return;
    },
    "endpoint.policy": async (entry, parsed) => {
      // JSON has no undefined: null asks to inherit (removes the override)
      const change = parsed.change.maxActive === null ? { maxActive: undefined } : parsed.change;
      CLI.endpointPolicySet(env, parsed.selector, change);
      broadcastEndpoints();
      return;
    },
    "endpoint.logout": async (entry, parsed) => {
      const removed = removeEndpoint(entry.agent ?? { env }, parsed.name);
      for (const candidate of env.agents()) if (modelParts(candidate.model).endpoint === removed.name) (candidate.model = undefined);
      send(entry, { type: "command.result", text: `endpoint removed: ${removed.name}${removed.dynamic ? " (environment-defined — it re-detects while the environment provides it)" : ""}` });
      broadcastEndpoints();
      return;
    },
  };
}

function contextHandlers(workspace) {
  const { env, uploads, send, sendSessions, replaceViewed, makeSession, knownSession, closeAgent, broadcastSessions, broadcast, greet, sendSettings, attach, sendEndpoints, runOAuth, oauth, broadcastEndpoints, broadcastSettings, sendContext, refreshTools, handleCommand, agentInfo, listRecent } = workspace;
  return {
    "context.inspect": async (entry, parsed) => { await sendContext(entry); return; },
    "context.edit-text": async (entry, parsed) => { entry.session.editText(parsed.messageIndex, parsed.blockIndex, parsed.text); await sendContext(entry); return; },
    "context.rollback": async (entry, parsed) => { entry.session.rollback(parsed.messageIndex); await sendContext(entry); return; },
    "context.pop": async (entry, parsed) => { entry.session.pop(); await sendContext(entry); return; },
    "context.delete": async (entry, parsed) => { entry.session.deleteMessages(parsed.messageIndexes); await sendContext(entry, { history: true }); return; },
  };
}

function questionsHandlers(workspace) {
  const { env, uploads, send, sendSessions, replaceViewed, makeSession, knownSession, closeAgent, broadcastSessions, broadcast, greet, sendSettings, attach, sendEndpoints, runOAuth, oauth, broadcastEndpoints, broadcastSettings, sendContext, refreshTools, handleCommand, agentInfo, listRecent } = workspace;
  return {
    "question.answer": async (entry, parsed) => { entry.session?.answerQuestion(parsed.requestId, parsed.answers); return; },
  };
}

function prefsHandlers(workspace) {
  const { env, uploads, send, sendSessions, replaceViewed, makeSession, knownSession, closeAgent, broadcastSessions, broadcast, greet, sendSettings, attach, sendEndpoints, runOAuth, oauth, broadcastEndpoints, broadcastSettings, sendContext, refreshTools, handleCommand, agentInfo, listRecent } = workspace;
  return {
    "settings.spawn": async (entry, parsed) => {
      if (entry.agent) (entry.agent.spawnPermission = parsed.value === null ? undefined : parsed.value);
      sendSettings(entry);
      return;
    },
    "settings.theme": async (entry, parsed) => {
      if (!["system", "light", "dark", "default"].includes(parsed.name)) {
        if (!env.settings.tui.themes?.[parsed.name]) throw new TypeError(`unknown web theme: ${parsed.name}`);
      }
      const name = parsed.name === "default" ? "system" : parsed.name;
      env.settings.web.theme = name;
      broadcastSettings();
      return;
    },
    "settings.safe": async (entry, parsed) => {
      if (entry.agent) (entry.agent.safe = parsed.on);
      sendSettings(entry);
      return;
    },
    "settings.thinking": async (entry, parsed) => {
      if (!["default", ...IO.THINKING_LEVELS].includes(parsed.level)) throw new TypeError(`unknown thinking level "${parsed.level}" (use default/${IO.THINKING_LEVELS.join("/")})`);
      if (entry.agent) (entry.agent.thinking = parsed.level === "default" ? undefined : parsed.level);
      sendSettings(entry);
      return;
    },
    "settings.session-save": async (entry, parsed) => {
      if (!entry.agent) throw new TypeError("no active agent");
      (entry.agent.context.save = parsed.on); // on writes the whole conversation so far
      sendSettings(entry);
      await sendSessions(entry);
      return;
    },
    "settings.model": async (entry, parsed) => {
      if (entry.agent) {
        const combo = await CLI.resolveModelCombo(parsed.model, env);
        if (!combo || !modelParts(combo).model) throw new TypeError(`unknown model "${parsed.model}" (pick one from the settings list)`);
        (entry.agent.model = combo);
      }
      sendSettings(entry);
      broadcastSessions();
      return;
    },
  };
}

/** Compose all domain handlers, refusing ambiguous protocol ownership. */
export function composePacketHandlers(tables) {
  const handlers = Object.create(null);
  for (const table of tables) for (const [type, handler] of Object.entries(table)) {
    if (Object.hasOwn(handlers, type)) throw new Error(`duplicate web packet type: ${type}`);
    handlers[type] = handler;
  }
  return handlers;
}

export function createPacketHandlers(workspace) {
  return composePacketHandlers([sessionHandlers(workspace), turnHandlers(workspace), endpointsHandlers(workspace), contextHandlers(workspace), questionsHandlers(workspace), prefsHandlers(workspace)]);
}
