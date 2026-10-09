/** List processes started by this Agent's background bash. Read-only. */
export async function processList(_args = {}, context) {
  if (!context?.background) throw new Error("process-list requires background capabilities");
  return context.background.list();
}

/** Read buffered output from one of this Agent's background processes. Read-only. */
export async function processOutput({ id, from } = {}, context) {
  if (!context?.background) throw new Error("process-output requires background capabilities");
  return context.background.output(id, from);
}

/** Stop one of this Agent's background process groups. Unavailable in safe mode. */
export async function processStop({ id } = {}, context) {
  if (!context?.background) throw new Error("process-stop requires background capabilities");
  if (context.safe) throw new Error("Cannot stop a process in safe mode");
  return context.background.stop(id);
}

export function toolDescription() {
  return {
    "process-list": {
      fn: processList, safe: true,
      description: "List this Agent's background Bash processes.",
      inputSchema: { type: "object", properties: {} },
    },
    "process-output": {
      fn: processOutput, safe: true,
      description: "Read buffered output from this Agent's background Bash process.",
      inputSchema: { type: "object", properties: {
        id: { type: "string", description: "Process id returned by background Bash." },
        from: { type: "integer", minimum: 0, description: "Byte offset (default 0); pass the returned next offset on subsequent calls." },
      }, required: ["id"] },
    },
    "process-stop": {
      fn: processStop, trusted: true,
      description: "Stop this Agent's background Bash process group. Unavailable in safe mode.",
      inputSchema: { type: "object", properties: {
        id: { type: "string", description: "Process id returned by background Bash." },
      }, required: ["id"] },
    },
  };
}
