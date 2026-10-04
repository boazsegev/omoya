import { workersMatching, requireControl, requirePrompt, targetsSchema, send } from "./worker/common.js";

export async function worker_message(args = {}, context = {}) {
  const agent = context.agent;
  if (!agent) throw new Error("Run worker-message from an agent with workers.");
  requirePrompt(args.prompt);
  const workers = workersMatching(agent, args.workers);
  await requireControl(agent, context, workers.map((worker) => worker.name).join(", "), args.prompt);
  return workers.map((worker) => {
    try { send(worker, args.prompt); return `${worker.name}: queued`; }
    catch (error) { return `${worker.name}: ${error.message}`; }
  }).join("\n") || "No workers.";
}

export function toolDescription() {
  return { "worker-message": {
    fn: worker_message, trusted: true,
    description: "Sends one prompt to named workers, /regex/ matches, or all with [\"*\"]. Replies arrive automatically as attributed messages; finish your turn rather than waiting.",
    inputSchema: { type: "object", additionalProperties: false, required: ["workers", "prompt"], properties: {
      workers: targetsSchema,
      prompt: { type: "string", minLength: 1, description: "Message sent unchanged to every selected worker; /handoff requests a handoff." },
    } },
  } };
}
