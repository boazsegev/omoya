/** session packet and intent handlers. */
import { agentKey, sameAgent } from "../logic/agents.js";
export const session = {
  packets: {
    "hello": (ctx, m) => {
      const switched = !sameAgent(ctx.state.agent, m.agent);
      if (switched) { ctx.state.resetTranscript = true; ctx.state.stickBottom = true; } // agent switch lands at the latest message
      ctx.showThrottle(m.throttledUntil ?? null);
      ctx.state.agent = m.agent ?? null;
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
      ctx.invalidate("shell"); ctx.invalidate("composer"); ctx.invalidate("transcript"); ctx.invalidate("header"); ctx.invalidate("sidebar"); ctx.invalidate("usage");
    },
    "projects": (ctx, m) => {
      if (Array.isArray(m.projects)) ctx.state.projects = m.projects;
      if (["all", "group", "project"].includes(m.scope)) { ctx.state.scope = m.scope; ctx.state.group = typeof m.group === "string" ? m.group : null; }
      ctx.state.canManageProjects = m.canManageProjects === true;
      ctx.invalidate("header"); ctx.invalidate("sidebar"); ctx.invalidate("panels");
    },
    "project.added": (_ctx, m) => { if (typeof m.url === "string" && /^\/(?:[^/?#]+\/)*$/.test(m.url)) location.href = m.url; },
    "project.removed": (_ctx, m) => { if (typeof m.url === "string" && /^\/(?:[^/?#]+\/)*$/.test(m.url)) location.href = m.url; },
    // Same-origin paths only, optionally resuming a saved session there.
    "navigate": (_ctx, m) => { if (typeof m.url === "string" && /^\/(?:[^/?#]+\/)*(?:\?resume=[^#&]+)?$/.test(m.url)) location.href = m.url; },
    "sessions": (ctx, m) => { ctx.state.sessions = { agents: m.agents ?? [], recent: m.recent ?? [] };
      // The running-agents list is the freshest report of the viewed agent's
      // busy flag — fold it in so every sessions push keeps the Stop button
      // and the composer working-animation current (no agent switch needed).
      if (ctx.state.agent) { const mine = ctx.state.sessions.agents.flatMap(function walk(item) { return [item, ...(item.children ?? []).flatMap(walk)]; }).find((item) => sameAgent(item, ctx.state.agent)); if (mine) ctx.state.agent = { ...ctx.state.agent, ...mine, busy: mine.state === "working", state: mine.state }; }
      ctx.invalidate("sidebar"); ctx.invalidate("header"); ctx.invalidate("composer");
    },
    "agent": (ctx, m) => { if (ctx.state.agent && m.agent) {
        ctx.state.agent = m.agent;
        if (m.status) ctx.state.usage = m.status;
        // "idle" is authoritative for not-busy (busy flips only after the
        // run's finally, so a snapshot can briefly carry the mixed pair).
        if (ctx.state.agent.state === "idle") ctx.state.agent.busy = false;
        ctx.invalidate("header"); ctx.invalidate("composer"); ctx.invalidate("transcript");
      }
    },
    "settings": (ctx, m) => { ctx.state.settings = {
        safe: !!m.safe,
        thinking: m.thinking ?? "default",
        sessionSave: typeof m.sessionSave === "boolean" ? m.sessionSave : undefined,
        spawnPermission: m.spawnPermission ?? null,
        delegationLocked: m.delegationLocked === true,
        endpoint: m.endpoint ?? null,
        model: m.model ?? null,
        models: m.models ?? [],
      };
      if (m.prefs) { ctx.state.prefs = { ...ctx.state.prefs, ...m.prefs, collapse: { ...ctx.state.prefs.collapse, ...(m.prefs.collapse ?? {}) } }; ctx.invalidate("theme"); }
      ctx.invalidate("header"); ctx.invalidate("composer"); ctx.invalidate("panels");
      if (ctx.state.contextView) { ctx.state.contextTools = null; ctx.send({ type: "context.inspect" }); }
    },
    "history": (ctx, m) => { if (Array.isArray(m.history)) ctx.setHistory(m.history);
    },
  },
  intents: {},
};
