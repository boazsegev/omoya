/** Shared cross-project helpers for the request and resource tools. */

const DENIED = "Ask the user to permit requests to other agents, or continue without them.";

/**
 * Settle `agent.can.request` before sending a request to another agent:
 * true allows, false refuses, any other value asks the user once through the
 * question bridge (Allow/Deny persist on the Agent); no bridge refuses.
 * Workers always read false.
 * @param {object} agent Calling Agent.
 * @param {object} context Tool context (question bridge).
 * @param {string} details What the user is asked to permit.
 * @returns {Promise<void>} Resolves when permitted.
 * @throws {Error} When refused or unavailable.
 */
export async function requireRequest(agent, context, details) {
  if (agent?.can.request === true) return;
  if (!agent || agent.can.request === false || agent.can.interact !== true || typeof context?.question?.ask !== "function") throw new Error(DENIED);
  const answers = await context.question.ask([{
    question: "Allow this Agent to send requests to other agents?",
    header: "Allow requests?",
    details,
    options: [
      { label: "Allow", description: "Allow this and future requests to other agents from this Agent." },
      { label: "Deny", description: "Deny this and future requests to other agents from this Agent." },
    ],
  }]);
  const answer = answers?.[0];
  if (answer?.labels?.length === 1 && answer.labels[0] === "Allow") { agent.can.request = true; return; }
  if (answer?.labels?.length === 1 && answer.labels[0] === "Deny") agent.can.request = false;
  throw new Error(typeof answer?.text === "string" && answer.text.trim() ? answer.text.trim() : DENIED);
}

/**
 * Resolve a project name an agent may reach (env.settings.projects). Folders are never shown.
 * @param {object} env Caller's Env.
 * @param {string} name Project name.
 * @returns {string} Absolute project folder.
 * @throws {Error} Unknown or unreachable project (message lists reachable names).
 */
export function projectFolder(env, name) {
  const projects = env.settings.projects;
  if (Object.hasOwn(projects, name)) return projects[name].folder;
  const names = Object.keys(projects).filter((key) => key === "this" || key === projects[key].name);
  throw new Error(`Unknown project ${JSON.stringify(name)}; reachable projects: ${names.join(", ")}.`);
}

/** Reachable project names for tool descriptions (without exposing folders). */
export function projectListing(env) {
  const projects = env.settings.projects;
  return Object.keys(projects).filter((key) => key === "this" || key === projects[key].name).map((name) => {
    const description = name === "this" ? "your own project" : typeof projects[name].description === "string" ? projects[name].description.trim() : "";
    return description ? `${name} (${description})` : name;
  });
}
