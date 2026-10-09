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

/** Join a retained Bash command; the timeout begins at this call, not at process start. */
export async function processJoin({ id, timeout = 120000 } = {}, context) {
  if (!context?.background?.join) throw new Error("process-join requires background capabilities");
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw new TypeError("timeout must be a nonnegative integer in milliseconds");
  return context.background.join(id, context.deadline === undefined ? timeout : Math.max(0, context.deadline - Date.now()));
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
    "process-join": {
      fn: processJoin, trusted: true,
      description: "Wait for this Agent's background Bash process; return its output and exit code like bash. Timeout starts on join and stops the process group.",
      onTimeout: async ({ id }, context) => {
        await context.background.stop(id);
        return context.background.join(id, 0);
      },
      inputSchema: { type: "object", properties: {
        id: { type: "string", description: "Process id returned by background Bash." },
        timeout: { type: "integer", minimum: 0, description: "Milliseconds to wait from this call (default: 120000; capped at 1200000). Stops the process on timeout." },
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
