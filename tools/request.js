/** Send a request (handoff, question or reply) to another root agent. */
import { requireRequest, projectListing } from "./request/common.js";

/**
 * Tolerate an unpublished `new` argument: true marks `to` as a new agent;
 * a name marks it when it matches the name in `to` (with or without @project).
 */
function newCorrected(to, flag) {
  if (typeof to !== "string" || to.trim().startsWith("new:") || !to.includes("@")) return to;
  const target = to.trim();
  if (flag === true) return `new:${target}`;
  if (typeof flag !== "string" || !flag.trim()) return to;
  const name = flag.trim();
  return name === target || name === target.slice(0, target.indexOf("@")) ? `new:${target}` : to;
}

export async function request(args = {}, context = {}) {
  const agent = context.agent;
  if (!agent) throw new Error("Run request from an agent.");
  const { prompt, safe, model } = args;
  const to = newCorrected(args.to, args.new);
  if (typeof to !== "string" || !to.includes("@")) throw new Error('Use to: "<name>@<project>", or to: "new:<role-name>@<project>" to start an agent.');
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Provide a self-contained prompt.");
  if (agent.parent) throw new Error("Don't use tools for messaging parent / supervisor – emit text output instead.");
  await requireRequest(agent, context, `Request to ${to}${model ? ` (${model})` : ""}:\n${prompt}`);
  const address = await agent.request({ to, prompt, ...(safe === undefined ? {} : { safe }), ...(model === undefined ? {} : { model }) });
  return {
    result: `Sent to ${address}. Any reply arrives as a message; finish your turn rather than waiting.`,
    display: `**Request → \`${address}\`**\n\n${prompt}`, // shown to the user, never sent to the model
  };
}

export function toolDescription(env) {
  const reachable = env?.settings?.projects ? projectListing(env).join("; ") : "this (your own project)";
  const candidates = [...(env?.models?.().keys() ?? [])];
  return { request: {
    fn: request, trusted: true,
    description: `List Projects. Exchange requests / replies with external agents (not your worker/parent). Use to collaborate on complex tasks that require a number of teams to complete, or to file bug reports or ask questions in other projects. Not for delegating tasks to workers. Not for copying resources from other projects (user \`resource\`). Start an agent with \`to: "new:<role-name>@<project>"\`; later use the <name>@<project> from the result or from a received request's label. The receiver may refuse. Replies arrive as messages; finish your turn to wait. Projects: ${reachable}.`,
    inputSchema: { type: "object", additionalProperties: false, required: ["to", "prompt"], properties: {
      to: { type: "string", minLength: 3, description: "<name>@<project>, or new:<role-name>@<project> (e.g. new:api-reviewer@this) to start an agent." },
      prompt: { type: "string", minLength: 1, description: "Self-contained: include context and expected outcome. Use skill when available." },
      model: { type: "string", description: "Model for a new agent; omit unless critical. Matching a contact's current model is ignored.", ...(candidates.length ? { enum: candidates } : {}) },
      safe: { type: "boolean", description: "Start the new agent read-only; false on an existing contact is ignored." },
    } },
  } };
}
