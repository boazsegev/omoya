import Context from "../lib/context.js";
import { randomUUID } from "node:crypto";
import { isAbsolute, posix, win32, relative, sep, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { requireControl, NOTICE, send } from "./worker/common.js";

function workerSubfolder(worker) {
  const folder = worker.subfolder;
  if (folder === undefined || folder === null || folder === false || folder === "/" ||
    (typeof folder === "string" && !folder.trim())) return undefined;
  if (typeof folder !== "string" || isAbsolute(folder) || win32.isAbsolute(folder) ||
    folder.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error(`Choose a subfolder relative to env.folder for ${worker.name} (no absolute paths or parent traversal).`);
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
    if (agent.can.delegate !== true || !(pair?.available > 0)) {
      throw new Error(`Cannot create workers using ${model ?? "an unspecified model"}${model && !pair ? ": unknown model" : ""}; use worker-status to check available models and permission.`);
    }
  }
  // Omitted/root aliases inherit the leader's folder; explicit subfolders
  // must be contained in both Env.folder and the leader's write root.
  const base = realpathSync(agent.folder);
  const project = realpathSync(agent.env.folder);
  const inside = (root, candidate) => {
    const rel = relative(root, candidate);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const folders = workers.map((worker) => {
    if (worker.subfolder === undefined) return base;
    let folder;
    try {
      folder = realpathSync(resolve(agent.env.folder, worker.subfolder));
      if (!statSync(folder).isDirectory()) throw new Error("path is not a folder");
    } catch (error) {
      throw new Error(`Agent.folder: ${error.message}`, { cause: error });
    }
    if (!inside(project, folder) || !inside(base, folder)) throw new Error("Agent.folder: worker subfolder must stay inside the leader folder and env.folder");
    return folder;
  });
  const created = [];
  try {
    for (const [index, worker] of workers.entries()) {
      const child = await agent.childCreate({ name: worker.name, model: worker.model, description: worker.description ?? "", can: { write: worker.safe !== true }, folder: folders[index], contextId: agent.context.save ? randomUUID() : false });
      created.push(child);
      if (worker.thinking !== undefined) (child.thinking = worker.thinking);
      child.context.append(Context.messageSystem(NOTICE));
      if (worker.subfolder !== undefined) child.context.append(Context.messageSystem(`Your assigned working folder is ${JSON.stringify(child.folder)}. Focus your work in this folder.\n`));
    }
  } catch (error) {
    const releases = await Promise.allSettled(created.map((worker) => worker.close()));
    const failures = releases.filter((result) => result.status === "rejected").map((result) => result.reason);
    const creationError = new Error(`No workers created; fix the request and retry: ${error.message}`, { cause: error });
    if (failures.length) throw new AggregateError([creationError, ...failures], "Worker creation and rollback failed");
    throw creationError;
  }
  if (starts) for (const worker of created) send(worker, prompt);
  return created.map((worker) => `${worker.name} (${worker.model}): ${starts ? "started" : "idle; send a task with worker-message"}`).join("\n");
}

export function toolDescription(env) {
  const candidates = [...(env?.models?.().keys() ?? [])];
  return { "worker-create": {
    fn: worker_create, trusted: true,
    description: "Create named workers and optionally send the same self-contained first prompt to each. Omit or empty prompt creates idle workers. State role, task, context, constraints, deliverable, and acceptance checks. Replies arrive as messages; finish your turn rather than waiting.",
    inputSchema: { type: "object", additionalProperties: false, required: ["workers"], properties: {
      prompt: { type: "string", description: "Self-contained first prompt sent unchanged to each worker; omit or use an empty string to create idle workers." },
      workers: { type: "array", minItems: 1, description: "Workers to create. Give each a unique name and any model, role, or scope options it needs.", items: { type: "object", additionalProperties: false, required: ["name"], properties: {
        name: { type: "string", minLength: 1, description: "Short unique role name, e.g. reviewer." },
        model: { type: "string", description: "Model for the worker; omit to use yours.", ...(candidates.length ? { enum: candidates } : {}) },
        thinking: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"], description: "Thinking level; omit unless critical. Default to empty or medium." },
        description: { type: "string", description: "Worker's role description." },
        safe: { type: "boolean", description: "Start the worker read-only." },
        subfolder: { type: "string", description: "Existing subfolder of your folder that limits the worker's writes; omit for your folder." },
      } } },
    } },
  } };
}
