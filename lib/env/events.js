/** Generic Env lifecycle events. Symbols avoid collisions with consumer values. */

export const ENV_EVENT = Object.freeze({
  AGENT_ADDED: Symbol("agent-added"),
  AGENT_REMOVED: Symbol("agent-removed"),
  AGENT_START: Symbol("agent-start"),
  AGENT_DONE: Symbol("agent-done"),
  IO_START: Symbol("io-start"),
  IO_DONE: Symbol("io-done"),
});
