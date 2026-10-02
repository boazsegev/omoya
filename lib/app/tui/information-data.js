/** Terminal-neutral projection of live tool messages/status for the footer. */

const MAX_ROWS = 8;
const MAX_TOOL_ROWS = 6;
const MAX_STREAM_ROWS = 4;

/**
 * Build a bounded, terminal-neutral footer projection of tool messages,
 * live stream output, and catalog tool status for the viewed agent. Stream
 * output uses only its newest lines; tool messages are individually capped,
 * and the final result is capped across all sources.
 *
 * @param {object|null|undefined} agent Viewed agent; `null` and `undefined`
 *   are accepted. Its optional `toolMessages()` method supplies an iterable
 *   of `{ name, text }` messages and is called when present.
 * @param {*} env Reserved environment argument; currently unused. No default.
 * @param {Array<{tool?: string, text: string}>} [stream=[]] Live stream
 *   entries. Non-arrays are ignored; for a non-empty array, its newest
 *   `informationLimits.streamRows` entries are rendered, with the final
 *   entry's `tool` naming the source. Default: an empty array.
 * @param {object|null|undefined} catalog Optional tool-catalog snapshot;
 *   `null` and `undefined` are accepted. Only an array-valued `tools` field
 *   is used; its `{ name, status }` entries with a defined status other than
 *   `mcp` are combined into one status row. No explicit default (undefined).
 * @returns {Array<{kind: "source"|"content"|"status", text: *}>}
 *   Synchronously returns footer rows, limited to `informationLimits.rows`.
 * @throws {TypeError} If `toolMessages` is present but not callable, its
 *   result is not iterable, or stream/message/catalog entries cannot be
 *   destructured. Also propagates serialization errors from `JSON.stringify`
 *   (such as for circular/BigInt statuses or a throwing `toJSON`).
 * @effects Calls `agent.toolMessages()` when available; performs no I/O or
 *   intentional mutation. Errors thrown by accessed getters/methods propagate.
 */
export function informationData(agent, env, stream = [], catalog) {
  const rows = [];
  if (Array.isArray(stream) && stream.length > 0) {
    // Streaming output is a rolling viewport, not a preview of a complete
    // result: render ONLY its newest lines. An ellipsis after the tail makes
    // a still-active command look frozen once its first rows roll away.
    const tail = stream.slice(-MAX_STREAM_ROWS);
    rows.push({ kind: "source", text: `▸ ${tail.at(-1)?.tool ?? "tool"} output:` });
    for (const { text } of tail) rows.push({ kind: "content", text });
  }
  for (const { name, text } of agent?.toolMessages?.() ?? []) {
    const body = String(text ?? "").split("\n");
    const toolRows = [
      { kind: "source", text: `▸ ${name}:` },
      ...body.map((line) => ({ kind: "content", text: line })),
    ];
    if (toolRows.length > MAX_TOOL_ROWS) {
      const hidden = toolRows.length - (MAX_TOOL_ROWS - 1);
      rows.push(...toolRows.slice(0, MAX_TOOL_ROWS - 1), {
        kind: "source",
        text: `  … +${hidden} more line${hidden === 1 ? "" : "s"}`,
      });
    } else {
      rows.push(...toolRows);
    }
  }

  // live tool status rides the tool catalog snapshot (completion-sources)
  const status = (Array.isArray(catalog?.tools) ? catalog.tools : []).filter(({ name, status: value }) => value !== undefined && name !== "mcp");
  if (status.length > 0) {
    rows.push({
      kind: "status",
      text: status.map(({ name, status: value }) => `${name} ${JSON.stringify(value)}`).join(" · "),
    });
  }
  return rows.slice(0, MAX_ROWS);
}

/**
 * Immutable row caps used by `informationData`: total output rows, rows per
 * tool message (including its source/overflow marker), and live-stream tail
 * entries (excluding the stream source row).
 *
 * @type {Readonly<{rows: number, toolRows: number, streamRows: number}>}
 * @effects Freezes the exported limits object against mutation.
 */
export const informationLimits = Object.freeze({ rows: MAX_ROWS, toolRows: MAX_TOOL_ROWS, streamRows: MAX_STREAM_ROWS });
