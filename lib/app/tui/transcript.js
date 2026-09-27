/**
 * lib/app/tui/transcript.js — context blocks (context-blocks.js) into
 * GTUI feed items: one item per block (a tool call and its results fold
 * into ONE card — see toolCards), keyed by its group/section/index
 * so a HOST commits each settled block ONCE (GTUI's `feed` items are
 * `{key, done, node}` — a `done` item is flushed to scrollback a
 * single time; the live/open block stays `done: false` and repaints
 * every frame — see lib/app/gtui/terminal-inline-host.js). Tool blocks get
 * the pi-style "▌ " bar prefix; prose renders through markdown-view.js.
 */

import { view } from "../gtui/gtui.js";
import { markdownRows } from "./markdown-view.js";
import { formatDuration, toolSummary } from "../shared/format.js";

const ROLE_FOR_TYPE = {
  system: "message.system", user: "message.user", draft: "message.draft",
  thinking: "message.thinking", text: "message.text",
  toolcall: "tool.call", toolresult: "tool.result", toolerror: "tool.error", display: "tool.display",
  error: "notice.error",
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
      table: { ...row.table, rows: row.table.rows.map((tableRow) => ({
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

/** Blocks a tool card folds under its call: the call's results, streamed
 *  output, and tool displays (context-blocks.js splices them right after it). */
const isToolPart = (block) => block.category === "tool" && (block.type === "toolresult" || block.type === "toolerror" || block.type === "display");
const TURN_GAP = Object.freeze(view.text({}, ""));
const TOOL_GLYPH = { composing: "…", running: "◌", ok: "✓", error: "✕", skipped: "–" };
const TOOL_STATE_ROLE = { composing: "tool.call", running: "tool.call", ok: "tool.result", error: "tool.error", skipped: "tool.call" };

/** Fold each tool call and its parts into one `{type: "tool"}` card. A card
 *  still waiting on its result is PENDING only while the turn runs and
 *  nothing but tool cards follows it (its batch is the transcript's tail);
 *  an older unanswered call (an interrupted turn) settles as "not run", so
 *  it never holds back inline scrollback. */
export function toolCards(blocks, { running = false } = {}) {
  const out = [];
  for (let index = 0; index < blocks.length; index++) {
    const first = blocks[index];
    if (first.type !== "toolcall" && !isToolPart(first)) { out.push(first); continue; }
    const call = first.type === "toolcall" ? first : null;
    const parts = call ? [] : [first];
    while (index + 1 < blocks.length && blocks[index + 1].group === first.group && isToolPart(blocks[index + 1])) parts.push(blocks[++index]);
    out.push({ type: "tool", call, parts, group: first.group, section: first.section, ordinal: first.ordinal, label: call?.label ?? first.label, duration: call?.duration });
  }
  let tail = true;
  for (let index = out.length - 1; index >= 0; index--) {
    const card = out[index];
    if (card.type !== "tool") { tail = false; continue; }
    const result = card.parts.find((part) => part.type !== "display");
    card.state = result?.type === "toolerror" ? "error"
      : result && !result.open ? "ok"
        : result ? "running"
          : card.call?.open ? "composing"
            : running && tail ? "running" : "skipped";
    card.open = card.state === "composing" || card.state === "running";
  }
  return out;
}

/** One card: `✓ read  README.md · 4ms`, then the windowed payload (the
 *  output, or the arguments while the model is still writing the call),
 *  then any tool display in full. */
function toolCardNode(card, { key, priority, previews, maxRows }) {
  const role = TOOL_STATE_ROLE[card.state];
  const summary = toolSummary(card.call?.text ?? "");
  const header = view.text({ role, selectionKey: key, sourceText: card.call?.text ?? "", overflow: "clip-end" }, [
    { text: `${TOOL_GLYPH[card.state]} `, role },
    { text: card.label ?? "tool", role: `${role} md.strong` },
    ...(summary ? [{ text: `  ${summary}`, role }] : []),
    ...(Number.isFinite(card.duration) ? [{ text: ` · ${formatDuration(card.duration)}`, role }] : []),
  ]);
  const result = card.parts.find((part) => part.type !== "display");
  const payload = result ?? (card.state === "composing" ? card.call : null);
  const children = [header];
  const payloadText = (payload?.text ?? "").replace(/\s+$/, "");
  if (payloadText !== "") {
    const payloadRole = ROLE_FOR_TYPE[payload.type];
    const window = previews && maxRows !== false ? { maxRows: Math.max(0, maxRows - 2), overflow: "tail", head: 1, ellipsis: true } : null;
    const rows = styledMarkdownRows(payloadText, payloadRole, window ? { head: window.head, tail: window.maxRows } : null).map((row) => frozenRow(row, key, payload.text));
    children.push(window ? view.column(window, rows) : view.column({}, rows));
  }
  for (const display of card.parts.filter((part) => part.type === "display")) {
    children.push(...styledMarkdownRows(display.text ?? "", ROLE_FOR_TYPE.display).map((row) => frozenRow(row, key, display.text ?? "")));
  }
  return view.column({ priority }, children);
}

/** A card's identity for the node cache: everything its node renders. */
function cardSignature(card) {
  return [card.state, card.label, card.duration, card.call?.text, ...card.parts.flatMap((part) => [part.type, part.text, part.open])];
}

function frozenRow(row, key, sourceText) {
  if (row.table) return Object.freeze(view.table({ role: row.role, selectionKey: key, sourceText, align: row.table.align, headerRule: row.table.headerRule }, row.table.rows));
  const content = Object.freeze(row.content.map((span) => Object.freeze({ ...span, ...(span.source ? { source: Object.freeze({ ...span.source }) } : {}) })));
  return Object.freeze(view.text({ role: row.role, selectionKey: key, sourceText }, content));
}

/** A system message (the system prompt, a tool-attached note) is one
 *  transcript line — `⚙ system · <first line> · 142 lines`; its full text
 *  stays in context and in the block viewer (^O). */
function systemLineNode(block, { key, priority }) {
  const text = block.text ?? "";
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim() !== "")?.trim() ?? "";
  return view.text({ role: "message.system", priority, selectionKey: key, sourceText: text, overflow: "clip-end" }, [
    { text: "⚙ system", role: "message.system md.strong" },
    { text: `${first ? ` · ${first}` : ""} · ${lines.length} line${lines.length === 1 ? "" : "s"}` },
  ]);
}

/** "Thinking…" while reasoning streams, then "Thought for 4.2s" (or just
 *  "Thought" when its timing wasn't observed, e.g. a resumed session). */
function thinkingLabel(block) {
  if (block.open) return "Thinking…";
  return Number.isFinite(block.duration) ? `Thought for ${formatDuration(block.duration)}` : "Thought";
}

function keyFor(block) {
  return `${block.group}:${block.section ?? block.type}:${block.ordinal ?? 0}`;
}

function sameBlock(cached, block, priority) {
  if (!cached || cached.priority !== priority || cached.type !== block.type) return false;
  if (block.type === "tool") {
    const signature = cardSignature(block);
    return cached.signature.length === signature.length && signature.every((value, index) => value === cached.signature[index]);
  }
  return cached.label === block.label && cached.text === block.text && cached.open === block.open && cached.duration === block.duration;
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
 *  use to always outrank the transcript.
 *
 *  `cards` (default: on with previews) folds tool calls into one card per
 *  call; the block viewer renders single raw blocks without it. project()'s
 *  `running` says the viewed agent's turn is in progress (pending cards). */
export function createTranscriptProjector({ previews = true, cards = previews, previewRows = { system: 8, thinking: 8, toolcall: 3, toolresult: 3, toolerror: 3, display: false, user: false, text: false } } = {}) {
  const cache = new Map();
  let nextSerial = 0;
  let ceiling = 0;
  const project = (source, priorityOffset = 0, { running = false } = {}) => {
    const live = new Set();
    const blocks = cards ? toolCards(source, { running }) : source;
    const items = blocks.map((block) => {
      const key = keyFor(block);
      live.add(key);
      let cached = cache.get(key);
      const serial = cached?.serial ?? nextSerial++;
      const priority = priorityOffset + serial;
      if (block.type === "tool" && !sameBlock(cached, block, priority)) {
        const node = toolCardNode(block, { key, priority, previews, maxRows: previewRows.toolresult ?? false });
        cached = { revision: (cached?.revision ?? 0) + 1, serial, priority, type: block.type, signature: cardSignature(block), open: block.open, node: Object.freeze(node) };
        cache.set(key, cached);
      } else if (cards && block.type === "system" && !sameBlock(cached, block, priority)) {
        cached = { revision: (cached?.revision ?? 0) + 1, serial, priority, type: block.type, label: block.label, text: block.text, open: block.open, duration: block.duration, node: Object.freeze(systemLineNode(block, { key, priority })) };
        cache.set(key, cached);
      } else if (!sameBlock(cached, block, priority)) {
        // Tool payloads and reasoning can be enormous while streaming. Keep a
        // present semantic header outside the preview; cap only parsed body
        // rows, including their visual soft-wrap rows. Displays stay complete.
        const thinkingHeader = cards && block.type === "thinking";
        const hasHeader = (block.type in TOOL_HEADER && Boolean(block.label)) || thinkingHeader;
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
        const rows = rowsFor(block, preview ? { head: previewOptions.head, tail: previewOptions.maxRows } : null).map((row) => frozenRow(row, key, block.text ?? ""));
        if (thinkingHeader) rows.unshift(Object.freeze(view.text({ role: "message.thinking md.em", selectionKey: key, sourceText: block.text ?? "" }, [{ text: thinkingLabel(block) }])));
        const node = hasHeader && (preview || thinkingHeader)
          ? view.column({ priority }, [rows[0], preview ? view.column(previewOptions, rows.slice(1)) : view.column({}, rows.slice(1))])
          : preview
            ? view.column({ priority, ...previewOptions }, rows)
            // A user message opens a new exchange: one unstyled blank row
            // above it (outside the message's own background/border).
            : cards && block.type === "user"
              ? view.column({ priority }, [TURN_GAP, ...rows])
              : view.column({ priority }, rows);
        cached = { revision: (cached?.revision ?? 0) + 1, serial, priority, type: block.type, label: block.label, text: block.text, open: block.open, duration: block.duration, node: Object.freeze(node) };
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
