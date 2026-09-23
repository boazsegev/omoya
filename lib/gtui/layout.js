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
  const width = graphemeWidth(text) || 1;
  if (x + width > canvas.width) return 0;
  // Geometry owns the glyph value. Metadata from a text token also has a
  // `text` field; spreading it last used to overwrite the null continuation
  // cell of every wide glyph, visibly duplicating emoji/CJK characters.
  canvas.cells[y][x] = { ...meta, text };
  if (width === 2) canvas.cells[y][x + 1] = { ...meta, text: null };
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
        text: grapheme, index: automaticSource + offset, role: part.role, link: part.link, action: part.action,
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
  return tokens.reduce((sum, token) => sum + (graphemeWidth(token.text) || 1), 0);
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
      const w = graphemeWidth(token.text) || 1;
      if (used + w > width) break;
      out.push(token);
      used += w;
    }
    out.reverse();
    return [{ text: "…", role: out[0]?.role }, ...out];
  }
  for (const token of tokens) {
    const w = graphemeWidth(token.text) || 1;
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

function frozenData(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value) || seen.has(value)) return seen.has(value);
  seen.add(value);
  // Frozen accessors can still produce changing content. Require data
  // properties recursively: this includes node/source and every rich span's
  // source metadata captured in the cached tokens.
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
    "value" in descriptor && frozenData(descriptor.value, seen));
}

function textRows(node, width) {
  const key = `${width}:${node.overflow ?? "wrap"}`;
  let entries = frameTextCache?.get(node);
  if (entries?.has(key)) return entries.get(key).rows;
  const content = node.content;
  const reusable = frozenData(node);
  entries = entries ?? (reusable ? frozenTextCache.get(node) : null);
  if (entries?.has(key)) {
    frameTextCache?.set(node, entries);
    return entries.get(key).rows;
  }
  const tokens = textTokens(node, content);
  const rows = (node.overflow === "clip-start"
    ? [clipTokens(tokens, width, true)]
    : node.overflow === "clip-end" ? [clipTokens(tokens, width, false)] : wrapTokens(tokens, width))
    // Reorder only at the final row-render boundary. Tokens retain logical
    // source offsets, so copy and pointer consumers never receive glyph order.
    .map(reorderBidiTokens);
  entries = entries ?? new Map();
  // The scrollbar overlays the outer right text margin, so a frame has one
  // content width. Retain only that width; terminal resize may re-wrap once
  // rather than retaining an obsolete full transcript token graph.
  if (!entries.has(key)) entries.clear();
  entries.set(key, { rows, contentWidth: Math.max(0, ...rows.map(tokenWidth)) });
  frameTextCache?.set(node, entries);
  if (reusable) frozenTextCache.set(node, entries);
  return rows;
}

function textMeasurement(node, width) {
  const rows = textRows(node, width);
  const entries = frameTextCache?.get(node) ?? frozenTextCache.get(node);
  return { rows, contentWidth: entries?.get(`${width}:${node.overflow ?? "wrap"}`)?.contentWidth ?? Math.max(0, ...rows.map(tokenWidth)) };
}

const TABLE_GAP = 3;

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
    const { rows, contentWidth: measuredContentWidth } = textMeasurement(node, measuredWidth);
    const contentWidth = Math.min(measuredWidth, measuredContentWidth);
    return { w: Math.min(width, contentWidth + metrics.gutter + metrics.margin * 2), h: Math.min(height, rows.length) };
  }
  if (node.type === "table") {
    const metrics = textMetrics(node, width, state?.theme);
    const table = tableLayout(node, metrics.width);
    const contentWidth = table.widths.reduce((sum, value) => sum + value, 0) + TABLE_GAP * Math.max(0, table.widths.length - 1);
    return { w: Math.min(width, contentWidth + metrics.gutter + metrics.margin * 2), h: Math.min(height, table.rows.reduce((sum, row) => sum + row.height, 0)) };
  }
  if (node.type === "input" || node.type === "menu") return controlNaturalSize(node, width, height);
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
  const left = box.x + metrics.gutter + metrics.margin + Math.floor((metrics.width - tableWidth) / 2);
  let y = box.y;
  for (const row of table.rows) {
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

/**
 * The greatest SUFFIX of `children` whose summed natural height fits
 * `box.h`, newest (last) first. A transcript/feed must show the TAIL
 * of an overflowing conversation, never the head — the opposite of
 * drawSequence's top-down "row(fill)/column(fill)" behavior, which is
 * exactly right for status/menu columns but wrong here. When even the
 * single newest child alone overflows, unwrap ONE level (its own rows)
 * and recurse — a block's markdown rows are themselves a column of
 * `text` nodes, so this reaches individual rows before giving up.
 */
function bottomAnchoredSlice(children, box, state) {
  // naturalSize CLAMPS its report to the height it's given (Math.min),
  // which is exactly right for actual rendering but would make a
  // single oversized child silently "fit" here — measure UNCLAMPED
  // (a generous upper bound, not Infinity: naturalSize wraps text at
  // `width`, and an absurdly large height is a cheap, finite bound).
  let used = 0;
  let start = children.length;
  for (let i = children.length - 1; i >= 0; i--) {
    const height = naturalSize(children[i], box.w, 1e6, state).h;
    if (used + height > box.h) break;
    used += height;
    start = i;
  }
  if (start < children.length) return { items: children.slice(start), used };
  const newest = children.at(-1);
  if (newest?.children?.length) return bottomAnchoredSlice(newest.children, box, state);
  return newest ? { items: [newest], used: box.h } : { items: [], used: 0 }; // unwrappable (one oversized line): drawText's own top-clip is the last resort
}

/** A feed (the transcript): which items survive is bottom-anchored (see
 *  bottomAnchoredSlice — the newest items win); once that's decided,
 *  they render top-down from the box's own top, same as any column —
 *  an under-full feed leaves its blank space at the BOTTOM (against
 *  the input box below it), matching inline mode's native scrollback. */
function drawFeed(canvas, node, box, state) {
  const entries = node.items ?? [];
  const children = entries.map(({ node: child }) => child);
  const slice = bottomAnchoredSlice(children, box, state);
  // A single oversized entry may have been unwrapped into its nested rows.
  // Those rows still belong to the newest entry; never infer feed ownership
  // from their count (which would turn a negative index into the wrong item).
  const firstDirect = children.indexOf(slice.items[0]);
  const direct = firstDirect >= 0;
  const clip = canvas.clip ?? { y: 0, h: canvas.height };
  // A scroll gives its feed the full content height, so an item taller than
  // the physical viewport appears to fit `box` and bypasses the recursive
  // oversized path above. At the end anchor it must still become one native
  // history unit; otherwise only its clipped viewport tail is ever visible.
  const newestHeight = entries.length > 0 ? naturalSize(children.at(-1), box.w, 1e6, state).h : 0;
  const physicalOversized = direct && newestHeight > clip.h && box.y + box.h === clip.y + clip.h;
  const oversized = (!direct || physicalOversized) && entries.length > 0;
  const overflowAbove = new Map();
  const visibleOverflowRows = Math.max(0, Math.min(box.y + box.h, clip.y + clip.h) - Math.max(box.y, clip.y));
  let shown = direct && !physicalOversized
    ? entries.slice(firstDirect).map((entry) => ({ entry, node: entry.node }))
    : oversized
      ? bottomAnchoredSlice(children.at(-1)?.children ?? [], { ...box, h: visibleOverflowRows }, state).items
        .map((child) => ({ entry: entries.at(-1), node: child }))
      : [];
  let first = direct && !physicalOversized ? firstDirect : Math.max(0, entries.length - 1);
  let overflowEntry = oversized ? entries.at(-1) : null;
  let overflowRows = oversized ? visibleOverflowRows : 0;
  if (direct && !physicalOversized && firstDirect > 0) {
    const shownHeight = shown.reduce((sum, item) => sum + naturalSize(item.node, box.w, 1e6, state).h, 0);
    const room = Math.max(0, visibleOverflowRows - shownHeight);
    const previous = entries[firstDirect - 1];
    const previousHeight = naturalSize(previous.node, box.w, 1e6, state).h;
    if (room > 0 && previousHeight > room && previous.node?.children?.length) {
      const tail = bottomAnchoredSlice(previous.node.children, { ...box, h: room }, state).items;
      shown = [...tail.map((child) => ({ entry: previous, node: child })), ...shown];
      first = firstDirect - 1;
      overflowEntry = previous;
      overflowRows = room;
    }
  }
  // `evictedAbove` is a contiguous prefix only: offscreen newer items below
  // a scrolled viewport are never eligible for irreversible inline history.
  const evictedAbove = new Set(entries.slice(0, first).map((item) => item.key));
  // An uncapped oversized item moves as one whole unit into native history,
  // even while mutable; later revisions use the inline resize/rebuild path.
  // Keeping only an implicit viewport tail would permanently hide its rows.
  if (overflowEntry) {
    evictedAbove.add(overflowEntry.key);
    overflowAbove.set(overflowEntry.key, overflowRows);
  }
  // Recursive slicing can select a single text node that is itself taller
  // than the viewport. Keep that node's tail live; starting at the clip top
  // would redraw its beginning after those rows were committed to history.
  const shownNodeHeight = shown.length === 1 ? naturalSize(shown[0].node, box.w, 1e6, state).h : 0;
  const softWrappedOverflow = physicalOversized && shownNodeHeight > visibleOverflowRows;
  let cursor = softWrappedOverflow
    ? Math.max(box.y, clip.y) - (shownNodeHeight - visibleOverflowRows)
    : overflowEntry ? Math.max(box.y, clip.y) : box.y;
  // In a scroll the feed receives its full content box and only canvas.clip
  // describes the physical viewport. Add whole direct entries above that clip
  // to the prefix. An unwrapped oversized entry remains live: it cannot be
  // safely split between native history and the live canvas.
  for (const { entry, node: child } of shown) {
    const h = Math.min(naturalSize(child, box.w, box.h, state).h, box.y + box.h - cursor);
    if (h <= 0) break;
    if (direct && cursor + h <= clip.y) evictedAbove.add(entry.key);
    else if (direct && cursor < clip.y && cursor + h > clip.y) {
      evictedAbove.add(entry.key);
      overflowAbove.set(entry.key, cursor + h - clip.y);
    }
    drawNode(canvas, child, { x: box.x, y: cursor, w: box.w, h }, state);
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
    return { canvas, snapshot: semanticSnapshot(canvas), feedVisible: state.feedVisible };
  } finally { frameTextCache = previousCache; }
}

export function sceneText(scene) {
  return scene.snapshot.lines.join("\n");
}

export const layoutInternals = Object.freeze({ naturalSize, textRows, trackSizes });
