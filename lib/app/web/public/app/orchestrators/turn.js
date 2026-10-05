/** turn packet and intent handlers. */
import { agentKey } from "../logic/agents.js";
export const turn = {
  packets: {
    "chat.user": (ctx, m) => { ctx.pushBlock({ kind: "user", text: m.message?.text ?? "", attachments: m.message?.attachments, done: true });
    },
    "chat.queue": (ctx, m) => { ctx.state.queuedMessages = Array.isArray(m.messages) ? m.messages : []; ctx.invalidate("composer");
    },
    "chat.unqueued": (ctx, m) => { ctx.state.queuedMessages = Array.isArray(m.messages) ? m.messages : [];
      ctx.state.composerFill = [m.text ?? "", ctx.state.composerFill ?? ctx.state.composerByAgent.get(agentKey(ctx.state.agent))?.text ?? ""].filter(Boolean).join("\n\n");
      ctx.invalidate("composer");
    },
    "turn.throttled": (ctx, m) => { ctx.showThrottle(m.until);
      if (m.until && ctx.state.agent) { ctx.state.agent = { ...ctx.state.agent, busy: false, state: "idle" }; ctx.invalidate("composer"); ctx.invalidate("sidebar"); }
    },
    "turn.start": (ctx, m) => { ctx.showThrottle(null);
      ctx.settleCurrent();
      if (m.status) ctx.state.usage = m.status;
      // busy flips BEFORE the request's first START, so this report — not a
      // stale snapshot — is what lights the Stop button / working animation.
      if (ctx.state.agent && m.busy === true) ctx.state.agent = { ...ctx.state.agent, busy: true, state: "working" };
      ctx.invalidate("usage"); ctx.invalidate("header"); ctx.invalidate("composer"); ctx.invalidate("transcript");
    },
    "turn.delta": (ctx, m) => { ctx.onDelta(m);
    },
    "turn.end": (ctx, m) => { ctx.onTurnEnd(m);
    },
    "tool.call.start": (ctx, m) => { ctx.startToolCall(m);
    },
    "tool.call.delta": (ctx, m) => { ctx.appendToolCall(m);
    },
    "tool.call.end": (ctx, m) => { ctx.finishToolCall(m);
    },
    "tool.execute": (ctx, m) => { ctx.startToolAnswer(m);
    },
    "tool.data": (ctx, m) => { ctx.appendToolData(m);
    },
    "tool.result": (ctx, m) => { ctx.finishTool(m); if (ctx.state.contextView) { ctx.state.contextTools = null; ctx.send({ type: "context.inspect" }); }
    },
    "command.result": (ctx, m) => { ctx.pushBlock({ kind: "command", text: m.text ?? "", done: true });
    },
    "command.open": (ctx, m) => { ctx.state.openView = { view: m.view, packet: m }; ctx.invalidate("panels");
    },
    "command.copy": (ctx, m) => { ctx.copyText(m.text ?? "", "Copied the last response");
    },
    "command.fill": (ctx, m) => { ctx.state.composerFill = m.text ?? ""; ctx.invalidate("composer");
    },
    "command.exit": (ctx, m) => { ctx.toast(ctx.state.sessions.agents.flatMap(function walk(item) { return [item, ...(item.children ?? []).flatMap(walk)]; }).length > 1 ? "Agent closed" : "Agent closed — start a new chat to continue");
    },
    "error": (ctx, m) => { ctx.toast(m.message ?? "error", true);
    },
  },
  intents: {},
};
