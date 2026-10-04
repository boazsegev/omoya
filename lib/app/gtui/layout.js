import { displayWidth, graphemes, graphemeWidth, wrapWordsOffsets } from "./width.js";
import { reorderBidiTokens } from "./bidi.js";
import { controlNaturalSize } from "./controls.js";

const LINE = Object.freeze({ tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" });
/** Convert a finite number to a floored integer, otherwise use the fallback.
 * @param {number} value - Candidate numeric value.
 * @param {number} [fallback=0] - Value returned when `value` is not finite.
 * @returns {number} The floored value or fallback.
 */
const integer = (value, fallback = 0) => Number.isFinite(value) ? Math.floor(value) : fallback;
/** Read a node's integer priority, defaulting invalid or absent values to zero.
 * @param {object} node - Layout node.
 * @returns {number} The floored priority.
 */
const priorityOf = (node) => integer(node?.priority, 0);
/** Create a state inheriting from the host state with an optional theme override.
 * @param {object|null|undefined} state - Host state to inherit from.
 * @param {object|null|undefined} theme - Optional theme assigned to the derived state.
 * @returns {object|null|undefined} Derived state when themed, otherwise the original state.
 */
const themedState = (state, theme) => theme ? Object.assign(Object.create(state ?? null), { theme }) : state;

/** Allocate a blank cell canvas and initialize focus, caret, targets, and put helper.
 * @param {number} width - Canvas width in cells.
 * @param {number} height - Canvas height in rows.
 * @returns {object} Mutable canvas with cells, targets, focus/caret accessors, and `put`.
 */
function createCanvas(width, height) {
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => null));
  const targets = [];
  let focus = null;
  let caret = null;
  const canvas = { width, height, cells, targets, get focus() { return focus; }, set focus(value) { focus = value; }, get caret() { return caret; }, set caret(value) { caret = value; } };
  canvas.put = (x, y, text, meta = {}) => put(canvas, x, y, text, meta);
  return canvas;
}

/** Place a glyph and metadata unless it falls outside canvas or clip bounds.
 * @param {object} canvas - Destination canvas.
 * @param {number} x - Cell column.
 * @param {number} y - Row.
 * @param {string} text - Grapheme to place.
 * @param {object} [meta={}] - Cell metadata; `cellWidth` may supply measured width.
 * @returns {number} Cells written, or zero when clipped/out of bounds.
 */
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

/** Normalize text or rich spans while inheriting node semantics and source text.
 * @param {object} node - Semantic text node.
 * @param {*} [content=node.content] - Content value or span array.
 * @returns {Array<object>} Normalized spans with text and inherited metadata.
 */
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

/** Convert normalized span content into grapheme tokens with logical source offsets.
 * @param {object} node - Semantic text node supplying inherited metadata.
 * @param {*} content - Text or rich span content.
 * @returns {Array<object>} Grapheme tokens carrying cell widths and selection/source metadata.
 */
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

/** Sum the terminal-cell widths of tokens.
 * @param {Array<object>} tokens - Grapheme tokens.
 * @returns {number} Total cell width.
 */
function tokenWidth(tokens) {
  return tokens.reduce((sum, token) => sum + (token.cellWidth ?? (graphemeWidth(token.text) || 1)), 0);
}

/** Clip tokens to a cell width, inserting an ellipsis at the discarded edge.
 * @param {Array<object>} tokens - Grapheme tokens.
 * @param {number} width - Maximum cell width.
 * @param {boolean} fromStart - If true, retain the suffix; otherwise retain the prefix.
 * @returns {Array<object>} Clipped token sequence; nonpositive widths yield an empty array.
 */
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

/** Wrap logical tokens into rows using word-wrap offsets; nonpositive width yields no rows.
 * @param {Array<object>} tokens - Grapheme tokens in logical order.
 * @param {number} width - Maximum row width in cells.
 * @returns {Array<Array<object>>} Wrapped rows.
 */
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

/** Compute text gutters, decoration width, bounded margin, and usable text width;
 * defaults keep content clear of window borders, while `margin: 0` suits chrome.
 * @param {object} node - Text-like node.
 * @param {number} width - Allocated width in cells.
 * @param {object} theme - Optional theme providing role decoration.
 * @returns {{decoration: object|undefined, gutter: number, margin: number, width: number}} Text geometry metrics.
 */
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

/** Determine whether an object graph is deeply immutable data suitable for persistent caching.
 * @param {*} value - Value to inspect.
 * @returns {boolean} True for primitives or recursively frozen data-property graphs; false otherwise.
 */
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

/** Recursively validate frozen data properties, tracking cycles and validated objects.
 * @param {*} value - Value being inspected.
 * @param {WeakSet<object>} seen - Objects already encountered in this traversal.
 * @param {Array<object>} visited - Frozen objects verified for cache marking.
 * @returns {boolean} Whether this value and its reachable data properties are safe immutable data.
 */
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

/** Get or build wrapped/ellipsized rows and content width for a node at one width.
 * Uses frame cache for mutable nodes and a persistent cache for deeply frozen
 * data; replacing the per-node entry on resize avoids retaining obsolete tokens.
 * @param {object} node - Semantic text node.
 * @param {number} width - Content width in cells.
 * @returns {{width:number, overflow:string, rows:Array<Array<object>>, contentWidth:number}} Cached layout entry.
 */
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

/** Return the cached visual rows for a text node at the requested width.
 * @param {object} node - Semantic text node.
 * @param {number} width - Content width in cells.
 * @returns {Array<Array<object>>} Visual token rows.
 */
function textRows(node, width) {
  return textEntry(node, width).rows;
}

const TABLE_GAP = 3;
/** Rows a table's optional header rule adds: one `─` line under the first
 *  row (`headerRule: <role>`) when a body follows it. */
/** Return the number of header-rule rows required by this table.
 * @param {object} node - Table node.
 * @returns {number} One when enabled and followed by a body row, otherwise zero.
 */
const tableRuleRows = (node) => (node.headerRule && (node.rows?.length ?? 0) > 1 ? 1 : 0);

/** Tokenize a table cell, composing table, heading, and span roles.
 * @param {object} node - Table node supplying inherited semantics.
 * @param {object} row - Table row.
 * @param {Array<object>|undefined} cell - Rich cell spans.
 * @returns {Array<object>} Cell grapheme tokens.
 */
function tableCellTokens(node, row, cell) {
  const cellRole = row.role === "table.head" ? "md.table.heading" : undefined;
  const content = (cell ?? []).map((span) => ({
    ...span,
    role: [node.role, cellRole, span.role].filter(Boolean).join(" "),
  }));
  return textTokens({ ...node, content }, content);
}

/** Determine table column widths and wrapped visual cell rows within available width.
 * @param {object} node - Table node.
 * @param {number} width - Available content width.
 * @returns {{widths:Array<number>, rows:Array<object>}} Column widths and wrapped rows; empty if no columns.
 */
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

/** Measure a node's natural bounded dimensions recursively without drawing it.
 * @param {object|null|undefined} node - Semantic layout node.
 * @param {number} width - Available width.
 * @param {number} height - Available height.
 * @param {object} state - Rendering state, including optional theme/control host.
 * @returns {{w:number, h:number}} Natural size clamped to available bounds; empty nodes measure zero.
 */
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
  return { w: Math.min(width, Math.max(0, ...sizes.map(({ w }) => w))), h: node.viewportFill ? height : Math.min(height, sizes.reduce((sum, size) => sum + size.h, 0)) };
}

/** Filter falsey children and retain highest-priority entries within capacity.
 * @param {Array<object>} children - Candidate nodes.
 * @param {number} capacity - Maximum count to retain.
 * @returns {Array<object>} Retained nodes in original order.
 */
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

/** Resolve fixed, auto, and fill tracks, then shrink low-priority tracks to fit.
 * @param {Array<number|string>} tracks - Track declarations (`auto`, fixed number, or fill).
 * @param {number} available - Available axis size.
 * @param {Array<number>} natural - Natural sizes corresponding to tracks.
 * @param {Array<number>} [priorities=zero per track] - Shrink priorities; ties shrink later tracks first.
 * @returns {Array<number>} Resolved nonnegative track sizes.
 */
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

/** Paint text rows, background, and optional left decoration into the canvas.
 * @param {object} canvas - Destination canvas.
 * @param {object} node - Text node.
 * @param {{x:number,y:number,w:number,h:number}} box - Allocated geometry.
 * @param {object} state - Rendering state/theme.
 * @returns {undefined} Drawing is performed by side effect.
 */
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

/** Draw a table's wrapped rows, optional header separator, and decorations.
 * @param {object} canvas - Destination canvas.
 * @param {object} node - Table node.
 * @param {{x:number,y:number,w:number,h:number}} box - Allocated geometry.
 * @param {object} state - Rendering state/theme.
 * @returns {undefined} Drawing is performed by side effect.
 */
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

/** Draw a bordered panel, optional title, and its first child.
 * @param {object} canvas - Destination canvas.
 * @param {object} node - Panel node.
 * @param {{x:number,y:number,w:number,h:number}} box - Allocated geometry.
 * @param {object} state - Rendering state/theme/control host.
 * @returns {undefined} Drawing is performed by side effect; boxes smaller than 2 cells are ignored.
 */
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

/** Draw children vertically at natural heights, optionally shifting their column.
 * @param {object} canvas - Destination canvas.
 * @param {Array<object>} children - Nodes to draw.
 * @param {Array<number>} sizes - Corresponding natural heights.
 * @param {{x:number,y:number,w:number,h:number}} box - Column viewport geometry.
 * @param {object} state - Rendering state.
 * @param {number} [offset=0] - Initial vertical offset.
 * @returns {undefined} Draws by side effect.
 */
function drawNaturalColumn(canvas, children, sizes, box, state, offset = 0) {
  let cursor = box.y + offset;
  children.forEach((child, index) => {
    drawNode(canvas, child, { x: box.x, y: cursor, w: box.w, h: sizes[index] }, state);
    cursor += sizes[index];
  });
}

/** Lay out and draw a row or column, including tail-preview and track allocation behavior.
 * @param {object} canvas - Destination canvas.
 * @param {object} node - Sequence node.
 * @param {{x:number,y:number,w:number,h:number}} box - Allocated geometry.
 * @param {object} state - Rendering state.
 * @param {"x"|"y"} axis - Sequence direction.
 * @returns {undefined} Draws children by side effect.
 */
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

/** Create a narrower clip over `canvas` that keeps the parent's put chain
 * (and therefore scroll-selection metadata) intact.
 * @param {object} canvas - Parent canvas.
 * @param {{x:number,y:number,w:number,h:number}} box - Additional clip rectangle.
 * @returns {object} Canvas view preserving parent writes and metadata behavior.
 */
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
 *  the entry straddling the visible top, how many of its rows stay visible.
 * @param {object} canvas - Destination canvas.
 * @param {object} node - Feed node with keyed items.
 * @param {{x:number,y:number,w:number,h:number}} box - Feed viewport geometry.
 * @param {object} state - Rendering state; `feedVisible` receives eviction/overflow reports.
 * @returns {undefined} Draws entries and updates feed visibility state by side effect.
 */
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

/** Allocate grid tracks and draw visible children in row-major order.
 * @param {object} canvas - Destination canvas.
 * @param {object} node - Grid node.
 * @param {{x:number,y:number,w:number,h:number}} box - Grid geometry.
 * @param {object} state - Rendering state.
 * @returns {undefined} Draws children by side effect.
 */
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

/** Create a canvas view clipped to a box and annotate writes with selection scroll metadata.
 * @param {object} canvas - Parent canvas.
 * @param {{x:number,y:number,w:number,h:number}} box - Clip rectangle.
 * @param {number} [rowOffset=0] - Offset added to selection row metadata.
 * @param {*} [scrollTarget=null] - Scroll target attached to written cells.
 * @returns {object} Clipped canvas view.
 */
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

/** Dispatch a semantic node to its renderer and update focus/caret/control state.
 * @param {object} canvas - Destination canvas.
 * @param {object|null|undefined} node - Node to render.
 * @param {{x:number,y:number,w:number,h:number}} box - Assigned geometry.
 * @param {object} state - Host rendering state and callbacks.
 * @returns {*} Result from a delegated child renderer where applicable; otherwise undefined.
 */
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

/** Build textual and semantic row ranges from rendered canvas cells.
 * @param {object} canvas - Rendered canvas.
 * @returns {{lines:Array<string>,roles:Array<object>,links:Array<object>,sources:Array<object>,focus:*,caret:*}} Snapshot of visible text and semantic metadata.
 */
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

/** Measure semantic content without allocating a terminal-sized canvas.
 * @param {object|null|undefined} root - Root semantic node.
 * @param {object} [options={}] - Measurement options.
 * @param {number} [options.width=80] - Available width, normalized to at least one cell.
 * @param {number} [options.height=4096] - Available height, normalized to at least one row.
 * @param {object} [options.controls] - Host state/control context.
 * @param {object} [options.theme] - Optional theme used for text metrics.
 * @returns {{width:number,height:number}} Measured dimensions.
 * @throws Propagates errors from node measurement or host/theme callbacks.
 */
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

/** Resolve semantic view nodes into a rendered cell canvas and host-owned geometry.
 * @param {object|null|undefined} root - Root semantic node.
 * @param {object} [options={}] - Layout options.
 * @param {number} [options.width=80] - Canvas width, normalized to at least one cell.
 * @param {number} [options.height=24] - Canvas height, normalized to at least one row.
 * @param {object} [options.controls] - Host callbacks/state; frame hooks, selection, and control rendering are invoked.
 * @param {object} [options.theme] - Optional rendering theme.
 * @param {"start"|"end"} [options.verticalAlign="start"] - Align root to top or bottom for non-overlay nodes.
 * @returns {{canvas:object,snapshot:object,feedVisible:Map}} Rendered scene; snapshot is lazily computed.
 * @throws Propagates errors from rendering and host callbacks; frame cache is restored in all cases.
 */
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

/** Return a scene's rendered lines joined with newline separators.
 * @param {object} scene - Layout scene exposing a snapshot.
 * @returns {string} Rendered text; accesses the scene snapshot (which may be lazily computed).
 */
export function sceneText(scene) {
  return scene.snapshot.lines.join("\n");
}

/** Internal layout helpers exposed for focused testing and diagnostics.
 * @type {{naturalSize: Function, textRows: Function, trackSizes: Function}}
 */
export const layoutInternals = Object.freeze({ naturalSize, textRows, trackSizes });
