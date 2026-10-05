/** questions packet and intent handlers. */
export const questions = {
  packets: {
    "question.open": (ctx, m) => { ctx.state.openQuestion = { requestId: m.requestId, questions: m.questions ?? [] }; ctx.invalidate("questions");
    },
    "question.close": (ctx, m) => { if (!m.requestId || ctx.state.openQuestion?.requestId === m.requestId) { ctx.state.openQuestion = null; ctx.invalidate("questions"); }
    },
  },
  intents: {},
};
