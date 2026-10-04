import { workersMatching, requireControl, targetsSchema, send } from "./worker/common.js";

export async function worker_close(args = {}, context = {}) {
  const agent = context.agent;
  if (!agent) throw new Error("Run worker-close from an agent with workers.");
  const workers = workersMatching(agent, args.workers);
  await requireControl(agent, context, workers.map((worker) => worker.name).join(", "));
  return workers.map((worker) => {
    try {
      if (worker.busy) send(worker, "/handoff");
      worker.close();
      return `${worker.name}: closing`;
    } catch (error) { return `${worker.name}: ${error.message}`; }
  }).join("\n") || "No workers.";
}

export function toolDescription() {
  return { "worker-close": {
    fn: worker_close, trusted: true,
    description: "Closes named workers, /regex/ matches, or all with [\"*\"]. Busy workers receive /handoff first and finish queued work before closing.",
    inputSchema: { type: "object", additionalProperties: false, required: ["workers"], properties: { workers: targetsSchema } },
  } };
}
