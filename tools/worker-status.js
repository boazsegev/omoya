export function worker_status(args = {}, context = {}) {
  const agent = context.agent;
  if (!agent) throw new Error("Run worker-status from an agent.");
  const both = args.workers !== true && args.models !== true;
  const lines = [];
  if (both || args.workers === true) {
    for (const [heading, workers] of [
      ["Busy Workers", agent.children.filter((worker) => worker.busy)],
      ["Idle Workers", agent.children.filter((worker) => !worker.busy)],
    ]) {
      if (workers.length) lines.push(heading, ...workers.map((worker) => `    ${worker.name} (${worker.endpoint}/${worker.model})`));
    }
  }
  if (both || args.models === true) {
    const models = [...agent.env.models().values()];
    if (models.length) lines.push("Models", ...models.map(({ endpoint, model, available }) => `    ${endpoint}/${model} (available: ${available})`));
  }
  return lines.join("\n") || "No workers or models.";
}

export function toolDescription() {
  return { "worker-status": {
    fn: worker_status, trusted: true, safe: true,
    description: "Show workers grouped by busy/idle and available models. Omit flags for both; request a specific section with workers or models.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      workers: { type: "boolean", description: "Include workers and their models, grouped by busy/idle." },
      models: { type: "boolean", description: "Include models and available capacity for new work." },
    } },
  } };
}
