/**
 * lib/cli/stdin.js — stdin-to-EOF reading for the CLI bindings
 * (private to CLI). Execution never begins early: the read resolves
 * only at EOF; parsing is Context's pure grammar.
 */

import Context from "../context.js";
const { parseContext } = Context;

/**
 * Read all of stdin, resolving only at EOF.
 * @returns {Promise<string>} the complete buffered input
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read stdin to EOF and parse it into a context array.
 * @returns {Promise<Array<object>>}
 */
export async function readContextFromStdin() {
  return parseContext(await readStdin());
}
