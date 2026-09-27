import Context from "../../lib/context.js";

export const NOTICE = "<notice>You are a worker recruited by another agent. Perform your assigned task yourself.</notice>\n";

export async function requireControl(agent, context, details, prompt) {
  if (agent.spawnPermission === true) return;
  if (agent.spawnPermission === false || typeof context?.question?.ask !== "function") throw new Error("Ask the user to permit worker creation, or continue without workers.");
  const answers = await context.question.ask([{
    question: "Allow this Agent to create and control workers?",
    header: "Allow Agent to spawn / delegate?",
    details,
    options: [
      { label: "Allow", description: "Allow this and future worker calls from this Agent.", ...(prompt ? { preview: { type: "text", title: "Worker prompt", content: prompt } } : {}) },
      { label: "Deny", description: "Deny this and future worker calls from this Agent." },
    ],
  }]);
  const answer = answers?.[0];
  if (answer?.labels?.length === 1 && answer.labels[0] === "Allow") { agent.spawnPermissionSet(true); return; }
  if (answer?.labels?.length === 1 && answer.labels[0] === "Deny") agent.spawnPermissionSet(false);
  throw new Error(typeof answer?.text === "string" && answer.text.trim() ? answer.text.trim() : "Ask the user to permit worker creation, or continue without workers.");
}

export function requirePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Provide a non-empty prompt.");
}

export function workersMatching(agent, names) {
  if (!Array.isArray(names) || !names.length || names.some((name) => typeof name !== "string" || !name.trim())) throw new Error('Provide worker names or ["*"].');
  if (names.includes("*") && names.length !== 1) throw new Error('Use ["*"] alone.');
  const workers = agent.children;
  const selected = new Set();
  for (const name of names) {
    let matches;
    if (name === "*") matches = workers;
    else if (name.startsWith("/") && name.endsWith("/") && name.length > 2) {
      let regex;
      try { regex = new RegExp(name.slice(1, -1)); } catch { throw new Error(`Fix invalid worker pattern: ${name}.`); }
      matches = workers.filter((worker) => regex.test(worker.name));
    } else matches = workers.filter((worker) => worker.name === name);
    if (!matches.length && name !== "*") throw new Error(`No workers match ${JSON.stringify(name)}; use worker-status to see worker names.`);
    for (const worker of matches) selected.add(worker);
  }
  return [...selected];
}

export const targetsSchema = {
  type: "array", minItems: 1,
  items: { type: "string", minLength: 1 },
  description: 'Worker names, /regex/ patterns, or ["*"] for all workers. Use * alone.',
};

export function send(worker, prompt) {
  worker.send(Context.messageUser(prompt));
}
