import { createInterface } from "node:readline/promises";

/**
 * Start explicit MCP browser sign-in. Loopback callback wins without waiting
 * for Enter; in a terminal, a full pasted redirect URL is a fallback.
 * @param {object} env Environment with mcpLogin/mcpPaste methods.
 * @param {string} name Configured MCP server name.
 * @param {{input?: import('node:stream').Readable, output?: import('node:stream').Writable}} [options] Terminal streams.
 * @returns {Promise<{name: string}>} Signed-in server identity.
 */
export async function runMcpLogin(env, name, { input = process.stdin, output = process.stderr } = {}) {
  const rl = input.isTTY === true ? createInterface({ input, output, terminal: true }) : null;
  try {
    const flow = env.mcpLogin(name, {
      onAuthUrl: (url) => {
        output.write(`authorize: ${url}\n`);
        if (rl) void rl.question("Paste the full redirect URL (or finish in the browser): ")
          .then((answer) => { if (answer.trim()) env.mcpPaste(answer.trim()); }).catch(() => {});
      },
      onLog: (line) => output.write(`${line}\n`),
    });
    if (!rl) output.write("Complete the loopback browser sign-in on this machine; paste fallback requires a terminal.\n");
    return await flow;
  } finally { rl?.close(); }
}
