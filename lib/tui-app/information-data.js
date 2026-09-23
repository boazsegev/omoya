/** Terminal-neutral projection of live tool messages/status for the footer. */

const MAX_ROWS = 8;
const MAX_TOOL_ROWS = 6;
const MAX_STREAM_ROWS = 4;

/**
 * Collect the viewed agent's sticky tool messages plus non-MCP global
 * tool status, plus the LIVE OUTPUT STREAM of a running tool (a bash
 * command's lines as they arrive — the proof it isn't stuck, capped
 * to its newest tail). Each source gets its own bounded share so one
 * noisy source cannot hide every other notification.
 */
export function informationData(agent, env, stream = []) {
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

  const status = (env?.toolStatus?.() ?? []).filter(({ name }) => name !== "mcp");
  if (status.length > 0) {
    rows.push({
      kind: "status",
      text: status.map(({ name, status: value }) => `${name} ${JSON.stringify(value)}`).join(" · "),
    });
  }
  return rows.slice(0, MAX_ROWS);
}

export const informationLimits = Object.freeze({ rows: MAX_ROWS, toolRows: MAX_TOOL_ROWS, streamRows: MAX_STREAM_ROWS });
