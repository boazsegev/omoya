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
    description: "Shows workers grouped by busy/idle, available models, and the commands a worker accepts at the start of a message (/compact, /<prompt>). Omit flags for all; request sections with workers, models, or commands.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      workers: { type: "boolean", description: "Includes workers and their models, grouped by busy/idle." },
      models: { type: "boolean", description: "Includes models and available capacity for new work." },
      commands: { type: "boolean", description: "Includes /compact and the prompt commands workers expand." },
    } },
  } };
}
