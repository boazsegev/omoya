/** Context-derived skill activation: survives compaction/resume, resets with context. */
import Context from "../context.js";
const { MessageType } = Context;

function unescapeName(name) {
  return name.replace(/&(quot|lt|gt|amp);/g, (_, entity) => ({ quot: '"', lt: "<", gt: ">", amp: "&" })[entity]);
}

/** Inspect only durable system guidance, including prefilled skill wrappers. */
export function loadedSkills(context) {
  const names = new Set();
  for (const message of context.messages()) {
    if (message.type !== MessageType.System) continue;
    for (const block of message.content ?? []) {
      for (const match of (block.text ?? "").matchAll(/<skill name="([^"\r\n]*)">/g)) names.add(unescapeName(match[1]));
    }
  }
  return names;
}

/** Commit once, including duplicate activations in the same concurrent tool batch. */
export function appendSkillSystem(agent, text, append) {
  const match = text.match(/^<skill name="([^"\r\n]*)">\n/);
  if (match && loadedSkills(agent.context).has(unescapeName(match[1]))) return;
  append(text);
}
