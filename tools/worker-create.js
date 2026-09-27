import Context from "../lib/context.js";
import { requireControl, NOTICE, send } from "./worker/common.js";

export async function worker_create(args = {}, context = {}) {
  const agent = context.agent;
  if (!agent) throw new Error("Run worker-create from an agent that can create workers.");
  if (!Array.isArray(args.workers) || !args.workers.length) throw new Error("Provide at least one worker.");
  const prompt = args.prompt;
  if (prompt !== undefined && typeof prompt !== "string") throw new Error("Provide a text prompt or omit it.");
  const starts = Boolean(prompt?.trim());
  const names = new Set();
  for (const worker of args.workers) {
    if (!worker || typeof worker.name !== "string" || !worker.name.trim() || worker.name === "*") throw new Error("Give each worker a non-empty name other than *.");
    if (names.has(worker.name)) throw new Error(`Choose another worker name; ${JSON.stringify(worker.name)} occurs twice.`);
    names.add(worker.name);
    if (worker.thinking !== undefined && !["none", "low", "medium", "high", "xhigh", "max"].includes(worker.thinking)) throw new Error(`Choose a valid thinking level for ${worker.name}.`);
  }
  const chosen = args.workers.map((worker) => worker.model ?? (agent.endpoint && agent.model ? `${agent.endpoint}/${agent.model}` : undefined));
  const details = args.workers.map((worker, i) => `${worker.name}: ${chosen[i] ?? "no model selected"}`).join("\n");
  await requireControl(agent, context, details, prompt);
  for (const model of chosen) {
    const pair = agent.env.models().get(model);
    if (agent.spawnPermission !== true || !(pair?.available > 0)) {
      throw new Error(`Cannot create workers using ${model ?? "an unspecified model"}${model && !pair ? ": unknown model" : ""}; use worker-status to check available models and permission.`);
    }
  }
  const created = [];
  try {
    for (const worker of args.workers) {
      const child = agent.childCreate({ name: worker.name, model: worker.model, description: worker.description ?? "", safe: worker.safe === true });
      created.push(child);
      if (worker.thinking !== undefined) child.thinkingSet(worker.thinking);
      child.context.append(Context.messageSystem(NOTICE));
    }
  } catch (error) {
    for (const worker of created) worker.close();
    throw new Error(`No workers created; fix the request and retry: ${error.message}`);
  }
  if (starts) for (const worker of created) send(worker, prompt);
  return created.map((worker) => `${worker.name} (${worker.endpoint}/${worker.model}): ${starts ? "started" : "idle; send a task with worker-message"}`).join("\n");
}

export function toolDescription(env) {
  const candidates = [...(env?.models?.().keys() ?? [])];
  return { "worker-create": {
    fn: worker_create, trusted: true,
    description: "Create named workers and send the same self-contained first prompt to each. State role, task, context, constraints, deliverable, and acceptance checks. Replies arrive automatically as attributed messages; finish your turn rather than waiting.",
    inputSchema: { type: "object", additionalProperties: false, required: ["prompt", "workers"], properties: {
      prompt: { type: "string", minLength: 1, description: "Self-contained first prompt sent unchanged to each worker." },
      workers: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["name"], properties: {
        name: { type: "string", minLength: 1, description: "Unique worker name." },
        model: { type: "string", description: "Endpoint/model; omit to use your model.", ...(candidates.length ? { enum: candidates } : {}) },
        thinking: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"], description: "Thinking level; omit for model default." },
        description: { type: "string", description: "Worker's role description." },
        safe: { type: "boolean", description: "Restrict worker to read-only tools." },
      } } },
    } },
  } };
}
