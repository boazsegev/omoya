/**
 * lib/cli/stdin.js — stdin-to-EOF reading for the CLI bindings
 * (private to CLI). Execution never begins early: the read resolves
 * only at EOF; parsing is Context's pure grammar.
 */

import Context from "../context.js";
const { messagesParse } = Context;

/**
 * Read and buffer all bytes from standard input until the stream reaches EOF,
 * then decode the concatenated bytes as UTF-8.
 * @returns {Promise<string>} The complete stdin contents as a UTF-8 string.
 * @throws {Error} Rejects if reading the stdin stream fails.
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read standard input through EOF and parse its UTF-8 contents as messages.
 * @returns {Promise<Array<object>>} The parsed context/message array.
 * @throws {Error} Rejects if reading stdin fails or message parsing throws.
 */
export async function readContextFromStdin() {
  return messagesParse(await readStdin());
}
