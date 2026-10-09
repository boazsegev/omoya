export function worker_status(args = {}, context = {}) {
  const agent = context.agent;
  if (!agent) throw new Error("Run worker-status from an agent.");
  const both = args.workers !== true && args.models !== true && args.commands !== true;
  const lines = [];
  if (both || args.workers === true) {
    for (const [heading, workers] of [
      ["Busy Workers", agent.children.filter((worker) => worker.busy)],
      ["Idle Workers", agent.children.filter((worker) => !worker.busy)],
    ]) {
      if (workers.length) lines.push(heading, ...workers.map((worker) => `    ${worker.name} (${worker.model})`));
    }
  }
  if (both || args.models === true) {
    const models = [...agent.env.models()];
    if (models.length) lines.push("Models", ...models.map(([model, { available }]) => `    ${model} (available: ${available})`));
  }
  if (both || args.commands === true) {
    // Workers' Agents handle these in delivered messages (lib/agent/trim-user.js).
    const prompts = [...agent.env.prompts().values()].sort((a, b) => a.name.localeCompare(b.name));
    lines.push("Commands (start a worker-message with one)",
      "    /compact [focus] — compact the worker's context before it continues",
      ...prompts.map(({ name, description }) => `    /${name} [text] — ${String(description ?? "").replace(/\s+/g, " ").trim() || "run this prompt"}`));
  }
  return lines.join("\n") || "No workers or models.";
}

export function toolDescription() {
  return { "worker-status": {
    fn: worker_status, trusted: true, safe: true,
    description: "Show workers (busy/idle), models with free capacity, and the commands a message may start with (/compact, /<prompt>). Omit flags for all sections. Not for worker polling / busy waiting (just finish your turn and they will update you when they're done).",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      workers: { type: "boolean", description: "Include workers and their models." },
      models: { type: "boolean", description: "Include models and their free capacity." },
      commands: { type: "boolean", description: "Include message commands." },
    } },
  } };
}
