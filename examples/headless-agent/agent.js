/**
 * examples/headless-agent/agent.js — a minimal headless Omoya Agent.
 *
 * This script uses ONLY the public library API documented in the repository
 * README ("Build on the library"):
 *
 *   import Agent from "omoya/agent";
 *   const env = await Agent.Env.create();   // providers, endpoint detection, tools
 *   const agent = new Agent({ env, model: "<endpoint>/<model>", safe: true });
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
  console.error(`headless-agent: ${message}`);
  process.exit(1);
}

// --- Environment ------------------------------------------------------------

// Agent.Env.create() loads settings layers, providers, endpoint detection,
// and the tool registry — the returned environment is ready for an Agent.
const env = await Agent.Env.create();

const endpoint = MODEL_SELECTOR.split("/")[0];
if (!env.endpoints[endpoint]) {
  fail(
    `no endpoint named "${endpoint}" is configured. ` +
    `Run "omoya --login" (or edit your user settings "providers" table), ` +
    `or change MODEL_SELECTOR to one of: ${Object.keys(env.endpoints).join(", ") || "(none configured)"}.`,
  );
}

// --- Agent ------------------------------------------------------------------

const agent = new Agent({
  env,
  model: MODEL_SELECTOR,
  // Safe mode: publish and execute ONLY read-only tools. This example needs
  // no filesystem writes; safe mode is the right default for headless runs.
  safe: true,
  // No `session` option: an anonymous, in-memory session that writes nothing.
  name: "example-headless",
});

// --- Event handling ---------------------------------------------------------

// Agent.EVENT is the canonical numeric event vocabulary; onEvent registers a
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

agent.onEvent(E.ERROR, ({ error, kind }) => {
  fail(`provider error${kind ? ` (${kind})` : ""}: ${error ?? "unknown"}`);
});

// --- Run --------------------------------------------------------------------

// enqueue() appends a user message built with the public Context helpers and,
// because the agent is idle, starts the turn immediately. run() returns the
// promise for the terminal done/error event; awaiting it bounds the script's
// lifetime to the turn.
agent.enqueue(Agent.Context.userMessage(PROMPT));
const terminal = await agent.run();

// Deliberate example output: the provider-reported usage envelope, when any.
if (terminal?.usage) {
  const { inputTokens = 0, outputTokens = 0 } = terminal.usage;
  console.error(`[usage] input=${inputTokens} output=${outputTokens}`);
}

agent.close();
