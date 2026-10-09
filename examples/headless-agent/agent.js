/**
 * examples/headless-agent/agent.js — a minimal headless Omoya Agent.
 *
 * This script uses ONLY the public library API documented in the repository
 * README ("Build on the library"):
 *
 *   import Agent from "omoya/agent";
 *   const env = await Agent.Env.open(process.cwd());   // providers, endpoint detection, tools
 *   const agent = await Agent.create({ env, model: "<endpoint>/<model>", can: { write: false } });
 *
 * IMPORTANT — endpoint and model setup:
 *   The `model` option is an `<endpoint>/<model>` selector. An endpoint is a
 *   named provider entry from your Omoya settings (the `providers` table),
 *   configured once with `omoya --login` (or by editing your user settings
 *   folder). This example ships with the illustrative local-Ollama selector
 *   `ollama/gpt-oss:20b` taken from the README; replace it with any
 *   endpoint/model pair YOUR installation has. Without a reachable,
 *   configured endpoint the script fails fast at construction with a clear
 *   error — it never invents endpoints, credentials, or fallbacks.
 *
 * Reading this file is completely safe. Running it performs a real provider
 * request (a live network call to your configured endpoint) and may execute
 * read-only agent tools inside the current working folder.
 */

import Agent from "omoya/agent";

// --- Configuration boundary -------------------------------------------------

// Illustrative selector from the README. Point this at your own configured
// endpoint, e.g. "openai/gpt-5" or "ollama/gpt-oss:20b".
const MODEL_SELECTOR = "ollama/gpt-oss:20b";

// The single user message sent to the agent. Deliberate example output only.
const PROMPT = "Reply with exactly one short sentence naming the current folder.";

function fail(message) {
  throw new Error(`headless-agent: ${message}`);
}

// --- Environment ------------------------------------------------------------

// Agent.Env.open(process.cwd()) loads settings layers, providers, endpoint detection,
// and the tool registry — the returned environment is ready for an Agent.
const env = await Agent.Env.open(process.cwd());
let agent;
try {
  env.connection(MODEL_SELECTOR, { remember: false });
} catch (error) {
  console.error(`headless-agent: ${error.message}. Run "omoya --login" or choose a model from: ${[...env.models().keys()].join(", ") || "(none configured)"}.`);
  await env.close();
  process.exit(1);
}

// --- Agent ------------------------------------------------------------------

try {
agent = await Agent.create({
  env,
  model: MODEL_SELECTOR,
  // Deny writes: this example needs no filesystem mutations.
  can: { write: false },
  // No `session` option: an anonymous, in-memory session that writes nothing.
  name: "example-headless",
});

// --- Event handling ---------------------------------------------------------

// Agent.EVENT is the canonical Symbol event vocabulary; onEvent registers a
// synchronous listener for one event constant and returns an opaque handle.
const E = Agent.EVENT;

let streamingText = false;

agent.onEvent(E.TEXT_START, () => {
  streamingText = true;
  process.stdout.write("assistant: ");
});

agent.onEvent(E.TEXT_DELTA, ({ text }) => {
  if (typeof text === "string") process.stdout.write(text);
});

agent.onEvent(E.TEXT_END, () => {
  if (streamingText) process.stdout.write("\n");
  streamingText = false;
});

agent.onEvent(E.TOOL_EXECUTE, ({ name }) => {
  console.error(`[tool] ${name}`);
});

agent.onEvent(E.REQUEST_ERROR, ({ error, kind }) => {
  fail(`provider error${kind ? ` (${kind})` : ""}: ${error ?? "unknown"}`);
});

// --- Run --------------------------------------------------------------------

// send() starts the idle turn and resolves to its terminal done/error event.
const terminal = await agent.send(Agent.Context.messageUser(PROMPT));

// Deliberate example output: the provider-reported usage envelope, when any.
if (terminal?.usage) {
  const { inputTokens = 0, outputTokens = 0 } = terminal.usage;
  console.error(`[usage] input=${inputTokens} output=${outputTokens}`);
}
} finally {
  try { await agent?.close(); }
  finally { await env.close(); }
}
