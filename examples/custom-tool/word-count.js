/**
 * examples/custom-tool/word-count.js — a minimal Omoya custom tool module.
 *
 * Module contract (lib/env/tools.js — the same contract the built-in tools in
 * the package's tools/ folder follow):
 *
 *   - Export toolDescription(env) returning an object keyed by exported
 *     function name; each value is an MCP-like { description, inputSchema }
 *     plus optional harness metadata (safe: true marks a read-only tool that
 *     is also published and executed in --safe mode).
 *   - Export a callable of the same name: fn(args, context). `args` is the
 *     model-provided arguments object; `context` exposes { env, agent, ... }
 *     when the tool runs under an Agent. Validate arguments at the boundary.
 *   - Keep the module side-effect free: the tool scan imports every top-level
 *     .js file of a tool root into the host process, so never print, serve,
 *     or run work at import time.
 *
 * This tool is harmless by construction: pure string math, no filesystem,
 * network, or process access, and no global wrappers or hardcoded paths.
 * See README.md in this folder for how to place and load it.
 */

const WORD_PATTERN = /\S+/g;

/**
 * Count characters, words, and lines of a text string.
 * @param {{text: string}} args
 * @returns {{characters: number, words: number, lines: number}}
 */
export function wordCount({ text } = {}) {
  if (typeof text !== "string") {
    throw new TypeError('wordCount: "text" must be a string');
  }
  const words = text.match(WORD_PATTERN)?.length ?? 0;
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  return { characters: text.length, words, lines };
}

/**
 * Describe this module's tools to Omoya's tool scanner.
 * @param {object} [env] - the live environment (unused by this tool)
 * @returns {object} tool schemas keyed by exported function name
 */
export function toolDescription(env) {
  void env;
  return {
    wordCount: {
      // safe: true — read-only: also published and executed in --safe mode.
      safe: true,
      description: "Count characters, words, and lines in a text string.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to measure." },
        },
        required: ["text"],
      },
    },
  };
}
