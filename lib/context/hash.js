/**
 * lib/context/hash.js — change detection for the stateful Context
 * (private to Context; the store exposes only `dirty`).
 *
 * Every context entry (message or record) gets a CHAIN hash: the hash
 * of the previous entry's chain hash plus the entry itself, so an
 * edit, insertion, removal or reorder anywhere changes every later
 * value. The store keeps the values it last accepted and compares them
 * with a fresh chain to find the first changed entry.
 *
 * REPLAY DATA is provider data a later request sends back (a thinking
 * signature, redacted data): any field on a text, thinking or tool-call
 * block beyond its documented fields. It is only valid against the
 * history it was produced with.
 */

import { createHash } from "node:crypto";
import { ContentType, MessageType } from "./types.js";

/** Documented fields per block type that can carry replay data. */
const DOCUMENTED = new Map([
  [ContentType.Text, new Set(["type", "text"])],
  [ContentType.Thinking, new Set(["type", "text"])],
  [ContentType.ToolCall, new Set(["type", "callId", "name", "arguments"])],
]);

/**
 * Chain hashes for a context's entries, in order.
 * @param {Array<object>} entries - messages and records
 * @returns {string[]} one 32-hex-character chain hash per entry
 */
export function chainHashes(entries) {
  const out = [];
  let previous = "";
  for (const entry of entries) {
    previous = createHash("sha256").update(previous).update("\n").update(JSON.stringify(entry) ?? "")
      .digest("hex").slice(0, 32);
    out.push(previous);
  }
  return out;
}

/**
 * Whether a message carries replay data (see the module doc).
 * @param {object} message
 * @returns {boolean}
 */
export function hasReplayData(message) {
  if (!Array.isArray(message?.content)) return false;
  // Provider response IDs and complete replay steps may live on the assistant
  // message, not just its visible blocks. An edited ancestor must keep such
  // history dirty across later appends until the provider invalidates them.
  if (message.type === MessageType.Assistant && Object.keys(message).some((key) => !["type", "content", "draft", "error"].includes(key))) return true;
  return message.content.some((block) => {
    const documented = DOCUMENTED.get(block?.type);
    return documented !== undefined && Object.keys(block).some((key) => !documented.has(key));
  });
}
