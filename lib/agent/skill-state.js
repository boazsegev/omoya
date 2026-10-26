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

/** Refresh complete skill sections in retained system guidance; leave unavailable skills and other text unchanged. */
export function refreshSkillSystems(messages, env) {
  const sections = /<skill name="([^"\r\n]*)">\n[\s\S]*?\n<\/skill>/g;
  if (!messages.some((message) => message.type === MessageType.System && message.content?.some((block) => (block.text ?? "").includes('<skill name="')))) return messages;
  let skills;
  try { skills = env.skills(); }
  catch { return messages; } // Skill refresh is best-effort; never block a successful summary.
  return messages.map((message) => {
    if (message.type !== MessageType.System) return message;
    return { ...message, content: message.content?.map((block) => {
      if (typeof block.text !== "string") return block;
      return { ...block, text: block.text.replace(sections, (section, escapedName) => {
        const current = skills.get(unescapeName(escapedName));
        return current ? env.skillSection(current) : section;
      }) };
    }) };
  });
}

/** Commit once, including duplicate activations in the same concurrent tool batch. */
export function appendSkillSystem(agent, text, append) {
  const match = text.match(/^<skill name="([^"\r\n]*)">\n/);
  if (match && loadedSkills(agent.context).has(unescapeName(match[1]))) return;
  append(text);
}
