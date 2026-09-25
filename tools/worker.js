import Env from "../lib/env.js";

const FIRST_PROMPT_ERROR = "Fix the request: provide a first prompt that states the worker's role, task, necessary context, constraints, deliverable, and acceptance checks.";
const NOTICE = "<notice>You were recruited to the team by another agent and should perform all tasks yourself.</notice>\n";

function permissionQuestion(args) {
  return {
    question: "Allow this Agent to create and control child workers?",
    header: "Allow Agent to spawn / delegate?",
    ...(args.description ? { details: args.description } : {}),
    options: [
      {
        label: "Allow",
        description: "Allow this and future worker calls from this Agent.",
        ...(typeof args.prompt === "string" ? { preview: { type: "text", title: "Worker prompt", content: args.prompt } } : {}),
      },
      { label: "Deny", description: "Deny this and future worker calls from this Agent." },
    ],
  };
}

function permissionRefusal(answer) {
  const text = typeof answer?.text === "string" ? answer.text.trim() : "";
  return new Error(text || "Proceed without a worker.");
}

async function requireManager(args, context) {
  const manager = context?.agent;
  if (!manager) throw new Error("Ask the user to start this request from an agent that can manage workers.");
  if (manager.spawnPermission === true) return manager;
  if (manager.spawnPermission === false) throw new Error("Proceed without a worker.");
  if (typeof context?.question?.ask !== "function") throw new Error("Proceed without a worker.");
  const answers = await context.question.ask([permissionQuestion(args)]);
  const labels = answers?.[0]?.labels;
  if (Array.isArray(labels) && labels.length === 1 && labels[0] === "Allow") {
    manager.setSpawnPermission(true);
    return manager;
  }
  if (Array.isArray(labels) && labels.length === 1 && labels[0] === "Deny") manager.setSpawnPermission(false);
  throw permissionRefusal(answers?.[0]);
}

function matches(manager, name) {
  return manager.children.filter((child) => child.name === name);
}

function requirePrompt(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error(FIRST_PROMPT_ERROR);
}

function modelCandidates(env, manager) {
  const candidates = new Set();
  for (const endpoint of env.endpointNames()) {
    const models = env.endpointSettings(endpoint).models;
    if (models === null || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [model, metadata] of Object.entries(models)) {
      if (model !== "" && metadata?.secret !== true) candidates.add(`${endpoint}/${model}`);
    }
  }
  if (typeof manager.endpoint === "string" && typeof manager.model === "string" && manager.endpoint !== "" && manager.model !== "") {
    candidates.add(`${manager.endpoint}/${manager.model}`);
  }
  return [...candidates].sort();
}

function modelChoiceError(env, manager) {
  const candidates = modelCandidates(env, manager);
  return candidates.length > 0
    ? `Omit model to use your own model or choose one of: ${candidates.join(", ")}.`
    : "Omit model to use your own model. Ask the user to configure another model before choosing one.";
}

function selectModel(manager, model) {
  const selector = model ?? (manager.endpoint && manager.model ? `${manager.endpoint}/${manager.model}` : undefined);
  try {
    const selected = Env.parseModelSelector(manager.env, selector, "worker");
    return { ...selected, selector };
  } catch (error) {
    throw new Error(`${error.message} ${modelChoiceError(manager.env, manager)}`);
  }
}

function routeResponses(worker, manager) {
  const routes = manager.toolStorage("worker").routes ??= new WeakMap();
  if (routes.has(worker)) return;
  const committed = worker.onEvent(worker.constructor.EVENT.MESSAGE_COMMITTED, (message) => {
    if (worker.parent !== manager || message?.type !== 3 || message.incomplete === true) return;
    const content = message.content ?? [];
    if (!content.some((part) => part?.type !== "thinking") || content.some((part) => part?.type === "toolCall")) return;
    manager.enqueue({
      type: 2,
      content: [{ type: "text", text: `[Message from worker: ${JSON.stringify(worker.name)}]` }, ...content],
      worker: worker.name,
    });
  });
  const closed = worker.onEvent(worker.constructor.EVENT.CLOSED, () => {
    worker.offEvent(committed);
    worker.offEvent(closed);
    routes.delete(worker);
  });
  routes.set(worker, { committed, closed });
}

function createWorker(manager, args, preserved) {
  const selected = preserved ?? selectModel(manager, args.model);
  if (manager.env.agentEndpointAvailable(selected.endpoint, selected.model) === 0) throw new Error("Wait for an existing worker to finish, close an idle worker, or choose another model.");
  const worker = manager.createChild({
    ...(typeof args.name === "string" && args.name.length > 0 ? { name: args.name } : {}),
    description: preserved?.description ?? args.description ?? "",
    model: selected.selector,
    safe: preserved?.safe ?? args.safe === true,
  });
  routeResponses(worker, manager);
  worker._append({ type: 1, content: [{ type: "text", text: NOTICE }] }, { merge: false });
  return worker;
}

function info(worker) {
  return {
    name: worker.name,
    model: `${worker.endpoint}/${worker.model}`,
    contextUsage: worker.contextUsage,
    state: worker.ioState,
    ...(worker.description ? { description: worker.description } : {}),
  };
}

export async function worker(args = {}, context = {}) {
  const manager = await requireManager(args, context);
  const hasName = typeof args.name === "string" && args.name.length > 0;
  let workers = hasName ? matches(manager, args.name) : [];
  if (workers.length === 0) {
    if (args.reset === true || args.close === true) throw new Error("Choose the name of an existing worker, or omit reset/close to create a new worker.");
    requirePrompt(args.prompt);
    workers = [createWorker(manager, args)];
  } else {
    for (const child of workers) routeResponses(child, manager);
  }
  if (args.reset === true) {
    if (workers.some((child) => child.busy)) throw new Error("Wait for every matched worker to become idle, or close it instead of resetting it.");
    const records = workers.map((child) => ({ name: child.name, description: child.description, selector: `${child.endpoint}/${child.model}`, safe: child.safe }));
    for (const child of workers) child.close();
    workers = records.map((record) => createWorker(manager, { ...args, name: record.name }, record));
  }
  if (args.prompt !== undefined) {
    if (typeof args.prompt !== "string") requirePrompt(args.prompt);
    for (const child of workers) child.enqueue({ type: 2, content: [{ type: "text", text: args.prompt }] });
  }
  const listed = args.list === true || !hasName ? manager.children : workers;
  const result = {};
  if (args.list === true) result.workers = listed;
  if (args.info === true || args.list === true || !hasName) result.info = listed.map(info);
  if (args.close === true) {
    for (const child of workers) if (child.busy) child.enqueue({ type: 2, content: [{ type: "text", text: "/handoff" }] });
    for (const child of workers) child.close();
  }
  return result;
}

export function toolDescription(env) {
  const candidates = modelCandidates(env ?? { endpointNames: () => [], endpointSettings: () => ({}) }, { endpoint: undefined, model: undefined });
  const modelDescription = candidates.length > 0
    ? `Endpoint/model used only when creating a worker. Omit to use your own model, or choose one of: ${candidates.join(", ")}.`
    : "Endpoint/model used only when creating a worker. Omit to use your own model.";
  return {
    worker: {
      trusted: true,
      description: "Create or control worker agents. Use workers to divide substantial work, not to outsource your judgment or reasoning. For a new worker, make the first prompt self-contained: state its role, concrete task, relevant context, constraints, deliverable, and acceptance checks. Omit model by default, or choose a provider/model value from the model field. Responses are pushed as attributed user messages (never call `sleep` or they will be blocked).",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          name: { type: "string", description: "Target worker name. Omit to create an automatically named worker." },
          prompt: { type: "string", description: "Message queued to worker(s); required for new workers. First prompt: role, task, context, constraints, deliverable, and acceptance checks. Delegate tasks, not reasoning." },
          description: { type: "string", description: "Description used only when creating a worker." },
          model: { type: "string", description: modelDescription, ...(candidates.length > 0 ? { enum: candidates } : {}) },
          safe: { type: "boolean", description: "Create the worker in safe mode: it can publish and execute only read-only tools. Existing workers keep their current mode." },
          reset: { type: "boolean", description: "Replace every idle match while preserving identity and endpoint settings." },
          close: { type: "boolean", description: "Request handoff from busy matches, then close every match." },
          info: { type: "boolean", description: "Include name, model, context usage, state, and description." },
          list: { type: "boolean", description: "Include every child worker individually, including duplicate names." },
        },
      },
    },
  };
}
