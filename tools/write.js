/** Mutating text writer. Saving read results lives in read.target; both share tools/write/save.js. */
import { toolRevision } from "../lib/tool-runtime.js";
const { saveTarget, savePayload } = await import(`./write/save.js?revision=${toolRevision()}`);

/** Atomically create or overwrite a text file; the destination changes only after guarded checks pass. */
export async function write(args = {}, context) {
  if (context?.safe === true) throw new Error("write is unavailable in safe mode");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("write arguments must be an object");
  for (const key of Object.keys(args)) if (!["path", "content", "ask"].includes(key)) throw new Error(`Unknown write field: ${key}`);
  if (typeof args.content !== "string") throw new TypeError("write.content must be a string");
  if (![undefined, null, "", 0, -1].includes(args.ask) && typeof args.ask !== "boolean") throw new TypeError("write.ask must be a boolean");
  const target = await saveTarget(args.path, context);
  return savePayload(target, { payload: Buffer.from(args.content) }, context, { ask: args.ask === true });
}

export function toolDescription() {
  return { write: { trusted: true,
    description: "Create or overwrite a text file in the Agent folder. Use edit for targeted changes; use read with target to copy files or save read results.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: {
      path: { type: "string", description: "Destination path inside the Agent folder, relative to it or an absolute contained path." },
      content: { type: "string", description: "Full file text; an empty string creates or clears the file." },
      ask: { type: "boolean", description: "Ask permission if the text references an existing outside path or an existing absolute project path; without permission, the write is refused." },
    } },
  } };
}
