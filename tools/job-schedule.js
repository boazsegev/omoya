import { toolRevision } from "../lib/tool-runtime.js";
const { scheduleJobs, validateJobsOperational } = await import(`../lib/jobs/operations.js?now=${toolRevision()}`);

function scalar(value) { return JSON.stringify(value); }
function validateSchedule(value) {
  if (typeof value === "string") {
    if (!/^(?:once|every [1-9][0-9]*[mhdw])$/.test(value)) throw Object.assign(new Error("invalid task schedule"), { code: "JOBS_TASK_SCHEDULE" });
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("invalid task schedule"), { code: "JOBS_TASK_SCHEDULE" });
  const hasAt = Object.hasOwn(value, "at"), hasEvery = Object.hasOwn(value, "every");
  if (hasAt === hasEvery) throw Object.assign(new Error("structured schedule requires exactly one of at or every"), { code: "JOBS_TASK_SCHEDULE" });
}
function scheduleYaml(value) {
  validateSchedule(value);
  if (typeof value === "string") return `schedule: ${scalar(value)}`;
  const fields = [];
  if (value?.at !== undefined) fields.push(`at: [${value.at.map(scalar).join(", ")}]`);
  if (value?.every !== undefined) fields.push(`every: ${scalar(value.every)}`);
  if (value?.days !== undefined) fields.push(`days: ${Array.isArray(value.days) ? `[${value.days.map(scalar).join(", ")}]` : scalar(value.days)}`);
  return `schedule: { ${fields.join(", ")} }`;
}
function metadataYaml(metadata) {
  const lines = [];
  if (metadata.id !== undefined) lines.push(`id: ${scalar(metadata.id)}`);
  if (metadata.tools !== undefined) lines.push(`tools: [${metadata.tools.map(scalar).join(", ")}]`);
  if (metadata.timeout !== undefined) lines.push(`timeout: ${scalar(metadata.timeout)}`);
  if (metadata.model !== undefined) lines.push(`model: ${scalar(metadata.model)}`);
  if (metadata.enabled !== undefined) lines.push(`enabled: ${metadata.enabled}`);
  if (metadata.schedule !== undefined) lines.push(scheduleYaml(metadata.schedule));
  return lines;
}
function taskSource(metadata, prompt) {
  const lines = metadataYaml(metadata);
  return lines.length ? `---\n${lines.join("\n")}\n---\n${prompt.trim()}\n` : `${prompt.trim()}\n`;
}
async function authoredCommand(env, args, context) {
  const allowed = ["action", "filename", "prompt", "enabled", "schedule"];
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw Object.assign(new Error("unsupported command field"), { code: "JOBS_COMMAND" });
  if (!["create", "update"].includes(args.action)) return args;
  let metadata = {}, prompt;
  if (args.action === "update") {
    const current = await scheduleJobs(env.cwd, { action: "read", filename: args.filename }, context);
    metadata = { ...current.task.metadata }; prompt = current.task.prompt;
  }
  if (args.prompt !== undefined) prompt = args.prompt;
  if (args.enabled !== undefined) metadata.enabled = args.enabled;
  if (args.schedule !== undefined) metadata.schedule = args.schedule;
  // Jobs are fresh Agents; pin the caller's complete combo rather than letting
  // a later last-model selection silently change their endpoint or quota.
  if (metadata.model === undefined && context.agent?.endpoint && context.agent?.model) {
    metadata.model = `${context.agent.endpoint}/${context.agent.model}`;
  }
  if (typeof prompt !== "string" || !prompt.trim()) throw Object.assign(new Error("create requires a non-empty prompt"), { code: "JOBS_TASK_PROMPT" });
  return { action: args.action, filename: args.filename, source: taskSource(metadata, prompt) };
}

async function available(env, context) {
  if (!env?.cwd || context?.agent?.safe === true) return false;
  try {
    await validateJobsOperational(env.cwd, { settings: env.settings?.jobs ?? {}, cwd: env.cwd, ...(context?.agent ? { folder: context.agent.folder } : {}) });
    return true;
  } catch { return false; }
}

/** Schedule task files only. Lifecycle/cron mutation and secret settings are never model arguments. */
export async function jobSchedule(args, context = {}) {
  const { env, agent } = context;
  if (!env?.cwd) throw new Error("job-schedule requires a project environment");
  if (agent?.safe === true) throw new Error("job-schedule is unavailable to read-only Agents");
  const options = { settings: env.settings?.jobs ?? {}, cwd: env.cwd, ...(agent ? { folder: agent.folder } : {}) };
  const result = await scheduleJobs(env.cwd, await authoredCommand(env, args, { ...options, agent }), options);
  return result;
}
export { jobSchedule as "job-schedule" };

export function toolDescription() {
  return {
    "job-schedule": {
      trusted: true,
      available,
      description: "List, read, create, replace, or remove scheduled Markdown tasks in an operational project. Pause with enabled: false. New/changed tasks wait for a later scan; removal never cancels running work. Task-local schedules determine admission; the optional daemon is not required. Cannot initialize, enable, disable, repair, run, control a daemon, or access secrets. Unavailable to read-only Agents.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["action"],
        properties: {
          action: { type: "string", enum: ["list", "read", "create", "update", "remove"], description: "Task operation. update replaces complete Markdown; remove leaves history and running work intact." },
          filename: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9 ._-]*\\.md$", maxLength: 120, description: "Leaf .md filename for read/create/update/remove; never a path or opaque task ID." },
          prompt: { type: "string", minLength: 1, description: "Task instructions. Required for create; omitted on update to preserve the current prompt." },
          enabled: { type: "boolean", description: "Whether the task may run. Omitted on update to preserve the current value." },
          schedule: { description: "Task schedule. Omitted on update to preserve it. Use once, every <duration>, or one structured at/every schedule with optional days.", oneOf: [
            { type: "string", pattern: "^(once|every [1-9][0-9]*[mhdw])$" },
            { type: "object", additionalProperties: false, properties: { at: { type: "array", minItems: 1, items: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9](?: GMT)?$" } }, every: { type: "string", pattern: "^[1-9][0-9]*[mhdw]$" }, days: { oneOf: [{ type: "string", enum: ["weekdays", "weekends"] }, { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] } }] } }, oneOf: [{ required: ["at"] }, { required: ["every"] }] },
          ] },
        },
      },
    },
  };
}
