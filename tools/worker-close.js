import { workersMatching, requireControl, targetsSchema, send } from "./worker/common.js";

export async function worker_close(args = {}, context = {}) {
  const agent = context.agent;
  if (!agent) throw new Error("Run worker-close from an agent with workers.");
  const workers = workersMatching(agent, args.workers);
  await requireControl(agent, context, workers.map((worker) => worker.name).join(", "));
  const settled = await Promise.allSettled(workers.map(async (worker) => {
    if (worker.busy) send(worker, "/handoff");
    await worker.close();
    return `${worker.name}: closed`;
  }));
  const failures = settled.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "Worker close failed");
  return settled.map((result) => result.value).join("\n") || "No workers.";
}

export function toolDescription() {
  return { "worker-close": {
    fn: worker_close, trusted: true,
    description: "Close named workers, /regex/ matches, or all with [\"*\"]. Busy workers are asked to hand off their work first.",
    inputSchema: { type: "object", additionalProperties: false, required: ["workers"], properties: { workers: targetsSchema } },
  } };
}
