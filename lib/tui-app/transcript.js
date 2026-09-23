/**
 * lib/tui-app/transcript.js — context blocks (context-blocks.js) into
 * GTUI feed items: one item per block, keyed by its group/section/index
 * so a HOST commits each settled block ONCE (GTUI's `feed` items are
 * `{key, done, node}` — a `done` item is flushed to scrollback a
 * single time; the live/open block stays `done: false` and repaints
 * every frame — see lib/gtui/terminal-inline-host.js). Tool blocks get
 * the pi-style "▌ " bar prefix (parity with lib/tui-helpers/messages.js);
 * prose renders through markdown-view.js.
 */

import { view } from "../gtui/gtui.js";
import { markdownRows } from "./markdown-view.js";

const ROLE_FOR_TYPE = {
  system: "message.system", user: "message.user", draft: "message.draft",
  thinking: "message.thinking", text: "message.text",
  toolcall: "tool.call", toolresult: "tool.result", toolerror: "tool.error", display: "tool.display",
};
const TOOL_HEADER = { toolcall: "tool call", toolresult: "tool ok", toolerror: "tool error" };

function composedRole(base, detail) {
  return detail === "md.text" ? base : `${base} ${detail}`;
}

function styledMarkdownRows(text, base, window = null) {
  return markdownRows(text, window).map((row) => {
    const role = composedRole(base, row.role);
    if (row.table) return {
      role,
      table: { rows: row.table.rows.map((tableRow) => ({
        ...tableRow,
        cells: tableRow.cells.map((cell) => cell.map((span) => ({ ...span, role: [role, tableRow.role === "table.head" ? "md.table.heading" : "", span.role].filter(Boolean).join(" ") }))),
      })) },
    };
    return { role, content: row.content.map((span) => span.role ? { ...span, role: `${role} ${span.role}` } : span) };
  });
}

function rowsFor(block, window = null) {
  const role = ROLE_FOR_TYPE[block.type] ?? "message.text";
  if (block.type in TOOL_HEADER) {
    const header = block.label ? [{ role, content: [{ text: `[${TOOL_HEADER[block.type]}] ${block.label}` }] }] : [];
    return [...header, ...styledMarkdownRows(block.text ?? "", role, window)];
  }
  const body = styledMarkdownRows(block.text ?? "", role, window);
  if (block.type === "system") return [{ role, content: [{ text: "[system]" }] }, ...body];
  return body;
}

function keyFor(block) {
  return `${block.group}:${block.section ?? block.type}:${block.ordinal ?? 0}`;
}

function sameBlock(cached, block, priority) {
  return cached && cached.priority === priority && cached.type === block.type &&
    cached.label === block.label && cached.text === block.text && cached.open === block.open;
}

/** Per-app projector: unchanged semantic blocks reuse frozen nodes.
 *  Each block KEY gets a stable serial at first sight, and its feed
 *  priority derives from that serial — never from its current array
 *  index. A tool result spliced in next to its call shifts every later
 *  block's index; position-derived priorities would invalidate every
 *  later cached node (a full markdown re-render of the tail per tool
 *  result), while serials keep them all valid. Drop order stays
 *  chronological: a spliced result is newer than every block seen
 *  before it, so its fresh serial outranks them.
 *
 *  The returned projector is a plain object: project() does the work,
 *  ceiling() reports one past the highest priority handed out by the
 *  last project() call (0 before it) — the offset callers (notices)
 *  use to always outrank the transcript. */
export function createTranscriptProjector({ previews = true, previewRows = { system: 8, thinking: 8, toolcall: 3, toolresult: 3, toolerror: 3, display: false, user: false, text: false } } = {}) {
  const cache = new Map();
  let nextSerial = 0;
  let ceiling = 0;
  const project = (blocks, priorityOffset = 0) => {
    const live = new Set();
    const items = blocks.map((block) => {
      const key = keyFor(block);
      live.add(key);
      let cached = cache.get(key);
      const serial = cached?.serial ?? nextSerial++;
      const priority = priorityOffset + serial;
      if (!sameBlock(cached, block, priority)) {
        // Tool payloads and reasoning can be enormous while streaming. Keep a
        // present semantic header outside the preview; cap only parsed body
        // rows, including their visual soft-wrap rows. Displays stay complete.
        const hasHeader = block.type in TOOL_HEADER && Boolean(block.label);
        const maxRows = previewRows[block.type] ?? false;
        // A settled preview keeps its first visual row, an omission marker,
        // and the configured tail. Open THINKING/prose stays complete while
        // streaming (read-along, queued hints); open TOOL payloads
        // (streamed args/stdout — tail-interest by nature) window like
        // settled ones, so a 100k-line streamed payload never materializes
        // 100k row nodes per frame. Windowing itself happens before
        // markdown parsing (same head/tail as the column's own split, which
        // then overdraws the marker row).
        const toolPayload = block.type in TOOL_HEADER;
        const preview = previews && maxRows !== false && (!block.open || toolPayload);
        const previewOptions = { maxRows: Math.max(0, maxRows - 2), overflow: "tail", head: 1, ellipsis: true };
        const rows = rowsFor(block, preview ? { head: previewOptions.head, tail: previewOptions.maxRows } : null).map((row) => {
          if (row.table) return Object.freeze(view.table({ role: row.role, selectionKey: key, sourceText: block.text ?? "" }, row.table.rows));
          const content = Object.freeze(row.content.map((span) => Object.freeze({ ...span, ...(span.source ? { source: Object.freeze({ ...span.source }) } : {}) })));
          return Object.freeze(view.text({ role: row.role, selectionKey: key, sourceText: block.text ?? "" }, content));
        });
        const node = preview && hasHeader
          ? view.column({ priority }, [rows[0], view.column(previewOptions, rows.slice(1))])
          : preview
            ? view.column({ priority, ...previewOptions }, rows)
            : view.column({ priority }, rows);
        cached = { revision: (cached?.revision ?? 0) + 1, serial, priority, type: block.type, label: block.label, text: block.text, open: block.open, node: Object.freeze(node) };
        cache.set(key, cached);
      }
      return Object.freeze({ key, revision: cached.revision, done: !block.open, node: cached.node });
    });
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
    ceiling = priorityOffset + nextSerial;
    return Object.freeze(items);
  };
  return Object.freeze({ project, ceiling: () => ceiling });
}

/**
 * @param {Array} blocks - contextBlocks(context, live) output
 * @param {number} [priorityOffset] - see noticeItems: a feed longer than
 *   its box drops the LOWEST-priority item first (lib/gtui/layout.js's
 *   visibleChildren) — every item here needs a priority that increases
 *   with position, or a tie (GTUI's own default: 0 for everyone) drops
 *   from the END, showing the OLDEST content forever and never the
 *   latest turn. Chronological index IS that priority.
 * @returns {Array<{key: string, done: boolean, node: object}>} GTUI feed items
 */
export function transcriptItems(blocks, priorityOffset = 0, options) {
  // One-shot projection for single-use views (the block viewer) and
  // tests: caching is discarded per call, so recurring feeds must
  // retain a createTranscriptProjector() of their own.
  return createTranscriptProjector(options).project(blocks, priorityOffset);
}

/**
 * @param {Array<{id: number, text: string, kind: string}>} notices
 * @param {number} [priorityOffset] - pass transcriptItems' own length so
 *   a notice (always chronologically AFTER every block — see app.js's
 *   view()) always outranks them, never dropped first for being "item 0".
 * @returns {Array<{key: string, done: boolean, node: object}>} GTUI feed items
 */
export function noticeItems(notices, priorityOffset = 0) {
  return notices.map((notice, index) => ({
    key: `notice:${notice.id}`,
    done: true,
    node: view.text({
      role: notice.kind === "error" ? "notice.error" : "notice",
      priority: priorityOffset + index,
      selectionKey: `notice:${notice.id}`,
      sourceText: notice.text,
    }, [{ text: "· " }, { text: notice.text, source: { start: 0, end: notice.text.length } }]),
  }));
}
