import Context from "../lib/context.js";
import Agent from "../lib/agent.js";
import { isAbsolute, posix, win32 } from "node:path";
import { requireControl, NOTICE, send } from "./worker/common.js";

function workerSubfolder(worker) {
  const folder = worker.subfolder;
  if (folder === undefined || folder === null || folder === false || folder === "/" ||
    (typeof folder === "string" && !folder.trim())) return undefined;
  if (typeof folder !== "string" || isAbsolute(folder) || win32.isAbsolute(folder) ||
    folder.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error(`Choose a subfolder relative to env.cwd for ${worker.name} (no absolute paths or parent traversal).`);
  }
  const normalized = posix.normalize(folder.replaceAll("\\", "/"));
  return normalized === "." || normalized === "./" ? undefined : folder;
}

export async function worker_create(args = {}, context = {}) {
  const agent = context.agent;
  if (!agent) throw new Error("Run worker-create from an agent that can create workers.");
  if (!Array.isArray(args.workers) || !args.workers.length) throw new Error("Provide at least one worker.");
  const prompt = args.prompt;
  if (prompt !== undefined && typeof prompt !== "string") throw new Error("Provide a text prompt or omit it.");
  const starts = Boolean(prompt?.trim());
  const names = new Set();
  const workers = args.workers.map((worker) => {
    if (!worker || typeof worker.name !== "string" || !worker.name.trim() || worker.name === "*") throw new Error("Give each worker a non-empty name other than *.");
    if (names.has(worker.name)) throw new Error(`Choose another worker name; ${JSON.stringify(worker.name)} occurs twice.`);
    names.add(worker.name);
    if (worker.thinking !== undefined && !["none", "low", "medium", "high", "xhigh", "max"].includes(worker.thinking)) throw new Error(`Choose a valid thinking level for ${worker.name}.`);
    return { ...worker, subfolder: workerSubfolder(worker) };
  });
  const chosen = workers.map((worker) => worker.model ?? agent.model);
  const details = workers.map((worker, i) => `${worker.name}: ${chosen[i] ?? "no model selected"}`).join("\n");
  await requireControl(agent, context, details, prompt);
  for (const model of chosen) {
    const pair = agent.env.models().get(model);
    if (agent.spawnPermission !== true || !(pair?.available > 0)) {
      throw new Error(`Cannot create workers using ${model ?? "an unspecified model"}${model && !pair ? ": unknown model" : ""}; use worker-status to check available models and permission.`);
    }
  }
  // Preflight the whole batch before any Agent registration. Construction
  // validates again in case a directory changes between these two steps.
  for (const worker of workers) {
    if (worker.subfolder !== undefined) Agent.folderResolve(agent.env, worker.subfolder);
  }
  const created = [];
  try {
    for (const worker of workers) {
      const child = agent.childCreate({ name: worker.name, model: worker.model, description: worker.description ?? "", safe: worker.safe === true, folder: worker.subfolder });
      created.push(child);
      if (worker.thinking !== undefined) (child.thinking = worker.thinking);
      child.context.append(Context.messageSystem(NOTICE));
      if (worker.subfolder !== undefined) child.context.append(Context.messageSystem(`Your assigned working folder is ${JSON.stringify(child.folder)}. Focus your work in this folder.\n`));
    }
  } catch (error) {
    for (const worker of created) worker.close();
    throw new Error(`No workers created; fix the request and retry: ${error.message}`);
  }
  if (starts) for (const worker of created) send(worker, prompt);
  return created.map((worker) => `${worker.name} (${worker.model}): ${starts ? "started" : "idle; send a task with worker-message"}`).join("\n");
}

export function toolDescription(env) {
  const candidates = [...(env?.models?.().keys() ?? [])];
  return { "worker-create": {
    fn: worker_create, trusted: true,
    description: "Create named workers and send the same self-contained first prompt to each. State role, task, context, constraints, deliverable, and acceptance checks. Replies arrive automatically as attributed messages; finish your turn rather than waiting.",
    inputSchema: { type: "object", additionalProperties: false, required: ["prompt", "workers"], properties: {
      prompt: { type: "string", minLength: 1, description: "Self-contained first prompt sent unchanged to each worker." },
      workers: { type: "array", minItems: 1, description: "Workers to create. Give each a unique name and any model, role, or scope options it needs.", items: { type: "object", additionalProperties: false, required: ["name"], properties: {
        name: { type: "string", minLength: 1, description: "Unique worker name." },
        model: { type: "string", description: "Endpoint/model; omit to use your model.", ...(candidates.length ? { enum: candidates } : {}) },
        thinking: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"], description: "Thinking level; omit for model default." },
        description: { type: "string", description: "Worker's role description." },
        safe: { type: "boolean", description: "Restrict worker to read-only tools." },
        subfolder: { description: 'Existing subfolder path relative to the project root; restrict the worker\'s working folder and sandbox to it. Omit or use "", ".", "/", "./", false, or null for the project root ("/" never means the filesystem root). Other absolute paths, parent traversal, and symlinks outside the project are forbidden.' },
      } } },
    } },
  } };
}
