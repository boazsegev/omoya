/** context packet and intent handlers. */
export const context = {
  packets: {
    "context": (ctx, m) => { ctx.state.contextBlocks = m.blocks ?? [];
      ctx.state.contextTools = m.tools ?? null;
      if (Array.isArray(m.history)) ctx.setHistory(m.history);
      ctx.invalidate("viewer");
    },
  },
  intents: {},
};
