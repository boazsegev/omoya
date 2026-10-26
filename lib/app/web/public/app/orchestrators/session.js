/** session packet and intent handlers. */
import { agentKey, agentTree, sameAgent, sortedAgents } from "../logic/agents.js";
import { themePreferencesEqual } from "../logic/theme.js";
import { snapshotsEqual } from "../logic/equal.js";
export const session = {
  packets: {
    "hello": (ctx, m) => {
      const switched = !sameAgent(ctx.state.agent, m.agent);
      if (switched) { ctx.state.resetTranscript = true; ctx.state.stickBottom = true; } // agent switch lands at the latest message
      ctx.showThrottle(m.throttledUntil ?? null);
      ctx.state.agent = m.agent ?? null;
      ctx.state.toolMessages = m.agent?.toolMessages ?? [];
      if (switched) ctx.state.toolDataExpanded = false;
      const previousUploadKey = ctx.state.uploadKey;
      ctx.state.uploadKey = typeof m.uploadKey === "string" ? m.uploadKey : ctx.state.uploadKey;
      ctx.state.draftAttachments = [...(ctx.state.composerByAgent.get(agentKey(ctx.state.agent))?.attachments ?? [])];
      if (previousUploadKey && previousUploadKey !== ctx.state.uploadKey) {
        for (const draft of ctx.state.composerByAgent.values()) draft.attachments = [];
        ctx.state.draftAttachments = [];
      }
      if (Array.isArray(m.history)) ctx.setHistory(m.history, !switched);
      if (Array.isArray(m.queue)) ctx.state.queuedMessages = m.queue;
      if (Array.isArray(m.projects)) ctx.state.projects = m.projects;
      if (["all", "group", "project"].includes(m.scope)) { ctx.state.scope = m.scope; ctx.state.group = typeof m.group === "string" ? m.group : null; }
      if (typeof m.canManageProjects === "boolean") ctx.state.canManageProjects = m.canManageProjects;
      if (m.catalog) ctx.state.catalog = { commands: m.catalog.commands ?? [], hints: m.catalog.hints ?? {}, prompts: m.catalog.prompts ?? [], tools: m.catalog.tools ?? [], toolSchemas: m.catalog.toolSchemas ?? [] };
      if (m.status) ctx.state.usage = m.status;
      if (switched) { ctx.state.contextBlocks = []; ctx.state.contextTools = null; ctx.state.contextView = null; ctx.invalidate("viewer"); }
      ctx.invalidate("shell"); ctx.invalidate("composer"); ctx.invalidate("transcript"); ctx.invalidate("header"); ctx.invalidate("sidebar"); ctx.invalidate("usage"); ctx.invalidate("toolData");
    },
    "projects": (ctx, m) => {
      const scope = ["all", "group", "project"].includes(m.scope) ? m.scope : ctx.state.scope;
      const group = ["all", "group", "project"].includes(m.scope) ? (typeof m.group === "string" ? m.group : null) : ctx.state.group;
      if (snapshotsEqual(ctx.state.projects, m.projects ?? ctx.state.projects) && ctx.state.scope === scope && ctx.state.group === group && ctx.state.canManageProjects === (m.canManageProjects === true)) return;
      if (Array.isArray(m.projects)) ctx.state.projects = m.projects;
      if (["all", "group", "project"].includes(m.scope)) { ctx.state.scope = m.scope; ctx.state.group = typeof m.group === "string" ? m.group : null; }
      ctx.state.canManageProjects = m.canManageProjects === true;
      ctx.invalidate("header"); ctx.invalidate("sidebar"); ctx.invalidate("panels");
    },
    "project.added": (_ctx, m) => { if (typeof m.url === "string" && /^\/(?:[^/?#]+\/)*$/.test(m.url)) location.href = m.url; },
    "project.removed": (_ctx, m) => { if (typeof m.url === "string" && /^\/(?:[^/?#]+\/)*$/.test(m.url)) location.href = m.url; },
    // Same-origin paths only, optionally resuming a saved session there.
    "navigate": (_ctx, m) => { if (typeof m.url === "string" && /^\/(?:[^/?#]+\/)*(?:\?resume=[^#&]+)?$/.test(m.url)) location.href = m.url; },
    "sessions": (ctx, m) => { const next = { agents: sortedAgents(m.agents ?? []), recent: m.recent ?? ctx.state.sessions.recent };
      if (snapshotsEqual(ctx.state.sessions, next)) return;
      ctx.state.sessions = next;
      // The running-agents list is the freshest report of the viewed agent's
      // busy flag — fold it in so every sessions push keeps the Stop button
      // and the composer working-animation current (no agent switch needed).
      if (ctx.state.agent) { const mine = ctx.state.sessions.agents.flatMap(agentTree).find((item) => sameAgent(item, ctx.state.agent)); if (mine) ctx.state.agent = { ...ctx.state.agent, ...mine, toolMessages: ctx.state.agent.toolMessages, busy: mine.state === "working", state: mine.state }; }
      ctx.invalidate("sidebar"); ctx.invalidate("header"); ctx.invalidate("composer");
    },
    "agent": (ctx, m) => { if (ctx.state.agent && m.agent) {
        // "idle" is authoritative even before the run's finally flips busy.
        const next = m.agent.state === "idle" ? { ...m.agent, busy: false } : m.agent;
        if (m.status && !snapshotsEqual(ctx.state.usage, m.status)) { ctx.state.usage = m.status; ctx.invalidate("usage"); }
        if (snapshotsEqual(ctx.state.agent, next)) return;
        ctx.state.agent = next;
        if (!snapshotsEqual(ctx.state.toolMessages, next.toolMessages ?? [])) { ctx.state.toolMessages = next.toolMessages ?? []; ctx.invalidate("toolData"); }
        ctx.invalidate("header"); ctx.invalidate("composer"); ctx.invalidate("transcript");
      }
    },
    "settings": (ctx, m) => { const previousModel = ctx.state.settings.endpoint ? `${ctx.state.settings.endpoint}/${ctx.state.settings.model ?? "?"}` : null;
      // Env settings and agent/UI readouts are different namespaces. Each
      // packet is an authoritative snapshot, not a patch or a key whitelist.
      const { type: _type, settings, prefs, ...readouts } = m;
      const envChanged = !snapshotsEqual(ctx.state.envSettings, settings ?? {});
      if (envChanged) ctx.state.envSettings = settings ?? {};
      const nextSettings = {
        ...readouts,
        safe: !!m.safe,
        thinking: m.thinking ?? "default",
        sessionSave: typeof m.sessionSave === "boolean" ? m.sessionSave : undefined,
        can: { write: m.can?.write !== false, delegate: m.can?.delegate ?? null, request: m.can?.request ?? null },
        delegationLocked: m.delegationLocked === true,
        requestLocked: m.requestLocked === true,
        endpoint: m.endpoint ?? null,
        model: m.model ?? null,
        models: m.models ?? [],
        exitRequested: m.exitRequested === true,
        restarts: m.restarts === true,
      };
      const previousSettings = ctx.state.settings;
      const readoutsChanged = !snapshotsEqual(previousSettings, nextSettings);
      if (readoutsChanged) ctx.state.settings = nextSettings;
      if (prefs && !snapshotsEqual(ctx.state.prefs, prefs)) {
        const previous = ctx.state.prefs;
        ctx.state.prefs = prefs;
        if (previous.autocomplete !== prefs.autocomplete || !snapshotsEqual(previous.thinkingLevels, prefs.thinkingLevels)) ctx.invalidate("autocomplete");
        if (!themePreferencesEqual(previous, prefs) || !snapshotsEqual(previous.thinkingLevels, prefs.thinkingLevels)) ctx.invalidate("panels");
        if (!themePreferencesEqual(previous, prefs)) ctx.invalidate("theme");
        if (previous.themeStylesVersion !== prefs.themeStylesVersion || previous.themeStylesUrl !== prefs.themeStylesUrl) ctx.invalidate("themeStyles");
        for (const block of ctx.state.blocks ?? []) {
          const key = block.kind === "thinking" ? "thinking" : block.kind === "tool" ? "tools" : null;
          if (key && previous.collapse?.[key] !== prefs.collapse?.[key]) block.open = prefs.collapse?.[key] === false || block.kind === "tool" && block.state === "error";
        }
        const display = (value) => [value.collapse, value.previewRows, value.activeTheme ?? value.theme];
        if (!snapshotsEqual(display(previous), display(prefs))) {
          ctx.state.fullRender = true;
          ctx.invalidate("transcript");
        }
      }
      const fieldsChanged = (keys) => keys.some((key) => !snapshotsEqual(previousSettings[key], nextSettings[key]));
      if (fieldsChanged(["safe", "sessionSave"])) ctx.invalidate("header");
      if (fieldsChanged(["safe", "thinking", "sessionSave", "can", "delegationLocked", "requestLocked", "endpoint", "model", "exitRequested", "restarts"])) ctx.invalidate("composer");
      if (fieldsChanged(["safe", "thinking", "sessionSave", "can", "delegationLocked", "requestLocked", "endpoint", "model", "models", "exitRequested", "restarts"])) ctx.invalidate("panels");
      const currentModel = ctx.state.settings.endpoint ? `${ctx.state.settings.endpoint}/${ctx.state.settings.model ?? "?"}` : null;
      if (previousModel !== currentModel) ctx.invalidate("transcript");
      if (ctx.state.contextView && (envChanged || readoutsChanged)) { ctx.state.contextTools = null; ctx.send({ type: "context.inspect" }); }
      if (envChanged) ctx.settingsChanged?.(ctx.state.envSettings);
    },
    "history": (ctx, m) => { if (Array.isArray(m.history)) ctx.setHistory(m.history);
    },
  },
  intents: {},
};
