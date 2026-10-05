// Host-private control state, scrolling, pointer events, and dispatch.
import { graphemeWidth } from "../width.js";
import { ALT, META, keyInfo } from "../keymap.js";
import { clamp, orderedSelection, collapsePaste, expandPastes, movedBeyondClickThreshold, clickSelection, pointInside, PASTE_COLLAPSE_THRESHOLD, PAGE_OVERLAP_ROWS, INPUT_HISTORY_LIMIT, MULTI_CLICK_MS } from "./helpers.js";
import { inputEdit, editingContext, isSingleWordInsertion, vertical, wordEnd, wordLeft, EDITING_MAP, SELECTED_EDITING_MAP, BUBBLE } from "./editing.js";
import { inputRows, visualInputRow, completionWindow, drawInput, COMPLETION_ROWS } from "./input.js";
import { filteredMenu, selectable, moveMenuSelection, drawViewportFrame, drawMenu } from "./menu.js";
import { drawToolbar } from "./toolbar.js";
/**
 * Host-private controlled input/menu/scroll/overlay mechanics.
 */
export function createControls(emit, options = {}) {
  const nodes = new Map();
  const states = new Map();
  let targets = [];
  let focused = null;
  let overlay = null;
  let keyScroll = null;
  let drag = null;
  let textSelection = null;
  let sourceSelection = null;
  let previewCells = [];
  let hoveredCells = [];
  let lastClick = null;
  let lastCanvas = null;
  let sourceItems = [];
  const stateFor = (id) => {
    if (!states.has(id)) states.set(id, {
      query: "", index: null, scroll: 0, drag: null, pastes: new Map(), pasteCounter: 0,
      undo: [], redo: [],
    });
    return states.get(id);
  };
  const register = (target) => targets.push(target);
  const scrollBar = options.scrollBar?.show === false || !options.scrollBar ? null : {
    track: options.scrollBar.track ?? "│",
    thumb: options.scrollBar.thumb ?? "█",
  };

  /**
 * Compute scrollbar track geometry when a scrollbar can fit.
 * @param {object} viewport - Scroll viewport rectangle.
 * @param {number} contentHeight - Total content rows.
 * @returns {?object} Track geometry, or null when hidden/unneeded/too small.
 */

  function scrollBarGeometry(viewport, contentHeight) {
    if (!scrollBar || contentHeight <= viewport.h || viewport.h < 3 || viewport.w < 4) return null;
    // Text has a two-cell right margin by default. Paint the bar in its
    // outermost cell instead of shrinking the viewport and changing wraps.
    return { viewport, contentHeight, trackX: viewport.x + viewport.w - 1 };
  }

  /**
 * Return the viewport unchanged; scrollbar occupies its outermost cell.
 * @param {object} node - Scrollable node (unused; retained by layout contract).
 * @param {object} viewport - Viewport rectangle.
 * @returns {object} The same viewport rectangle.
 */

  function reserveScrollBar(node, viewport) {
    return viewport;
  }

  /**
 * Render a scrollbar thumb/track and register its pointer target.
 * @param {object} canvas - Render canvas.
 * @param {object} node - Scroll node.
 * @param {object} geometry - Viewport/content/offset geometry.
 * @returns {void} Writes cells and registers a target when geometry permits.
 */

  function drawScrollBar(canvas, node, { viewport, contentHeight, maxOffset, fromTop }) {
    const frame = viewport;
    const geometry = scrollBarGeometry(frame, contentHeight);
    const trackX = geometry?.trackX;
    if (!geometry) return;
    const thumbH = clamp(Math.round((frame.h ** 2) / contentHeight), 1, frame.h);
    const position = (frame.h - thumbH) * fromTop / Math.max(1, maxOffset);
    const direction = stateFor(node.id).scrollDirection ?? 0;
    const rounded = direction > 0 ? Math.ceil(position) : direction < 0 ? Math.floor(position) : Math.round(position);
    const thumbY = frame.y + rounded;
    for (let y = frame.y; y < frame.y + frame.h; y++) {
      canvas.put(trackX, y, y >= thumbY && y < thumbY + thumbH ? scrollBar.thumb : scrollBar.track, { role: y >= thumbY && y < thumbY + thumbH ? "scroll.thumb" : "scroll.track" });
    }
    register({ kind: "scrollbar", target: node.id, box: { x: trackX, y: frame.y, w: 1, h: frame.h }, maxOffset });
  }

  /**
 * Render a control node and register its semantic targets/state.
 * @param {object} canvas - Render canvas.
 * @param {object} node - Control node.
 * @param {object} box - Layout rectangle.
 * @returns {void|object} Draw result for scroll controls, otherwise undefined; mutates manager state and canvas.
 */

  function drawControl(canvas, node, box) {
    // An id-less toolbar still draws; it just cannot hold focus or route clicks.
    if (node.type === "toolbar" && !node.id) return drawToolbar(canvas, node, box, {}, () => {});
    if (!node.id) return;
    nodes.set(node.id, { node, box });
    if (node.focus) focused = node.id;
    if (node.type === "toolbar") return drawToolbar(canvas, node, box, stateFor(node.id), register);
    if (node.action) {
      register({ kind: "action", target: node.id, action: node.action, box });
      return;
    }
    if (node.type === "input") {
      const state = stateFor(node.id);
      const value = String(node.value ?? "");
      for (const placeholder of state.pastes.keys()) if (!value.includes(placeholder)) state.pastes.delete(placeholder);
      // Whole-box WHEEL target: drawInput registers one caret target per
      // TEXT row, but border rows have no target. Route wheel movement
      // there to the input's viewport (or the transcript when it fits).
      // wheel-only (never a caret press: it carries
      // no text-row geometry), and registered FIRST so the per-row caret and
      // completion targets still win under resolvePoint's reverse-order search.
      register({ kind: "input", wheelOnly: true, target: node.id, box });
      return drawInput(canvas, node, box, register, state);
    }
    if (node.type === "menu") return drawMenu(canvas, node, box, stateFor(node.id), register);
    if (node.type === "scroll") {
      const state = stateFor(node.id);
      const external = Math.max(0, Number(node.offset ?? 0) || 0);
      state.externalChanged = state.externalScroll !== external;
      if (state.externalChanged) {
        state.externalScroll = external;
        state.scroll = external;
      }
      const viewport = node.title || node.footer
        ? drawViewportFrame(canvas, box, { title: node.title ?? "", footer: node.footer ?? "" })
        : box;
      // Key scrolling uses the actual content viewport, never the outer
      // title/footer frame. A non-focused transcript may opt into Page
      // Up/Down while the editor keeps normal typing and arrow ownership.
      nodes.set(node.id, { node, box: viewport });
      if (node.keyboard === true) keyScroll = node.id;
      register({ kind: "scroll", target: node.id, box: viewport });
      return viewport;
    }
  }

  /**
 * Reset per-frame node, target, focus, overlay, and keyboard-scroll registrations.
 * @returns {void} Mutates control manager state.
 */

  function beginFrame() {
    nodes.clear();
    targets = [];
    focused = null;
    overlay = null;
    keyScroll = null;
  }

  /**
 * Synchronize a scroll node offset with current content and viewport heights.
 * @param {object} node - Scroll node, optionally end-anchored.
 * @param {number} contentHeight - Current content rows.
 * @param {number} viewportHeight - Visible rows.
 * @returns {number} Clamped scroll offset; updates per-node scroll state.
 */

  function syncScroll(node, contentHeight, viewportHeight) {
    const state = stateFor(node.id);
    const maxOffset = Math.max(0, contentHeight - viewportHeight);
    // An end-anchored viewport at offset 0 follows new output. Once the
    // user scrolls away, grow the distance from the end by the same amount
    // as the content so the visible historical rows stay put while tokens stream.
    if (node.anchor === "end" && !state.externalChanged && state.scroll > 0 && Number.isFinite(state.maxOffset) && maxOffset > state.maxOffset) {
      state.scroll += maxOffset - state.maxOffset;
    }
    state.scroll = clamp(state.scroll, 0, maxOffset);
    state.maxOffset = maxOffset;
    state.externalChanged = false;
    return state.scroll;
  }

  /**
 * Convert a screen point to canvas coordinates with logical selection-row mapping.
 * @param {object} canvas - Canvas with dimensions and cell metadata.
 * @param {object} point - Point; already-logical points pass through.
 * @returns {object} Logical point; screen coordinates are floored and clamped.
 */

  function canvasPoint(canvas, point) {
    if (point?.logical === true) return point;
    const x = clamp(Math.floor(point.x), 0, Math.max(0, canvas.width - 1));
    const y = clamp(Math.floor(point.y), 0, Math.max(0, canvas.height - 1));
    const cell = canvas.cells[y]?.[x];
    return { x, y: Number.isFinite(cell?.selectionRow) ? cell.selectionRow : y, logical: true };
  }

  /**
 * Get ordered linear canvas-cell bounds for the current text selection.
 * @param {object} canvas - Canvas dimensions used to linearize endpoints.
 * @returns {?{start:number,end:number}} Inclusive selection bounds, or null without selection.
 */

  function selectionBounds(canvas) {
    if (!textSelection) return null;
    const anchor = canvasPoint(canvas, textSelection.anchor);
    const caret = canvasPoint(canvas, textSelection.caret);
    const ai = anchor.y * canvas.width + anchor.x;
    const ci = caret.y * canvas.width + caret.x;
    return ai <= ci ? { start: ai, end: ci } : { start: ci, end: ai };
  }

  /**
 * Find a rendered cell corresponding to a source-text offset.
 * @param {string} target - Selection/source key.
 * @param {number} offset - Source text offset.
 * @param {object} fallback - Point returned when no rendered cell matches.
 * @param {boolean} [preferEnd=false] - Match a cell ending at the offset rather than starting there.
 * @returns {object} Screen point or fallback.
 */

  function pointForSource(target, offset, fallback, preferEnd = false) {
    for (let y = 0; y < (lastCanvas?.height ?? 0); y++) for (let x = 0; x < (lastCanvas?.width ?? 0); x++) {
      const cell = lastCanvas.cells[y][x];
      if (cell?.selectionKey !== target || !cell.source) continue;
      if ((!preferEnd && cell.source.start <= offset && offset < cell.source.end) ||
          (preferEnd && cell.source.start < offset && offset <= cell.source.end)) return { x, y };
    }
    return fallback;
  }

  /**
 * Resolve the nearest rendered source-text anchor at a canvas point.
 * @param {object} canvas - Canvas to inspect.
 * @param {object} point - Screen point.
 * @returns {?object} Selection key and source start/end offsets, or null if row has no text.
 */

  function sourceAnchor(canvas, point) {
    if (!canvas) return null;
    const x = clamp(Math.floor(point.x), 0, Math.max(0, canvas.width - 1));
    const y = clamp(Math.floor(point.y), 0, Math.max(0, canvas.height - 1));
    const row = canvas.cells[y] ?? [];
    let cell = row[x];
    if (!cell?.selectionKey || !cell.source || cell.text === null) {
      // Clamp into text on THIS row only; an empty row must not inherit
      // the source anchor of the preceding or following visible item.
      cell = null;
      for (let index = x <= 0 ? 0 : row.length - 1; index >= 0 && index < row.length; index += x <= 0 ? 1 : -1) {
        const candidate = row[index];
        if (candidate?.selectionKey && candidate.source && candidate.text !== null) { cell = candidate; break; }
      }
    }
    if (!cell) return null;
    return { key: cell.selectionKey, start: cell.source.start, end: cell.source.end };
  }

  /**
 * Build source-offset ranges from the active drag/selection endpoints.
 * @returns {?Map<string,{start:number,end:number}>} Per-source-item ranges, or null for invalid endpoints.
 */

  function captureSourceSelection() {
    const anchor = drag?.sourceAnchor ?? textSelection?.sourceAnchor;
    const caret = drag?.sourceCaret ?? textSelection?.sourceCaret;
    if (!anchor || !caret) return null;
    const anchorIndex = sourceItems.findIndex(({ key }) => key === anchor.key);
    const caretIndex = sourceItems.findIndex(({ key }) => key === caret.key);
    if (anchorIndex < 0 || caretIndex < 0) return null;
    const forward = anchorIndex < caretIndex || (anchorIndex === caretIndex && anchor.start <= caret.start);
    const firstIndex = forward ? anchorIndex : caretIndex;
    const lastIndex = forward ? caretIndex : anchorIndex;
    const isSingleItem = firstIndex === lastIndex;
    const firstOffset = isSingleItem ? (forward ? anchor.start : caret.start) : 0;
    const lastOffset = isSingleItem ? (forward ? caret.end : anchor.end) : sourceItems[lastIndex].text.length;
    return new Map(sourceItems.slice(firstIndex, lastIndex + 1).map((item, index, items) => [item.key, {
      start: index === 0 ? firstOffset : 0,
      end: index === items.length - 1 ? lastOffset : item.text.length,
    }]));
  }

  /**
 * Apply text-selection preview or committed selection styling to canvas cells.
 * @param {object} canvas - Canvas whose cell roles are updated.
 * @returns {void} Mutates cell roles and preview bookkeeping.
 */

  function applySelection(canvas) {
    // During an active drag, preview directly from screen coordinates. Do not
    // resolve source ranges or selected content until release.
    if (drag?.kind === "text") {
      for (const cell of previewCells) cell.role = cell.selectionBaseRole;
      previewCells = [];
      const range = selectionBounds(canvas);
      if (!range) return;
      // Visit only visible rows intersecting the logical selection. The
      // selectionRow metadata translates viewport cells to content rows in
      // O(1), including a scrolled viewport; no source/text resolution occurs.
      for (let y = 0; y < canvas.height; y++) {
        const cells = canvas.cells[y];
        for (let x = 0; x < canvas.width; x++) {
          const cell = cells[x];
          if (!cell?.selectionKey || !cell?.source || cell.text === null) continue;
          const index = (Number.isFinite(cell.selectionRow) ? cell.selectionRow : y) * canvas.width + x;
          if (index < range.start || index > range.end) continue;
          cell.selectionBaseRole ??= cell.role;
          cell.role = `${cell.selectionBaseRole ?? "text"} selection`;
          previewCells.push(cell);
        }
      }
      return;
    }
    if (!sourceSelection) return;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const cell = canvas.cells[y][x];
        const range = cell?.selectionKey ? sourceSelection.get(cell.selectionKey) : null;
        if (!range || !cell?.source || cell.text === null || cell.source.end <= range.start || cell.source.start >= range.end) continue;
        cell.role = `${cell.role ?? "text"} selection`;
      }
    }
  }

  /**
 * Collect text covered by the current source selection.
 * @returns {string} Selected slices joined by newlines, or empty when no selection.
 */

  function selectedSourceText() {
    if (!sourceSelection) return "";
    return sourceItems.flatMap((item) => {
      const range = sourceSelection.get(item.key);
      return range ? [item.text.slice(range.start, range.end)] : [];
    }).join("\n");
  }

  /**
 * Finalize rendered source items and discard state for unmounted controls.
 * @param {object} root - Render tree root traversed for selection sources and overlays.
 * @param {object} canvas - Completed canvas used to recover source text metadata.
 * @returns {void} Mutates source and mounted-state bookkeeping.
 */

  function endFrame(root, canvas) {
    lastCanvas = canvas;
    sourceItems = [];
    const visit = (node, inOverlay = false) => {
      if (!node) return;
      if (node.type === "overlay") { overlay = node.id ?? true; inOverlay = true; }
      if (inOverlay && node.focus) focused = node.id;
      if (node.selectionKey) {
        const text = typeof node.sourceText === "string"
          ? node.sourceText
          : (node.children ?? []).map((child) => typeof child === "string" ? child : String(child?.text ?? "")).join("");
        sourceItems.push({ key: node.selectionKey, text });
      }
      for (const child of node.children ?? []) visit(child, inOverlay);
    };
    visit(root);
    const byKey = new Map(sourceItems.map((item) => [item.key, item]));
    // A text node can leave its source on rendered cells rather than its
    // view node. Fill those gaps in one visible-canvas pass, preserving view order.
    for (const row of canvas.cells) for (const cell of row) {
      if (!cell?.selectionKey) continue;
      let item = byKey.get(cell.selectionKey);
      if (!item) {
        item = { key: cell.selectionKey, text: "" };
        sourceItems.push(item);
        byKey.set(item.key, item);
      }
      if (item.text === "" && typeof cell.sourceText === "string") item.text = cell.sourceText;
    }
    // Control state belongs to a mounted node. Dropping it here makes a
    // closed/reopened menu start fresh instead of resurrecting an old
    // filter or selection; scroll controls get the same lifecycle.
    for (const id of states.keys()) if (!nodes.has(id)) states.delete(id);
  }

  /**
 * Emit an input submit or change event for an edit.
 * @param {object} node - Input node providing its id.
 * @param {object} edit - Edit result, including value and optional submit flag.
 * @returns {void} Calls emit with input.submit or input.change.
 */

  function sendInput(node, edit) {
    if (edit.submit) emit({ type: "input.submit", id: node.id, value: edit.value });
    else emit({ type: "input.change", id: node.id, ...edit });
  }

  /**
 * Restore the latest undo/redo snapshot and save the current state to the opposite stack.
 * @param {object} node - Input node.
 * @param {object} state - Mutable undo/redo stacks.
 * @param {string} direction - "undo" selects undo; other values select redo.
 * @returns {boolean} Always true; emits a restored input change when a snapshot exists.
 */

  function restoreInput(node, state, direction) {
    const source = direction === "undo" ? state.undo : state.redo;
    if (source.length === 0) return true;
    const destination = direction === "undo" ? state.redo : state.undo;
    destination.push(editingContext(node));
    if (destination.length > INPUT_HISTORY_LIMIT) destination.shift();
    sendInput(node, source.pop());
    return true;
  }

  /**
 * Record an undo boundary for a changed input and clear redo history.
 * @param {object} node - Input node before the edit.
 * @param {object} state - Mutable undo/redo stacks.
 * @param {object} edit - Candidate edit.
 * @returns {void} Mutates history only when value changes.
 */

  function recordInputChange(node, state, edit) {
    const previous = String(node.value ?? "");
    if (edit.value === previous) return;
    // Retain the initial state of a run, then let consecutive single
    // non-whitespace insertions share it. Undo restores the whole word while whitespace and
    // every other edit retain a separate boundary.
    if (state.undo.length === 0 || !isSingleWordInsertion(previous, edit.value)) {
      state.undo.push(editingContext(node));
      if (state.undo.length > INPUT_HISTORY_LIMIT) state.undo.shift();
    }
    state.redo.length = 0;
  }

  /**
 * Roving focus inside a focused toolbar (one tab stop, arrows within):
 * ←/→ and Tab/Shift+Tab wrap, Home/End jump, Enter/Space activate. Any
 * other key bubbles to the app — leaving the toolbar is app policy.
 */
  function handleToolbar(node, state, message) {
    const items = state.items ?? [];
    if (message.type !== "key" || items.length === 0) return false;
    const index = Math.max(0, items.findIndex((item) => item.key === state.key));
    const step = { left: -1, "shift+tab": -1, right: 1, tab: 1 }[message.key];
    const next = step !== undefined ? (index + step + items.length) % items.length
      : message.key === "home" ? 0 : message.key === "end" ? items.length - 1 : null;
    if (next !== null) {
      state.key = items[next].key;
      emit({ type: "toolbar.change", id: node.id, key: state.key, action: items[next].button.action });
      return true;
    }
    if (message.key === "enter" || message.key === "space") {
      const { button } = items[index];
      if (button.action) emit({ type: "action.select", id: button.id ?? node.id, action: button.action });
      return true;
    }
    return false;
  }

  /**
 * Handle menu navigation, filtering, submit/select, and cancellation messages.
 * @param {object} node - Menu node and policy.
 * @param {object} state - Mutable menu state.
 * @param {object} message - Incoming message.
 * @returns {boolean} Whether handled or claimed by an overlay; may emit menu events.
 */

  function handleMenu(node, state, message) {
    const list = filteredMenu(state, node);
    const filtering = node.filter !== false;
    // Escape is an unconditional modal exit. Backspace owns filter editing;
    // requiring a first Escape to clear a query made menus feel trapped and
    // diverged from every other overlay's one-key dismissal contract.
    if (message.type === "key" && (message.key === "escape" || message.key === "ctrl+c" || (message.key === "q" && (!filtering || state.query === "")))) { emit({ type: "menu.cancel", id: node.id }); return true; }
    if (message.type === "key" && message.key === "enter" && node.submitOnEnter === true) { emit({ type: "menu.submit", id: node.id, item: selectable(list[state.index]) ? list[state.index] : undefined }); return true; }
    if (message.type === "key" && message.key === "enter" && selectable(list[state.index])) { emit({ type: "menu.select", id: node.id, item: list[state.index], itemId: list[state.index].id }); return true; }
    if (message.type === "key" && message.key === "space" && node.selectOnSpace === true && selectable(list[state.index])) { emit({ type: "menu.select", id: node.id, item: list[state.index], itemId: list[state.index].id }); return true; }
    const changed = () => {
      const current = filteredMenu(state, node);
      emit({ type: "menu.change", id: node.id, item: selectable(current[state.index]) ? current[state.index] : undefined });
    };
    if (message.type === "key" && (message.key === "up" || message.key === "down")) { moveMenuSelection(state, list, message.key === "up" ? -1 : 1); changed(); return true; }
    if (filtering && message.type === "key" && message.key === "backspace") { state.query = [...state.query].slice(0, -1).join(""); state.index = null; changed(); return true; }
    if (filtering && message.type === "key" && typeof message.text === "string") { state.query += message.text; state.index = null; changed(); return true; }
    if (!filtering && node.bubbleText === true && message.type === "key" && typeof message.text === "string") return false;
    return overlay !== null;
  }

  /**
 * Map a scrollbar pointer y-coordinate to its scroll offset.
 * @param {object} target - Registered scrollbar target with geometry and maxOffset.
 * @param {number} y - Pointer y-coordinate.
 * @returns {boolean} False if the scroll node is missing; otherwise true and emits on change.
 */

  function setScrollFromBar(target, y) {
    const entry = nodes.get(target.target);
    if (!entry) return false;
    const state = stateFor(entry.node.id);
    const row = clamp(Math.floor(y) - target.box.y, 0, target.box.h - 1);
    const fromTop = Math.round(row * target.maxOffset / Math.max(1, target.box.h - 1));
    const next = entry.node.anchor === "end" ? target.maxOffset - fromTop : fromTop;
    if (next !== state.scroll) {
      state.scroll = next;
      emit({ type: "scroll.change", id: entry.node.id, offset: next });
    }
    return true;
  }

  /**
 * Handle pointer movement, presses, dragging, wheel input, and text selection.
 * @param {object} message - Pointer event including kind, target, coordinates, and optional control metadata.
 * @returns {boolean} Whether the pointer event was handled; may mutate canvas/state and emit control events.
 */

  function handlePointer(message) {
    if (message.kind === "move") {
      for (const cell of hoveredCells) cell.role = cell.hoverBaseRole;
      hoveredCells = [];
      const cell = lastCanvas?.cells?.[Math.floor(message.y)]?.[Math.floor(message.x)];
      // A link or a toolbar button highlights as ONE unit: every cell
      // sharing its url / button key takes the matching hover layer.
      const field = typeof cell?.link === "string" && cell.link !== "" ? "link"
        : typeof cell?.hover === "string" && cell.hover !== "" ? "hover" : null;
      if (field) {
        const layer = field === "link" ? "link.hover" : "button.hover";
        for (const row of lastCanvas.cells) for (const candidate of row) {
          if (candidate?.[field] !== cell[field]) continue;
          candidate.hoverBaseRole ??= candidate.role;
          candidate.role = `${candidate.hoverBaseRole ?? "text"} ${layer}`;
          hoveredCells.push(candidate);
        }
      }
      return true;
    }
    if ((message.kind === "drag" || message.kind === "release") && drag?.kind === "scrollbar") {
      const handled = setScrollFromBar(drag.target, message.y);
      if (message.kind === "release") drag = null;
      return handled;
    }
    if (message.kind === "press" && message.button === 0 && message.control === "scrollbar") {
      const target = [...targets].reverse().find((candidate) => candidate.kind === "scrollbar" && candidate.target === message.target);
      if (!target) return false;
      drag = { kind: "scrollbar", target };
      return setScrollFromBar(target, message.y);
    }
    if (message.kind === "wheel") {
      // Overflowing inputs own wheel movement within their visible text
      // window. Short inputs fall back to the keyboard transcript; menus
      // and scroll containers under the pointer take precedence.
      const pointed = nodes.get(message.target ?? focused);
      if (pointed?.node.type === "input") {
        const state = stateFor(pointed.node.id);
        const layout = inputRows(pointed.node, pointed.box.w);
        const visible = state.inputRows ?? 1;
        const maxStart = Math.max(0, layout.rows.length - visible);
        if (maxStart > 0) {
          const delta = (message.direction === "up" ? -1 : 1) * (Number.isFinite(message.amount) ? Math.abs(message.amount) : 1);
          state.inputWheel = (state.inputWheel ?? 0) + delta;
          const rows = Math.trunc(state.inputWheel);
          state.inputWheel -= rows;
          const next = clamp((state.inputStart ?? 0) + rows, 0, maxStart);
          if (next !== state.inputStart) {
            state.inputStart = next;
            emit({ type: "input.scroll", id: pointed.node.id });
          }
          return true;
        }
      }
      const entry = pointed?.node.type === "menu" || pointed?.node.type === "scroll"
        ? pointed
        : nodes.get(keyScroll);
      if (!entry || (entry.node.type !== "menu" && entry.node.type !== "scroll")) return false;
      const state = stateFor(entry.node.id);
      if (entry.node.type === "menu") {
        const list = filteredMenu(state, entry.node);
        moveMenuSelection(state, list, message.direction === "up" ? -1 : 1);
        emit({ type: "menu.change", id: entry.node.id, item: selectable(list[state.index]) ? list[state.index] : undefined });
      } else {
        const towardStart = message.direction === "up";
        const physical = Number.isFinite(message.amount) ? Math.abs(message.amount) : 1;
        const signed = towardStart ? -physical : physical;
        const delta = entry.node.anchor === "end" ? -signed : signed;
        state.scrollAccumulator = (state.scrollAccumulator ?? 0) + delta;
        const rows = Math.trunc(state.scrollAccumulator);
        if (rows !== 0) {
          state.scrollAccumulator = 0;
          const next = clamp(state.scroll + rows, 0, state.maxOffset ?? Infinity);
          if (next !== state.scroll) {
            state.scrollDirection = Math.sign(entry.node.anchor === "end" ? -rows : rows);
            state.scroll = next;
            emit({ type: "scroll.change", id: entry.node.id, offset: state.scroll });
          }
        }
      }
      return true;
    }

    if ((message.kind === "drag" || message.kind === "release") && drag?.kind === "text") {
      const moved = !drag.multiClick || drag.moved || movedBeyondClickThreshold(drag, message);
      if (!moved) {
        if (message.kind === "release") drag = null;
        return true;
      }
      let endpoint = { x: message.x, y: message.y };
      if (drag.wordMode && Number.isInteger(message.index) && typeof message.sourceText === "string") {
        const word = clickSelection(message.sourceText, message.index, 2);
        if (word) endpoint = pointForSource(message.target, word.caret, endpoint, true);
      }
      // Convert the current screen endpoint immediately. Both endpoints then
      // live in scroll-content coordinates; later frames must never reinterpret
      // the original screen row against a newly scrolled canvas.
      const sourceCaret = sourceAnchor(lastCanvas, endpoint);
      textSelection = { ...textSelection, caret: canvasPoint(lastCanvas, endpoint), sourceCaret: sourceCaret ?? textSelection.sourceCaret };
      drag.sourceCaret = sourceCaret ?? drag.sourceCaret;
      const canvas = lastCanvas;
      const pointerY = clamp(Math.floor(message.y), 0, Math.max(0, (canvas?.height ?? 1) - 1));
      const scrollId = drag.scrollTarget ?? canvas?.cells?.[pointerY]?.find((cell) => cell?.selectionScroll)?.selectionScroll;
      const scroll = scrollId ? nodes.get(scrollId) : null;
      if (message.kind === "drag" && scroll) {
        const top = scroll.box.y;
        const bottom = scroll.box.y + scroll.box.h - 1;
        const previousY = Math.floor(drag.pointerY ?? message.y);
        const direction = pointerY < previousY ? -1 : pointerY > previousY ? 1 : 0;
        drag.pointerY = pointerY;
        // Entering the four-row zone merely arms it. Scroll only on a later
        // real mouse report moving another row outward. The physical first/
        // last terminal row is never an activation point.
        const inTopZone = pointerY > top && pointerY < top + 4;
        const inBottomZone = pointerY < bottom && pointerY > bottom - 4;
        const outward = (inTopZone && direction < 0) || (inBottomZone && direction > 0);
        const armed = drag.edgeZone === (inTopZone ? "top" : inBottomZone ? "bottom" : null);
        drag.edgeZone = inTopZone ? "top" : inBottomZone ? "bottom" : null;
        if (outward && armed) {
          const desired = inTopZone ? top + 4 : bottom - 4;
          const amount = Math.abs(desired - pointerY);
          const signed = inTopZone ? -amount : amount;
          const state = stateFor(scroll.node.id);
          const delta = scroll.node.anchor === "end" ? -signed : signed;
          const next = clamp(state.scroll + delta, 0, state.maxOffset ?? Infinity);
          if (next !== state.scroll) {
            const actual = scroll.node.anchor === "end" ? state.scroll - next : next - state.scroll;
            state.scroll = next;
            textSelection.caret = { ...textSelection.caret, y: textSelection.caret.y + actual, logical: true };
            emit({ type: "scroll.change", id: scroll.node.id, offset: state.scroll });
          }
        }
      }
      // Mouse motion can arrive hundreds of times per second. Preview only
      // after the endpoint has moved more than 0.75 of a terminal cell since
      // the last preview; this keeps feedback responsive without resolving
      // source text/ranges or repainting for every raw motion report.
      if (message.kind === "drag") {
        const previous = drag.previewAt ?? drag.origin;
        const nextCell = { x: Math.floor(message.x), y: Math.floor(message.y) };
        const previousCell = { x: Math.floor(previous.x), y: Math.floor(previous.y) };
        drag = { ...drag, moved };
        if (nextCell.x === previousCell.x && nextCell.y === previousCell.y) return true;
        drag.previewAt = { x: message.x, y: message.y };
        sourceSelection = null;
        emit({ type: "selection.preview" });
        return true;
      }
      sourceSelection = captureSourceSelection();
      drag = null;
      emit({ type: "selection.change", text: selectedSourceText() });
      return true;
    }
    if ((message.kind === "drag" || message.kind === "release") && drag?.kind === "input") {
      const entry = nodes.get(drag.target);
      if (!entry) { drag = null; return false; }
      // Terminals can report a drag/release at (or one cell beside) the
      // multi-click. Keep its word/line selection intact until a genuine
      // post-click movement starts; otherwise that trailing report shrinks
      // it to the pointer's index.
      const moved = !drag.multiClick || drag.moved || movedBeyondClickThreshold(drag, message);
      if (!moved) {
        if (message.kind === "release") drag = null;
        return true;
      }
      const value = String(entry.node.value ?? "");
      // A drag that leaves the input's glyphs reports no index; hold the
      // last resolved position instead of leaping to the value's end.
      const rawCaret = clamp(Number.isInteger(message.index) ? message.index : drag.caret ?? value.length, 0, value.length);
      // Pointer reports within the same terminal cell carry no new editor
      // information. Suppress the app update/layout entirely.
      if (message.kind === "drag" && rawCaret === drag.rawCaret) return true;
      let anchor = drag.anchor;
      let caret = rawCaret;
      if (drag.wordMode) {
        if (rawCaret >= drag.wordStart) { anchor = drag.wordStart; caret = wordEnd(value, rawCaret); }
        else { anchor = drag.wordEnd; caret = wordLeft(value, rawCaret); }
      }
      drag = { ...drag, rawCaret, caret, selection: { anchor, caret }, moved };
      if (message.kind === "drag") {
        // Preview input selection on the mounted canvas too; the controlled
        // value/caret update is committed once on release.
        for (const cell of previewCells) cell.role = cell.selectionBaseRole;
        previewCells = [];
        const ordered = orderedSelection(drag.selection);
        if (ordered) for (const row of lastCanvas?.cells ?? []) for (const cell of row) {
          if (!Number.isInteger(cell?.inputIndex) || cell.inputIndex < ordered.start || cell.inputIndex >= ordered.end) continue;
          cell.selectionBaseRole ??= cell.role;
          cell.role = "input.selection";
          previewCells.push(cell);
        }
        emit({ type: "selection.preview" });
        return true;
      }
      sendInput(entry.node, { value, caret, selection: drag.selection });
      drag = null;
      return true;
    }

    const target = message.target ? targets.find((candidate) => candidate.target === message.target
      && (message.control === undefined || candidate.kind === message.control)
      && (message.index === undefined || candidate.index === message.index)) : null;
    if (message.kind === "press" && target?.kind === "action") {
      emit({ type: "action.select", id: target.target, action: target.action });
      return true;
    }
    if (message.kind === "press" && target?.kind === "completion") {
      emit({ type: "input.change", id: target.target, completion: target.item, completionIndex: target.index });
      return true;
    }
    if (message.kind === "move" && target?.kind === "menu.item" && selectable(target.item)) {
      const entry = nodes.get(target.target);
      if (!entry) return false;
      const state = stateFor(entry.node.id);
      state.index = target.index;
      emit({ type: "menu.change", id: target.target, item: target.item });
      return true;
    }
    if (message.kind === "press" && target?.kind === "menu.item" && selectable(target.item)) {
      emit({ type: "menu.select", id: target.target, item: target.item, itemId: target.item.id });
      return true;
    }
    if (message.kind === "press" && message.control === "action" && message.button === 0 && typeof message.action === "string" && message.action !== "") {
      emit({ type: "action.select", action: message.action });
      return true;
    }
    if (message.kind === "press" && message.control === "link" && message.button === 0 && typeof message.link === "string" && message.link !== "") {
      emit({ type: "link.open", url: message.link });
      return true;
    }
    if (message.kind === "press" && message.control === "text" && message.button === 0) {
      const now = Date.now();
      const repeated = lastClick?.target === message.target && lastClick?.index === message.index && now - (lastClick?.at ?? 0) <= MULTI_CLICK_MS;
      const count = repeated ? Math.min(3, lastClick.count + 1) : 1;
      lastClick = { target: message.target, index: message.index, at: now, count };
      const source = String(message.sourceText ?? "");
      const selected = clickSelection(source, message.index ?? 0, count);
      const fallback = { x: message.x, y: message.y };
      const anchor = selected ? pointForSource(message.target, selected.anchor, fallback) : fallback;
      const caret = selected ? pointForSource(message.target, selected.caret, fallback, true) : fallback;
      const scrollTarget = lastCanvas?.cells?.[Math.floor(message.y)]?.[Math.floor(message.x)]?.selectionScroll
        ?? [...nodes.entries()].find(([, entry]) => entry.node.type === "scroll" && pointInside(message, entry.box))?.[0];
      const sourceAnchorPoint = sourceAnchor(lastCanvas, anchor);
      const sourceCaretPoint = sourceAnchor(lastCanvas, caret);
      drag = { kind: "text", multiClick: selected !== null, wordMode: count === 2, scrollTarget, origin: fallback,
        sourceAnchor: sourceAnchorPoint, sourceCaret: sourceCaretPoint };
      textSelection = { anchor: canvasPoint(lastCanvas, anchor), caret: canvasPoint(lastCanvas, caret),
        sourceAnchor: sourceAnchorPoint, sourceCaret: sourceCaretPoint };
      sourceSelection = captureSourceSelection();
      emit({ type: "selection.change", text: selectedSourceText() });
      return true;
    }
    if (message.kind === "press" && message.target && Number.isInteger(message.index)) {
      const entry = nodes.get(message.target);
      if (entry?.node.type === "input") {
        const value = String(entry.node.value ?? "");
        const caret = clamp(message.index, 0, value.length);
        const now = Date.now();
        const repeated = message.button === 0 && lastClick?.target === entry.node.id
          && lastClick.index === caret && now - lastClick.at <= MULTI_CLICK_MS;
        const count = repeated ? Math.min(3, lastClick.count + 1) : 1;
        lastClick = message.button === 0 ? { target: entry.node.id, index: caret, at: now, count } : null;
        const selection = clickSelection(value, caret, count);
        drag = message.button === 0 ? {
          kind: "input", target: entry.node.id, anchor: selection?.anchor ?? caret, caret: selection?.caret ?? caret,
          rawCaret: caret, index: caret, multiClick: selection !== null, wordMode: count === 2,
          wordStart: selection?.anchor ?? caret, wordEnd: selection?.caret ?? caret,
          origin: { x: message.x, y: message.y }, moved: false,
        } : null;
        // An input caret gesture owns selection now: a still-mounted mouse
        // text selection is dead, and clearing it repaints the highlight.
        if (textSelection) { textSelection = null; sourceSelection = null; emit({ type: "selection.change", text: "" }); }
        sendInput(entry.node, { value, caret: selection?.caret ?? caret, selection });
        return true;
      }
    }
    if (message.kind === "press" && textSelection) {
      textSelection = null;
      sourceSelection = null;
      drag = null;
      emit({ type: "selection.change", text: "" });
      return true;
    }
    return false;
  }

  /**
 * Handle keyboard scrolling for a scroll control.
 * @param {?object} entry - Registered node/viewport pair.
 * @param {object} message - Incoming key message.
 * @param {boolean} [fallback=false] - Whether scrolling is fallback from a focused input.
 * @returns {boolean} Whether the key was consumed; handled movement emits scroll.change.
 */

  function handleScroll(entry, message, fallback = false) {
    if (!entry || entry.node.type !== "scroll" || message.type !== "key") return false;
    const { node, box } = entry;
    const info = keyInfo(message);
    if (!info) return false;
    const page = Math.max(1, box.h - Math.min(PAGE_OVERLAP_ROWS, Math.max(0, box.h - 1)));
    const lineSteps = { up: -1, down: 1 };
    const pageSteps = { pageup: -page, pagedown: page, b: -page, space: page };
    let amount = null;
    // A focused input owns plain Up/Down (caret/history). As its scroll
    // fallback it accepts Page Up/Down and the modified vertical-scroll
    // keys it never claims: Alt+Up/Down (line) and Alt+Meta+Up/Down
    // (Alt wins over Meta). Meta+Up/Down stay the input's whole-value
    // caret jump, so this fallback never sees them.
    if (info.modifiers === 0) {
      if (fallback && (info.code === "up" || info.code === "down")) return false;
      amount = lineSteps[info.code] ?? pageSteps[info.code] ?? null;
    }
    else if (info.modifiers === ALT) amount = lineSteps[info.code] ?? null;
    else if (info.modifiers === (ALT | META)) amount = lineSteps[info.code] ?? null;
    if (amount === null) return false;
    const delta = node.anchor === "end" ? -amount : amount;
    const state = stateFor(node.id);
    state.scrollDirection = Math.sign(amount);
    state.scrollAccumulator = 0;
    // Content may have grown since the last layout (streaming); clamp only
    // at zero here and let syncScroll clamp to the fresh maxOffset.
    state.scroll = Math.max(0, state.scroll + delta);
    emit({ type: "scroll.change", id: node.id, offset: state.scroll });
    return true;
  }

  /**
 * Dispatch a host message to focused controls or pointer handling.
 * @param {object} message - Key, paste, or pointer message.
 * @returns {boolean} Whether handled/claimed by an overlay; may emit input, menu, selection, action, link, or scroll events.
 */

  function handle(message) {
    if (message.type === "pointer") return handlePointer(message);
    // One primed selection, whatever the gesture: a mouse text selection
    // claims Copy only when it actually yields source text; otherwise the
    // focused input's own keyboard/mouse selection handles it below, so
    // the two never behave as separate selections.
    if (message.type === "key" && message.key === "copy" && textSelection) {
      const text = selectedSourceText();
      if (text !== "") {
        emit({ type: "selection.copy", text });
        return true;
      }
    }
    const entry = nodes.get(focused);
    if (!entry) return overlay !== null;
    const { node, box } = entry;
    if (node.type === "input") {
      const state = stateFor(node.id);
      if (message.type === "key" && ["ctrl+z", "meta+z"].includes(message.key)) return restoreInput(node, state, "undo");
      if (message.type === "key" && ["ctrl+shift+z", "meta+shift+z"].includes(message.key)) return restoreInput(node, state, "redo");
      const pasted = message.type === "paste"
        ? (typeof node.pasteTransform === "function" ? node.pasteTransform(String(message.text ?? "")) : String(message.text ?? ""))
        : null;
      const inputMessage = pasted === null ? message : { ...message, text: pasted };
      const edit = pasted !== null && pasted.length >= PASTE_COLLAPSE_THRESHOLD
        ? collapsePaste(node, state, pasted)
        : inputEdit(node, inputMessage, inputRows(node, box.w).textWidth);
      if (!edit) {
        // A DECLINED key the input opted to surface (node.bubbleKeys) —
        // e.g. the questionnaire's custom-answer input bubbling ↑/↓ at
        // its top/bottom row — reaches the app instead of dying at the
        // overlay boundary. Returning false lets the host forward it.
        if (message.type === "key" && Array.isArray(node.bubbleKeys) && node.bubbleKeys.includes(message.key)) return false;
        // Unmatched keys fall through to the keyboard-enabled transcript:
        // Page Up/Down plus the modified vertical-scroll keys the input
        // never claims (Alt/Meta+Up/Down — see handleScroll).
        return handleScroll(nodes.get(keyScroll), message, true) || overlay !== null;
      }
      if (edit.submit) {
        state.undo.length = 0;
        state.redo.length = 0;
        sendInput(node, { ...edit, value: expandPastes(edit.value, state.pastes) });
      } else {
        recordInputChange(node, state, edit);
        sendInput(node, edit);
      }
      return true;
    }
    if (node.type === "menu") return handleMenu(node, stateFor(node.id), message);
    if (node.type === "toolbar") return handleToolbar(node, stateFor(node.id), message) || overlay !== null;
    if (handleScroll(entry, message)) return true;
    return overlay !== null;
  }

  /**
 * Clear all mounted control, pointer, selection, and per-node state.
 * @returns {void} Resets manager state; emitted events and external host state are unaffected.
 */

  function dispose() {
    nodes.clear();
    states.clear();
    targets = [];
    focused = null;
    overlay = null;
    keyScroll = null;
    drag = null;
    textSelection = null;
    sourceSelection = null;
    previewCells = [];
    hoveredCells = [];
    lastCanvas = null;
  }

  return { beginFrame, drawControl, reserveScrollBar, drawScrollBar, syncScroll, endFrame, applySelection, handle, stateFor, dispose, resolvePoint(point, { wheel = false } = {}) {
    const cell = lastCanvas?.cells?.[point.y]?.[point.x];
    if (!wheel && typeof cell?.action === "string" && cell.action !== "") return { kind: "press", control: "action", action: cell.action };
    if (!wheel && typeof cell?.link === "string" && cell.link !== "") return { kind: "press", control: "link", link: cell.link };
    if (!wheel && cell?.selectionKey && cell?.source) {
      return {
        kind: "press", control: "text", target: cell.selectionKey,
        index: cell.source.start, sourceText: String(cell.sourceText ?? ""),
      };
    }
    const target = [...targets].reverse().find((candidate) => pointInside(point, candidate.box) && (wheel || !candidate.wheelOnly));
    if (!target) return null;
    if (wheel && target.kind === "scrollbar") return { kind: "press", control: "scroll", target: target.target };
    if (target.kind === "input") {
      if (target.wheelOnly) return { kind: "press", control: "input", target: target.target }; // wheel: resolve the input, never a caret index
      const column = Math.max(0, point.x - target.box.x - target.margin);
      const tokens = target.tokens ?? visualInputRow(target.row);
      let used = 0;
      let index = tokens[0]?.start ?? target.row.start;
      for (let at = 0; at < tokens.length; at++) {
        const token = tokens[at];
        const width = graphemeWidth(token.text) || 1;
        const previous = tokens[at - 1];
        const next = tokens[at + 1];
        const reversed = (previous && previous.start > token.start) || (next && token.start > next.start);
        if (used + width > column) { index = reversed ? token.end : token.start; break; }
        used += width;
        index = reversed ? token.start : token.end;
      }
      return { kind: "press", control: "input", target: target.target, index };
    }
    return { kind: "press", control: target.kind, target: target.target, index: target.index };
  } };
}

export const controlInternals = Object.freeze({ inputEdit, inputRows, orderedSelection, vertical, completionWindow, collapsePaste, expandPastes, PASTE_COLLAPSE_THRESHOLD, PAGE_OVERLAP_ROWS, COMPLETION_ROWS, EDITING_MAP, SELECTED_EDITING_MAP, BUBBLE });
