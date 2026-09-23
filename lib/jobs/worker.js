// Executed-only jobs worker. No CLI parsing, login wizard, or interactive host.
import { runJobAgent } from "./agent-execution.js";
let started = false, agent, cancelled = false;
process.on("message", async (message) => {
  if (message?.type === "cancel") { cancelled = true; void agent?.cancel(); return; }
  if (message?.type !== "start" || started) return;
  started = true;
  const result = await runJobAgent(message.task, {
    projectRoot: message.projectRoot, session: message.sessionId, defaultModel: message.model,
    environment: message.environment,
    onAgent(value) { agent = value; if (cancelled) void agent.cancel(); },
    onReady(value) { if (cancelled) throw new Error("cancelled before execution"); process.send?.({ type: "ready", ...value }); },
  });
  process.send?.({ type: "terminal", ...result }, () => process.exit(0));
});
process.on("disconnect", () => process.exit(1));
