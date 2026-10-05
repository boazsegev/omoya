/** Inspect or stop a process started by this Agent's background bash. */
export async function process({ action, id, from } = {}, context) {
  if (!context?.agent) throw new Error("process requires an Agent");
  if (action === "list") return context.agent.backgroundList();
  if (action === "output") return context.agent.backgroundOutput(id, from);
  if (action === "stop") {
    if (context.safe) throw new Error("Cannot stop a process in safe mode");
    return context.agent.backgroundStop(id);
  }
  throw new TypeError("action must be list, output, or stop");
}

export function toolDescription() {
  return { process: {
    safe: true,
    readOnly: ({ action }) => action === "list" || action === "output",
    description: "List, read buffered output from, or stop this Agent's background Bash processes. Stop is unavailable in safe mode.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "output", "stop"], description: "List processes, read output, or stop a process group." },
      id: { type: "string", description: "Process id returned by background Bash; required for output and stop." },
      from: { type: "integer", minimum: 0, description: "Byte offset for output (default 0); pass the returned next offset on subsequent calls." },
    }, required: ["action"] },
  } };
}
