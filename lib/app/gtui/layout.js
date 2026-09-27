import { displayWidth, graphemes, graphemeWidth, wrapWordsOffsets } from "./width.js";
import { reorderBidiTokens } from "./bidi.js";
import { controlNaturalSize } from "./controls.js";

const LINE = Object.freeze({ tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" });
const integer = (value, fallback = 0) => Number.isFinite(value) ? Math.floor(value) : fallback;
const priorityOf = (node) => integer(node?.priority, 0);
const themedState = (state, theme) => theme ? Object.assign(Object.create(state ?? null), { theme }) : state;

function createCanvas(width, height) {
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => null));
  const targets = [];
  let focus = null;
  let caret = null;
  const canvas = { width, height, cells, targets, get focus() { return focus; }, set focus(value) { focus = value; }, get caret() { return caret; }, set caret(value) { caret = value; } };
  canvas.put = (x, y, text, meta = {}) => put(canvas, x, y, text, meta);
  return canvas;
}

function put(canvas, x, y, text, meta = {}) {
  if (y < 0 || y >= canvas.height || x < 0 || x >= canvas.width) return 0;
  if (canvas.clip && (x < canvas.clip.x || x >= canvas.clip.x + canvas.clip.w || y < canvas.clip.y || y >= canvas.clip.y + canvas.clip.h)) return 0;
  // Text tokens carry the width measured once when their (cached) rows were
  // built; only ad-hoc chrome glyphs are measured here.
  const width = meta.cellWidth ?? (graphemeWidth(text) || 1);
  if (x + width > canvas.width) return 0;
  // Geometry owns the glyph value. Metadata from a text token also has a
  // `text` field; spreading it last used to overwrite the null continuation
  // cell of every wide glyph, visibly duplicating emoji/CJK characters.
  canvas.cells[y][x] = { ...meta, text, cellWidth: width };
  if (width === 2) canvas.cells[y][x + 1] = { ...meta, text: null, cellWidth: 0 };
  return width;
}

function spanParts(node, content = node.content) {
  const values = Array.isArray(content) ? content : [content ?? ""];
  // Selection source is captured before bidi's visual-row transformation.
  // Applications may provide a richer raw source (for example Markdown), but
  // plain GTUI text remains safely copyable without duplicating that string.
  const logicalText = values.map((value) => typeof value === "string" || typeof value === "number"
    ? String(value) : String(value?.content ?? value?.text ?? "")).join("");
  const inherited = {
    role: node.role, link: node.link, action: node.action, source: node.source,
    selectionKey: node.selectionKey, sourceText: node.sourceText ?? logicalText,
  };
  return values.flatMap((value) => {
    if (typeof value === "string" || typeof value === "number") return [{ text: String(value), ...inherited }];
    if (!value) return [];
    return [{ text: String(value.content ?? value.text ?? ""), ...inherited, ...value }];
  });
}

function textTokens(node, content) {
  const tokens = [];
  let automaticSource = 0;
  for (const part of spanParts(node, content)) {
    const base = Number.isInteger(part.source?.start) ? part.source.start : automaticSource;
    let offset = 0;
    for (const grapheme of graphemes(part.text)) {
      tokens.push({
        text: grapheme, cellWidth: graphemeWidth(grapheme) || 1, index: automaticSource + offset, role: part.role, link: part.link, action: part.action,
        selectionKey: part.selectionKey, sourceText: part.sourceText,
        source: part.source ? { ...part.source, start: base + offset, end: base + offset + grapheme.length } : undefined,
      });
      offset += grapheme.length;
    }
    automaticSource += part.text.length;
  }
  return tokens;
}

function tokenWidth(tokens) {
  return tokens.reduce((sum, token) => sum + (token.cellWidth ?? (graphemeWidth(token.text) || 1)), 0);
}

function clipTokens(tokens, width, fromStart) {
  if (tokenWidth(tokens) <= width) return tokens;
  if (width <= 0) return [];
  if (width === 1) return [{ text: "…", role: tokens[fromStart ? tokens.length - 1 : 0]?.role }];
  const out = [];
  let used = 1;
  if (fromStart) {
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index];
      const w = token.cellWidth ?? (graphemeWidth(token.text) || 1);
      if (used + w > width) break;
      out.push(token);
      used += w;
    }
    out.reverse();
    return [{ text: "…", role: out[0]?.role }, ...out];
  }
  for (const token of tokens) {
    const w = token.cellWidth ?? (graphemeWidth(token.text) || 1);
    if (used + w > width) break;
    out.push(token);
    used += w;
  }
  return [...out, { text: "…", role: out.at(-1)?.role }];
}

function wrapTokens(tokens, width) {
  if (width <= 0) return [];
  const text = tokens.map(({ text }) => text).join("");
  if (text === "") return [[]];
  const ranges = [];
  let absolute = 0;
  for (const line of text.split("\n")) {
    const parts = line === "" ? [{ start: 0, end: 0 }] : wrapWordsOffsets(line, width);
    for (const part of parts) ranges.push({ start: absolute + part.start, end: absolute + part.end });
    absolute += line.length + 1;
  }
  // Ranges and tokens are both ordered by logical source offset. Advancing
  // one cursor avoids re-scanning every grapheme for every wrapped row.
  const rows = [];
  let token = 0;
  for (const { start, end } of ranges) {
    while (token < tokens.length && tokens[token].index < start) token++;
    const row = [];
    let index = token;
    while (index < tokens.length && tokens[index].index < end) row.push(tokens[index++]);
    rows.push(row);
    token = index;
  }
  return rows;
}

/** Horizontal text gutters. Every text node defaults to two characters on
 * each side so terminal content never collides with a window border;
 * callers may set `margin: 0` for chrome that already supplies one. */
function textMetrics(node, width, theme) {
  const decoration = theme?.decoration?.(node.role);
  const gutter = decoration?.left ? 1 + decoration.left.gap : 0;
  const margin = Math.max(0, Math.min(Math.floor(Math.max(0, width - gutter - 1) / 2), integer(node.margin, 2)));
  return { decoration, gutter, margin, width: Math.max(1, width - gutter - margin * 2) };
}

// A render repeatedly measures and draws the same semantic nodes. Keep that
// work local to one layout first; frozen text content may safely survive into
// later layouts. Mutable view nodes deliberately only use the frame cache.
let frameTextCache = null;
const frozenTextCache = new WeakMap();

// Deep-frozen data can never change again, so a positive verdict is permanent.
// (A negative one is not: an object may be frozen later.) Remembering it turns
// the per-frame walk over every visible transcript node into one lookup.
const deepFrozen = new WeakSet();

function frozenData(value) {
  if (value === null || typeof value !== "object") return true;
  if (deepFrozen.has(value)) return true;
  const seen = new WeakSet();
  const visited = [];
  if (!frozenWalk(value, seen, visited)) return false;
  // Every() short-circuits, so a true verdict verified everything visited.
  for (const item of visited) deepFrozen.add(item);
  return true;
}

function frozenWalk(value, seen, visited) {
  if (value === null || typeof value !== "object" || deepFrozen.has(value)) return true;
  if (!Object.isFrozen(value) || seen.has(value)) return seen.has(value);
  seen.add(value);
  visited.push(value);
  seen.add(value);
  // Frozen accessors can still produce changing content. Require data
  // properties recursively: this includes node/source and every rich span's
  // source metadata captured in the cached tokens.
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
    "value" in descriptor && frozenWalk(descriptor.value, seen, visited));
}

/** Wrapped rows + content width of a text node at one width. One entry per
 *  node: the scrollbar overlays the outer right text margin, so a frame has
 *  one content width, and a resize re-wraps once, replacing the old entry
 *  (no obsolete transcript token graph is retained). */
function textEntry(node, width) {
  const overflow = node.overflow ?? "wrap";
  const fits = (entry) => entry?.width === width && entry.overflow === overflow;
  let entry = frameTextCache?.get(node);
  if (fits(entry)) return entry;
  const reusable = frozenData(node);
  entry = reusable ? frozenTextCache.get(node) : null;
  if (fits(entry)) {
    frameTextCache?.set(node, entry);
    return entry;
  }
  const tokens = textTokens(node, node.content);
  const rows = (node.overflow === "clip-start"
    ? [clipTokens(tokens, width, true)]
    : node.overflow === "clip-end" ? [clipTokens(tokens, width, false)] : wrapTokens(tokens, width))
    // Reorder only at the final row-render boundary. Tokens retain logical
    // source offsets, so copy and pointer consumers never receive glyph order.
    .map(reorderBidiTokens);
  entry = { width, overflow, rows, contentWidth: Math.max(0, ...rows.map(tokenWidth)) };
  frameTextCache?.set(node, entry);
  if (reusable) frozenTextCache.set(node, entry);
  return entry;
}

function textRows(node, width) {
  return textEntry(node, width).rows;
}

const TABLE_GAP = 3;
/** Rows a table's optional header rule adds: one `─` line under the first
 *  row (`headerRule: <role>`) when a body follows it. */
const tableRuleRows = (node) => (node.headerRule && (node.rows?.length ?? 0) > 1 ? 1 : 0);

function tableCellTokens(node, row, cell) {
  const cellRole = row.role === "table.head" ? "md.table.heading" : undefined;
  const content = (cell ?? []).map((span) => ({
    ...span,
    role: [node.role, cellRole, span.role].filter(Boolean).join(" "),
  }));
  return textTokens({ ...node, content }, content);
}

function tableLayout(node, width) {
  const rows = node.rows ?? [];
  const columns = Math.max(0, ...rows.map((row) => row.cells?.length ?? 0));
  if (columns === 0) return { widths: [], rows: [] };
  const cells = rows.map((row) => Array.from({ length: columns }, (_, index) => tableCellTokens(node, row, row.cells?.[index])));
  const widths = Array.from({ length: columns }, (_, index) => Math.max(1, ...cells.map((row) => tokenWidth(row[index]))));
  const available = Math.max(columns, width - TABLE_GAP * (columns - 1));
  while (widths.reduce((sum, value) => sum + value, 0) > available) {
    let widest = 0;
    for (let index = 1; index < widths.length; index++) if (widths[index] > widths[widest]) widest = index;
    const next = Math.max(1, Math.floor(widths[widest] * 3 / 4));
    if (next === widths[widest]) break;
    widths[widest] = next;
  }
  const visualRows = cells.map((row) => {
    const wrapped = row.map((tokens, index) => wrapTokens(tokens, widths[index]));
    return { cells: wrapped, height: Math.max(1, ...wrapped.map((cell) => cell.length)) };
  });
  return { widths, rows: visualRows };
}

function naturalSize(node, width, height, state) {
  if (!node || width <= 0 || height <= 0) return { w: 0, h: 0 };
  if (node.type === "text") {
    const metrics = textMetrics(node, width, state?.theme);
    const maximum = Number.isFinite(node.maxWidth) ? Math.max(0, Math.floor(node.maxWidth)) : metrics.width;
    const measuredWidth = Math.min(metrics.width, maximum);
    const { rows, contentWidth: measuredContentWidth } = textEntry(node, measuredWidth);
    const contentWidth = Math.min(measuredWidth, measuredContentWidth);
    return { w: Math.min(width, contentWidth + metrics.gutter + metrics.margin * 2), h: Math.min(height, rows.length) };
  }
  if (node.type === "table") {
    const metrics = textMetrics(node, width, state?.theme);
    const table = tableLayout(node, metrics.width);
    const contentWidth = table.widths.reduce((sum, value) => sum + value, 0) + TABLE_GAP * Math.max(0, table.widths.length - 1);
    return { w: Math.min(width, contentWidth + metrics.gutter + metrics.margin * 2), h: Math.min(height, table.rows.reduce((sum, row) => sum + row.height, 0) + tableRuleRows(node)) };
  }
  if (node.type === "input" || node.type === "menu" || node.type === "toolbar") return controlNaturalSize(node, width, height);
  if (node.type === "panel") {
    const child = node.children?.[0];
    const inner = naturalSize(child, Math.max(0, width - 2), Math.max(0, height - 2), state);
    return { w: Math.min(width, inner.w + 2), h: Math.min(height, inner.h + 2) };
  }
  const nodeChildren = node.type === "feed" ? (node.items ?? []).map(({ node: child }) => child) : (node.children ?? []);
  // A tail preview is a viewport over the already-laid-out child rows, not
  // source truncation. Measure its children at their natural height first.
  // `head` and `ellipsis` are additional rows outside the tail cap: this lets
  // callers request `{ maxRows: 6, head: 1, ellipsis: true }` for an eight-row
  // preview without changing the established meaning of `maxRows`.
  if (node.type === "column" && Number.isFinite(node.maxRows)) {
    const children = visibleChildren(nodeChildren, 1e6);
    const sizes = children.map((child) => naturalSize(child, width, 1e6, state));
    const total = sizes.reduce((sum, size) => sum + size.h, 0);
    const tail = Math.max(0, Math.floor(node.maxRows));
    const head = Math.max(0, Math.floor(integer(node.head)));
    const isSplit = node.overflow === "tail" && node.ellipsis === true && total > head + tail;
    const visible = isSplit ? head + 1 + tail : node.ellipsis === true ? total : Math.min(tail, total);
    return {
      w: Math.min(width, Math.max(0, ...sizes.map(({ w }) => w))),
      h: Math.min(height, visible),
    };
  }
  const children = visibleChildren(nodeChildren, node.type === "row" || node.type === "grid" ? width : height);
  if (node.type === "row") {
    const sizes = children.map((child) => naturalSize(child, width, height, state));
    return { w: Math.min(width, sizes.reduce((sum, size) => sum + size.w, 0)), h: Math.min(height, Math.max(0, ...sizes.map(({ h }) => h))) };
  }
  const sizes = children.map((child) => naturalSize(child, width, height, state));
  return { w: Math.min(width, Math.max(0, ...sizes.map(({ w }) => w))), h: Math.min(height, sizes.reduce((sum, size) => sum + size.h, 0)) };
}

function visibleChildren(children, capacity) {
  const list = children.filter(Boolean);
  const limit = Math.max(0, capacity);
  if (list.length <= limit) return list;
  // Lowest priority loses; equal priority breaks toward the later child.
  // Sorting discard candidates once replaces the old repeated map/min/find
  // loop, which became quadratic in large transcript/status collections.
  const discard = list.map((child, index) => ({ child, index, priority: priorityOf(child) }))
    .sort((a, b) => (a.priority - b.priority) || (b.index - a.index));
  const removed = new Set(discard.slice(0, list.length - limit).map(({ index }) => index));
  return list.filter((_, index) => !removed.has(index));
}

function trackSizes(tracks, available, natural, priorities = tracks.map(() => 0)) {
  const values = tracks.map((track, index) => typeof track === "number" ? Math.max(0, track) : track === "auto" ? natural[index] : null);
  const fixed = values.reduce((sum, value) => sum + (value ?? 0), 0);
  let fills = values.reduce((count, value) => count + (value === null ? 1 : 0), 0);
  let remaining = Math.max(0, available - fixed);
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== null) continue;
    const size = fills === 0 ? 0 : Math.floor(remaining / fills);
    values[index] = size;
    remaining -= size;
    fills--;
  }
  let overflow = values.reduce((sum, value) => sum + value, 0) - available;
  // Cut the LOWEST-priority tracks first (default priority 0 for
  // everyone ties, breaking toward the LAST track first — the
  // original, still-correct behavior for row/column/grid tracks with
  // no priority of their own); a feed given priority 0 next to a
  // status/input given a higher one (app.js) shrinks before either.
  const order = values.map((_, index) => index).sort((a, b) => (priorities[a] - priorities[b]) || (b - a));
  for (const index of order) {
    if (overflow <= 0) break;
    const cut = Math.min(values[index], overflow);
    values[index] -= cut;
    overflow -= cut;
  }
  return values;
}

function drawText(canvas, node, box, state) {
  const metrics = textMetrics(node, box.w, state?.theme);
  const width = Number.isFinite(node.maxWidth) ? Math.min(metrics.width, Math.max(0, Math.floor(node.maxWidth))) : metrics.width;
  const rows = textRows(node, width);
  const visibleTop = Math.max(box.y, canvas.clip?.y ?? box.y);
  const visibleBottom = Math.min(box.y + box.h, (canvas.clip?.y ?? 0) + (canvas.clip?.h ?? canvas.height));
  for (let row = Math.max(0, visibleTop - box.y); row < Math.min(rows.length, box.h, visibleBottom - box.y); row++) {
    const y = box.y + row;
    // A background styles the text node's allocated row, not merely its
    // glyphs. Painting semantic blanks here makes inline and fullscreen
    // hosts agree while leaving background-free rows compact.
    if (state?.theme?.resolve(node.role ?? "text")?.bg !== null) {
      for (let fill = box.x; fill < box.x + box.w; fill++) put(canvas, fill, y, " ", { role: node.role });
    }
    if (metrics.decoration?.left) put(canvas, box.x, y, metrics.decoration.left.glyph, { role: metrics.decoration.left.role });
    let x = box.x + metrics.gutter + metrics.margin;
    const right = box.x + box.w;
    for (const token of rows[row]) {
      if (x >= right) break;
      const used = put(canvas, x, y, token.text, token);
      if (used === 0) break;
      x += used;
    }
  }
}

function drawTable(canvas, node, box, state) {
  const metrics = textMetrics(node, box.w, state?.theme);
  const table = tableLayout(node, metrics.width);
  const tableWidth = table.widths.reduce((sum, value) => sum + value, 0) + TABLE_GAP * Math.max(0, table.widths.length - 1);
  // `align: "start"` keeps the table at the text margin; the default centers it.
  const left = box.x + metrics.gutter + metrics.margin + (node.align === "start" ? 0 : Math.floor((metrics.width - tableWidth) / 2));
  let y = box.y;
  for (const [index, row] of table.rows.entries()) {
    if (index === 1 && tableRuleRows(node) > 0) {
      if (metrics.decoration?.left) put(canvas, box.x, y, metrics.decoration.left.glyph, { role: metrics.decoration.left.role });
      for (let x = 0; x < tableWidth; x++) put(canvas, left + x, y, "─", { role: node.headerRule });
      y += 1;
      if (y >= box.y + box.h) break;
    }
    for (let line = 0; line < row.height && y + line < box.y + box.h; line++) {
      if (metrics.decoration?.left) put(canvas, box.x, y + line, metrics.decoration.left.glyph, { role: metrics.decoration.left.role });
      let x = left;
      row.cells.forEach((cell, column) => {
        for (const token of cell[line] ?? []) {
          const used = put(canvas, x, y + line, token.text, token);
          if (used === 0) break;
          x += used;
        }
        x = left + table.widths.slice(0, column + 1).reduce((sum, value) => sum + value, 0) + TABLE_GAP * (column + 1);
      });
    }
    y += row.height;
    if (y >= box.y + box.h) break;
  }
}

function drawPanel(canvas, node, box, state) {
  if (box.w < 2 || box.h < 2) return;
  const role = node.active ? "border.active" : (node.role ?? "border");
  put(canvas, box.x, box.y, LINE.tl, { role });
  put(canvas, box.x + box.w - 1, box.y, LINE.tr, { role });
  put(canvas, box.x, box.y + box.h - 1, LINE.bl, { role });
  put(canvas, box.x + box.w - 1, box.y + box.h - 1, LINE.br, { role });
  for (let x = 1; x < box.w - 1; x++) {
    put(canvas, box.x + x, box.y, LINE.h, { role });
    put(canvas, box.x + x, box.y + box.h - 1, LINE.h, { role });
  }
  for (let y = 1; y < box.h - 1; y++) {
    put(canvas, box.x, box.y + y, LINE.v, { role });
    put(canvas, box.x + box.w - 1, box.y + y, LINE.v, { role });
  }
  if (node.title && box.w > 4) drawText(canvas, { type: "text", margin: 0, role, overflow: "clip-end", content: ` ${node.title} ` }, { x: box.x + 2, y: box.y, w: box.w - 4, h: 1 }, state);
  drawNode(canvas, node.children?.[0], { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 }, state);
}

function drawNaturalColumn(canvas, children, sizes, box, state, offset = 0) {
  let cursor = box.y + offset;
  children.forEach((child, index) => {
    drawNode(canvas, child, { x: box.x, y: cursor, w: box.w, h: sizes[index] }, state);
    cursor += sizes[index];
  });
}

function drawSequence(canvas, node, box, state, axis) {
  const isTailPreview = axis === "y" && node.overflow === "tail" && Number.isFinite(node.maxRows);
  // Tail preview children must keep their natural visual height. Running
  // track shrinking first would discard wrapped rows before suffix selection.
  const children = visibleChildren(node.children ?? [], isTailPreview ? 1e6 : (axis === "x" ? box.w : box.h));
  const available = axis === "x" ? box.w : box.h;
  const natural = children.map((child) => {
    const size = naturalSize(child, box.w, isTailPreview ? 1e6 : box.h, state);
    return axis === "x" ? size.w : size.h;
  });
  const declared = axis === "x" ? node.columns : node.rows;
  const tracks = Array.isArray(declared) && declared.length === children.length ? declared : natural;
  const sizes = isTailPreview ? natural : trackSizes(tracks, available, natural, children.map(priorityOf));
  if (isTailPreview) {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const tail = Math.min(box.h, Math.max(0, Math.floor(node.maxRows)));
    const head = Math.min(box.h, Math.max(0, Math.floor(integer(node.head))));
    const isSplit = node.ellipsis === true && total > head + tail;
    if (isSplit) {
      drawNaturalColumn(clippedCanvas(canvas, { ...box, h: head }), children, sizes, box, state);
      drawText(canvas, { type: "text", margin: 0, content: "..." }, { ...box, y: box.y + head, h: 1 }, state);
      const tailBox = { ...box, y: box.y + head + 1, h: Math.min(tail, Math.max(0, box.h - head - 1)) };
      drawNaturalColumn(clippedCanvas(canvas, tailBox), children, sizes, tailBox, state, tailBox.h - total);
      return;
    }
    const cap = node.ellipsis === true ? Math.min(box.h, total) : Math.min(box.h, Math.max(0, Math.floor(node.maxRows)));
    drawNaturalColumn(clippedCanvas(canvas, { ...box, h: cap }), children, sizes, box, state, node.ellipsis === true ? 0 : -Math.max(0, total - cap));
    return;
  }
  let cursor = axis === "x" ? box.x : box.y;
  children.forEach((child, index) => {
    const childBox = axis === "x" ? { x: cursor, y: box.y, w: sizes[index], h: box.h } : { x: box.x, y: cursor, w: box.w, h: sizes[index] };
    drawNode(canvas, child, childBox, state);
    cursor += sizes[index];
  });
}

/** A narrower clip over `canvas` that keeps the parent's put chain (and so
 *  any scroll selection metadata) intact. */
function narrowedCanvas(canvas, box) {
  const outer = canvas.clip ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const x = Math.max(outer.x, box.x);
  const y = Math.max(outer.y, box.y);
  const clip = { x, y, w: Math.max(0, Math.min(outer.x + outer.w, box.x + box.w) - x), h: Math.max(0, Math.min(outer.y + outer.h, box.y + box.h) - y) };
  const narrowed = Object.create(canvas);
  narrowed.clip = clip;
  narrowed.put = (cx, cy, text, meta) => (cx < clip.x || cx >= clip.x + clip.w || cy < clip.y || cy >= clip.y + clip.h ? 0 : canvas.put(cx, cy, text, meta));
  return narrowed;
}

/** A feed (the transcript) is ONE continuous column of whole entries. An
 *  under-full feed renders top-down from the box's own top (its blank space
 *  sits at the BOTTOM, against the input below it, matching inline mode's
 *  native scrollback); an overflowing feed is bottom-anchored so the newest
 *  rows win. Entries are never re-sliced into child subsets: an entry taller
 *  than the visible rows is drawn whole and clipped, so its visible part is
 *  exactly its last N rows at every scroll offset — no row is skipped or
 *  duplicated at the live/scrollback boundary, and scrolling moves one row
 *  per row.
 *
 *  Reports per feed, for the inline host: `evictedAbove` — the contiguous
 *  prefix of entries starting above the visible rows (offscreen newer items
 *  below a scrolled viewport are never included), and `overflowAbove` — for
 *  the entry straddling the visible top, how many of its rows stay visible. */
function drawFeed(canvas, node, box, state) {
  const entries = node.items ?? [];
  const clip = canvas.clip ?? { y: 0, h: canvas.height };
  const top = Math.max(box.y, clip.y);
  const bottom = Math.min(box.y + box.h, clip.y + clip.h);
  // Measure newest-first until the box is full: older entries can never be
  // visible. naturalSize clamps to the height it is given, so measure with a
  // generous finite bound.
  const heights = [];
  let used = 0;
  let first = entries.length;
  while (first > 0 && used < box.h) {
    first--;
    heights[first] = naturalSize(entries[first].node, box.w, 1e6, state).h;
    used += heights[first];
  }
  const evictedAbove = new Set(entries.slice(0, first).map((item) => item.key));
  const overflowAbove = new Map();
  const target = narrowedCanvas(canvas, box);
  let cursor = box.y + Math.min(0, box.h - used);
  for (let index = first; index < entries.length; index++) {
    const entry = entries[index];
    const h = heights[index];
    if (cursor + h <= top) evictedAbove.add(entry.key);
    else if (cursor < top) {
      evictedAbove.add(entry.key);
      overflowAbove.set(entry.key, cursor + h - top);
    }
    if (h > 0 && cursor < bottom && cursor + h > top) drawNode(target, entry.node, { x: box.x, y: cursor, w: box.w, h }, state);
    cursor += h;
  }
  if (state.feedVisible) state.feedVisible.set(node.id ?? `feed:${state.feedOrdinal++}`, { evictedAbove, overflowAbove });
}

function drawGrid(canvas, node, box, state) {
  const columns = node.columns?.length ? node.columns : ["fill"];
  const children = visibleChildren(node.children ?? [], box.w * box.h);
  const natural = columns.map((_, index) => Math.max(0, ...children.filter((__, childIndex) => childIndex % columns.length === index).map((child) => naturalSize(child, box.w, 1, state).w)));
  const widths = trackSizes(columns, box.w, natural);
  const rowCount = Math.ceil(children.length / columns.length);
  const heights = trackSizes(node.rows?.length === rowCount ? node.rows : Array(rowCount).fill("auto"), box.h, Array(rowCount).fill(1));
  let y = box.y;
  for (let row = 0; row < rowCount; row++) {
    let x = box.x;
    for (let column = 0; column < columns.length; column++) {
      const child = children[row * columns.length + column];
      if (child) drawNode(canvas, child, { x, y, w: widths[column], h: heights[row] }, state);
      x += widths[column];
    }
    y += heights[row];
  }
}

function clippedCanvas(canvas, box, rowOffset = 0, scrollTarget = null) {
  const outer = canvas.clip ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const x = Math.max(outer.x, box.x);
  const y = Math.max(outer.y, box.y);
  const right = Math.min(outer.x + outer.w, box.x + box.w);
  const bottom = Math.min(outer.y + outer.h, box.y + box.h);
  const clipped = Object.create(canvas);
  clipped.clip = { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
  clipped.put = (cx, cy, text, meta = {}) => put(clipped, cx, cy, text, { ...meta, selectionRow: cy + rowOffset, selectionScroll: scrollTarget });
  return clipped;
}

function drawNode(canvas, node, box, state) {
  if (!node || box.w <= 0 || box.h <= 0) return;
  const clip = canvas.clip;
  const outside = clip && (box.x + box.w <= clip.x || box.x >= clip.x + clip.w || box.y + box.h <= clip.y || box.y >= clip.y + clip.h);
  // Scroll controls must mount even when their content is outside their
  // viewport so keyboard/pointer state and anchors remain live.
  if (outside && node.type !== "scroll") return;
  if (node.focus === true || node.focused === true) canvas.focus = node.id ?? null;
  if (node.type === "input" && Number.isInteger(node.caret)) canvas.caret = { id: node.id ?? null, index: node.caret };
  if (node.action) state?.drawControl?.(canvas, node, box);
  if (node.type === "text") return drawText(canvas, node, box, state);
  if (node.type === "table") return drawTable(canvas, node, box, state);
  if (node.type === "panel") return drawPanel(canvas, node, box, state);
  if (node.type === "row") return drawSequence(canvas, node, box, state, "x");
  if (node.type === "column") return drawSequence(canvas, node, box, state, "y");
  if (node.type === "grid") return drawGrid(canvas, node, box, state);
  if (node.type === "feed") return drawFeed(canvas, node, box, state);
  if (node.type === "scroll") {
    const framed = state?.drawControl?.(canvas, node, box) ?? box;
    const child = node.children?.[0];
    let viewport = framed;
    let contentHeight = Math.max(viewport.h, naturalSize(child, viewport.w, 1e6, state).h);
    const reserved = state?.reserveScrollBar?.(node, viewport, contentHeight);
    if (reserved && reserved.w !== viewport.w) {
      viewport = reserved;
      contentHeight = Math.max(viewport.h, naturalSize(child, viewport.w, 1e6, state).h);
    }
    const maxOffset = Math.max(0, contentHeight - viewport.h);
    const requested = Math.max(0, (state?.syncScroll?.(node, contentHeight, viewport.h)
      ?? state?.stateFor?.(node.id)?.scroll ?? Number(node.offset ?? 0)) || 0);
    const fromTop = node.anchor === "end"
      ? Math.max(0, maxOffset - Math.min(maxOffset, requested))
      : Math.min(maxOffset, requested);
    const result = drawNode(clippedCanvas(canvas, viewport, fromTop, node.id), child, { ...viewport, y: viewport.y - fromTop, h: contentHeight }, state);
    state?.drawScrollBar?.(canvas, node, { viewport, contentHeight, maxOffset, fromTop });
    return result;
  }
  if (node.type === "overlay") {
    const children = node.children ?? [];
    if (children.length > 1) drawNode(canvas, children[0], box, state);
    const child = children.at(-1);
    // A modal owns the whole viewport while its content stays in the
    // established centered 80% × 90% safe area. `fill` means the child
    // receives that complete area (menus/viewers); otherwise compact
    // dialogs keep their natural size within the same bound.
    const limit = { w: Math.max(1, Math.floor(box.w * 0.8)), h: Math.max(1, Math.floor(box.h * 0.9)) };
    const size = node.fill ? limit : naturalSize(child, limit.w, limit.h, state);
    const position = node.position;
    const x = position === "top-right" ? box.x + box.w - size.w : box.x + Math.floor((box.w - size.w) / 2);
    const y = position === "top-right" ? box.y : box.y + Math.floor((box.h - size.h) / 2);
    const childBox = { x, y, w: size.w, h: size.h };
    const result = drawNode(canvas, child, childBox, state);
    for (const layer of node.layers ?? []) {
      const layerNode = layer?.node;
      const layerSize = naturalSize(layerNode, childBox.w, childBox.h, state);
      const layerBox = layer?.position === "top-right"
        ? { x: childBox.x + childBox.w - layerSize.w, y: childBox.y, w: layerSize.w, h: layerSize.h }
        : childBox;
      drawNode(canvas, layerNode, layerBox, state);
    }
    return result;
  }
  state?.drawControl?.(canvas, node, box);
}

function semanticSnapshot(canvas) {
  const lines = [];
  const roles = [];
  const links = [];
  const sources = [];
  const lastOccupiedRow = canvas.cells.findLastIndex((candidate) => candidate.some(Boolean));
  for (let row = 0; row < canvas.height; row++) {
    const cells = canvas.cells[row];
    let line = "";
    for (const cell of cells) if (cell?.text !== null) line += cell?.text ?? " ";
    line = line.trimEnd();
    if (line !== "" || row < lastOccupiedRow) lines.push(line);
    const collect = (key, output, valueOf) => {
      let start = null;
      let current = null;
      for (let column = 0; column <= cells.length; column++) {
        const value = column < cells.length ? valueOf(cells[column]) : null;
        if (value === current) continue;
        if (current !== null) output.push({ row, start, end: column, [key]: current });
        current = value;
        start = column;
      }
    };
    collect("role", roles, (cell) => cell?.role ?? null);
    collect("link", links, (cell) => cell?.link ?? null);
    collect("source", sources, (cell) => cell?.source ? JSON.stringify(cell.source) : null);
  }
  return { lines, roles, links, sources: sources.map((item) => ({ ...item, source: JSON.parse(item.source) })), focus: canvas.focus, caret: canvas.caret };
}

/** Measure semantic content without allocating a terminal-sized canvas. */
export function measureView(root, { width = 80, height = 4096, controls, theme } = {}) {
  const availableWidth = Math.max(1, integer(width, 80));
  const availableHeight = Math.max(1, integer(height, 4096));
  const previous = frameTextCache;
  frameTextCache = new WeakMap();
  try {
    const size = naturalSize(root, availableWidth, availableHeight, themedState(controls, theme));
    return { width: size.w, height: size.h };
  } finally { frameTextCache = previous; }
}

/** Resolve semantic view nodes into host-owned geometry. */
export function layoutView(root, { width = 80, height = 24, controls, theme, verticalAlign = "start" } = {}) {
  const canvas = createCanvas(Math.max(1, integer(width, 80)), Math.max(1, integer(height, 24)));
  controls?.beginFrame?.();
  const previousCache = frameTextCache;
  frameTextCache = new WeakMap();
  // themedState may return undefined when a plain layout has neither host
  // controls nor a theme. Geometry metadata must still have a private state.
  const state = themedState(controls, theme) ?? Object.create(null);
  state.feedVisible = new Map();
  state.feedOrdinal = 0;
  let box = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  try {
    // Inline terminals keep a short live region at the screen bottom. An
    // overlay still receives the full viewport so its own centering/fill
    // contract remains unchanged.
    if (verticalAlign === "end" && root?.type !== "overlay") {
      const natural = naturalSize(root, canvas.width, canvas.height, state).h;
      box = { ...box, y: canvas.height - natural, h: natural };
    }
    drawNode(canvas, root, box, state);
    controls?.applySelection?.(canvas);
    controls?.endFrame?.(root, canvas);
    // Only diagnostics/tests (memory host, sceneText) read the snapshot;
    // terminal hosts never pay for it. Built once, on first access.
    let snapshot = null;
    return { canvas, get snapshot() { return snapshot ??= semanticSnapshot(canvas); }, feedVisible: state.feedVisible };
  } finally { frameTextCache = previousCache; }
}

export function sceneText(scene) {
  return scene.snapshot.lines.join("\n");
}

export const layoutInternals = Object.freeze({ naturalSize, textRows, trackSizes });
