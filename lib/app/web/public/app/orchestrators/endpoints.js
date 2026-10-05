/** endpoints packet and intent handlers. */
export const endpoints = {
  packets: {
    "endpoints": (ctx, m) => { ctx.state.endpoints = { endpoints: m.endpoints ?? [], presets: m.presets ?? [], removable: m.removable ?? [], providers: m.providers ?? [], policies: m.policies ?? [] };
      ctx.invalidate("panels");
    },
    "oauth": (ctx, m) => {
      const oauth = ctx.state.oauthState;
      if (m.state === "url") ctx.state.oauthState = { ...oauth, active: true, url: m.url };
      else if (m.state === "log") ctx.state.oauthState = { ...oauth, active: true, lines: [...oauth.lines, m.text].slice(-20) };
      else if (m.state === "done" || m.state === "error") {
        ctx.state.oauthState = { ...oauth, active: false, done: m.state === "done", error: m.state === "error", lines: [...oauth.lines, m.text] };
        ctx.toast(m.text, m.state === "error");
      }
      ctx.invalidate("panels");
    },
  },
  intents: {},
};
