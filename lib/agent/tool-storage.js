// Transient per-Agent tool state. Only dispatch and tool detectors receive its boxes.
const stores = new WeakMap();

/** Return the stable, agent-local box for a named tool. No persistence is implied. */
export function toolStorage(agent, name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("toolStorage: a non-empty string tool name is required");
  }
  let boxes = stores.get(agent);
  if (!boxes) {
    boxes = new Map();
    stores.set(agent, boxes);
  }
  const key = name.trim();
  if (!boxes.has(key)) boxes.set(key, {});
  return boxes.get(key);
}
