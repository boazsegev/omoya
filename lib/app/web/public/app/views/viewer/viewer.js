import { el, button } from "../../dom.js";
/** viewer.js — Context block viewer, filtering, navigation, editing, and bulk controls. */
import { markdownNode, copyText } from "../../markdown-copy.js";
import { attachmentsNode } from "../../attachments.js";
import { state } from "../../state.js";
import { contextEntries as buildContextEntries, viewerWhere as describeViewerWhere, canEditViewerBlock } from "../../logic/viewer.js";
/* ------------------------------------------------------------ block viewer */
const VIEWER_TYPES = ["system", "user", "thinking", "assistant", "tool call", "tool answer", "tool display"];
/**
 * Flatten context messages into per-block viewer entries with a text `source`.
 * @returns {Array<object>}
 */
function contextEntries() {
  return buildContextEntries(state.contextBlocks, state.contextTools);
}

/**
 * Apply the viewer's type filters and RegExp search to entries.
 * @param {Array<object>} entries
 * @returns {{entries: Array<object>, error: string|null}} error is set for an invalid RegExp.
 */
function filteredContextEntries(entries) {
  let pattern;
  try { pattern = state.contextView.search ? new RegExp(state.contextView.search, "i") : null; } catch { return { entries: [], error: "Enter a valid regular expression." }; }
  return { entries: entries.filter((block) => (!state.contextView.types.size || state.contextView.types.has(block.viewerType)) && (!pattern || pattern.test(`${block.viewerType}\n${block.source}`))), error: null };
}

// The block viewer pages ONE context block at a time, like the TUI's ^O
// viewer: `TYPE [i/N] — name · message.part`, ←/→ blocks, Alt+←/→ ten
// messages, ↑/↓ Space/B scroll, F search, C copy, Esc close. Filters and
// search narrow the pages; the selected block survives re-filtering and
// context refreshes (or falls back to its nearest predecessor).
const VIEWER_HOP = 10;
const VIEWER_KEYS = "← → blocks · Alt+←/→ 10 messages · G go to # · ↑ ↓ / Space B scroll · F search · C copy · Esc close";
/**
 * Stable identity of a context block for the viewer (`messageIndex:blockIndex`).
 * @param {object} block
 * @returns {string}
 */
const blockKey = (block) => `${block.messageIndex}:${block.blockIndex}`;

/**
 * Open the block viewer (Ctrl+O), optionally targeting a specific block and/or
 * starting in edit mode; requests the context snapshot from the server.
 * @param {{messageIndex: number, blockIndex: number}|null} [target=null]
 * @param {boolean} [edit=false]
 * @returns {void}
 */
function openContextViewer(target = null, edit = false) {
  state.contextTools = null;
  state.contextView = { search: "", types: new Set(), selected: new Set(), target, edit, key: null, editKey: null };
  const { dialog } = emit("dialog.open", { id: "context-viewer", title: "Block viewer", wide: true, className: "context-viewer", onClose: () => { state.contextView = null; } });
  dialog.addEventListener("keydown", viewerKey);
  renderContextViewer(true);
  emit("server", { type: "context.inspect" });
}
/**
 * Close the block viewer, if open.
 * @returns {void}
 */
function closeContextViewer() { document.querySelector("#context-viewer")?.close(); }

/** Refresh an open inspector after tool/settings changes without showing a stale catalog. */
function refreshContextCatalog() {
  if (!state.contextView) return;
  state.contextTools = null;
  renderContextViewer();
  emit("server", { type: "context.inspect" });
}

/**
 * `3.2` for the second block of a multi-block message, else `message 3`.
 * @param {object} block - viewer entry `{ messageIndex, blockIndex }`.
 * @param {Array<object>} all - all (unfiltered) entries.
 * @returns {string}
 */
function viewerWhere(block, all) {
  return describeViewerWhere(block, all);
}

/**
 * The current page among the filtered entries: the target (a "View in
 * context" jump), else the kept block key, else its nearest predecessor,
 * else the newest block.
 * @param {Array<object>} entries - filtered entries.
 * @returns {number} index into `entries`, -1 when empty.
 */
function viewerIndex(entries) {
  if (!entries.length) return -1;
  if (state.contextView.target) {
    const index = entries.findIndex((block) => block.messageIndex === state.contextView.target.messageIndex && block.blockIndex === state.contextView.target.blockIndex);
    if (index >= 0) return index;
  }
  if (state.contextView.key === null) return entries.length - 1;
  const index = entries.findIndex((block) => blockKey(block) === state.contextView.key);
  if (index >= 0) return index;
  const [message, part] = state.contextView.key.split(":").map(Number);
  const before = entries.findLastIndex((block) => block.messageIndex < message || (block.messageIndex === message && block.blockIndex < part));
  return Math.max(0, before);
}

/**
 * Jump to the n-th (1-based) filtered block, clamped to the range.
 * @param {number} n
 * @returns {void}
 */
function gotoViewer(n) {
  const { entries } = filteredContextEntries(contextEntries());
  if (!entries.length || !Number.isFinite(n)) return;
  state.contextView.key = blockKey(entries[Math.max(0, Math.min(entries.length - 1, Math.round(n) - 1))]);
  renderContextViewer();
}

/**
 * Move the viewer one block forward/back, clamped.
 * @param {number} step
 * @returns {void}
 */
function moveViewer(step) {
  const { entries } = filteredContextEntries(contextEntries());
  const index = viewerIndex(entries);
  if (index < 0) return;
  const next = entries[Math.max(0, Math.min(entries.length - 1, index + step))];
  state.contextView.key = blockKey(next);
  renderContextViewer();
}

/**
 * Hop by logical messages (a message's blocks stay together).
 * @param {number} direction - ±1; each hop spans VIEWER_HOP messages.
 * @returns {void}
 */
function hopViewer(direction) {
  const { entries } = filteredContextEntries(contextEntries());
  const index = viewerIndex(entries);
  if (index < 0) return;
  const starts = entries.map((block, i) => i).filter((i) => i === 0 || entries[i].messageIndex !== entries[i - 1].messageIndex);
  const group = starts.findLastIndex((i) => i <= index);
  const destination = starts[Math.max(0, Math.min(starts.length - 1, group + direction * VIEWER_HOP))];
  state.contextView.key = blockKey(entries[destination]);
  renderContextViewer();
}

/**
 * Block-viewer key handling: ←/→ blocks, Alt+←/→ message hops, ↑/↓ Space/B
 * scroll, F search, G go-to, C copy. Search/index inputs get their own Enter
 * and arrow behavior.
 * @param {KeyboardEvent} event
 * @returns {void}
 */
function viewerKey(event) {
  if (!state.contextView) return;
  const typing = event.target.matches?.("input, textarea, select");
  if (typing) {
    if (event.key === "Enter" && event.target.classList.contains("context-search")) { event.preventDefault(); document.querySelector("#context-viewer .viewer-body")?.focus(); }
    if (event.target.classList.contains("viewer-index")) {
      if (event.key === "Enter") { event.preventDefault(); gotoViewer(Number(event.target.value)); document.querySelector("#context-viewer .viewer-body")?.focus(); }
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveViewer(event.key === "ArrowUp" ? -1 : 1); document.querySelector("#context-viewer .viewer-index")?.select(); }
    }
    return;
  }
  if (event.metaKey || event.ctrlKey) return;
  const body = document.querySelector("#context-viewer .viewer-body");
  const page = () => Math.max(40, (body?.clientHeight ?? 400) - 40);
  const key = event.key;
  const act = {
    ArrowLeft: () => (event.altKey ? hopViewer(-1) : moveViewer(-1)),
    ArrowRight: () => (event.altKey ? hopViewer(1) : moveViewer(1)),
    ArrowUp: () => body?.scrollBy({ top: -40 }),
    ArrowDown: () => body?.scrollBy({ top: 40 }),
    " ": () => body?.scrollBy({ top: event.shiftKey ? -page() : page() }),
    b: () => body?.scrollBy({ top: -page() }),
    B: () => body?.scrollBy({ top: -page() }),
    f: () => document.querySelector("#context-viewer .context-search")?.focus(),
    F: () => document.querySelector("#context-viewer .context-search")?.focus(),
    g: () => document.querySelector("#context-viewer .viewer-index")?.focus(),
    G: () => document.querySelector("#context-viewer .viewer-index")?.focus(),
    c: () => { const block = currentViewerBlock(); if (block) copyText(block.source, "Block copied"); },
    C: () => { const block = currentViewerBlock(); if (block) copyText(block.source, "Block copied"); },
  }[key];
  if (!act) return;
  event.preventDefault();
  act();
}

/**
 * The currently paged viewer block, or null.
 * @returns {object|null}
 */
function currentViewerBlock() {
  const { entries } = filteredContextEntries(contextEntries());
  return entries[viewerIndex(entries)] ?? null;
}

/**
 * Repaint the block viewer: search field, type filter chips, pager with editable
 * block number, the paged block card, and the footer with the delete-selected
 * action. Focus is restored after repaint.
 * @param {boolean} [initial=false] - first paint (shows "Loading…" before context arrives).
 * @returns {void}
 */
function renderContextViewer(initial = false) {
  const dialog = document.querySelector("#context-viewer");
  if (!dialog || !state.contextView) return;
  const body = dialog.querySelector(".panel-body");
  const searchFocused = document.activeElement?.classList.contains("context-search");
  const indexFocused = document.activeElement?.classList.contains("viewer-index");
  const all = contextEntries();
  const { entries, error } = filteredContextEntries(all);
  body.replaceChildren();
  const tools = el("div", "context-tools");
  const search = el("input", "context-search"); search.type = "search"; search.placeholder = "RegExp search all blocks (F)"; search.value = state.contextView.search; search.setAttribute("aria-label", "Search all context blocks with a regular expression");
  search.addEventListener("input", () => { state.contextView.search = search.value; renderContextViewer(); });
  const filters = el("div", "context-filters");
  filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Block types");
  for (const type of VIEWER_TYPES) {
    const count = all.filter((block) => block.viewerType === type).length;
    const chip = button("filter-chip" + (state.contextView.types.has(type) ? " active" : ""), `${type} ${count}`, () => { if (state.contextView.types.has(type)) state.contextView.types.delete(type); else state.contextView.types.add(type); renderContextViewer(); });
    chip.setAttribute("aria-pressed", String(state.contextView.types.has(type)));
    chip.disabled = count === 0;
    filters.append(chip);
  }
  tools.append(search, filters);
  body.append(tools);

  const index = error ? -1 : viewerIndex(entries);
  const block = entries[index] ?? null;
  if (block) state.contextView.key = blockKey(block);
  const pager = el("div", "viewer-pager");
  const nav = (label, title, onClick, disabled) => { const node = button("chip viewer-nav", label, onClick, { title }); node.disabled = disabled; return node; };
  const title = el("div", "viewer-title");
  if (block) {
    // `[i/N]` where i is an editable field: type a number, Enter jumps there.
    const jump = el("input", "viewer-index");
    jump.type = "text"; jump.inputMode = "numeric"; jump.autocomplete = "off"; jump.spellcheck = false;
    jump.value = String(index + 1); jump.title = "Go to block (G) — type a number, Enter"; jump.setAttribute("aria-label", `Block number, 1 to ${entries.length}`);
    jump.style.setProperty("--digits", String(String(entries.length).length));
    jump.addEventListener("focus", () => jump.select());
    jump.addEventListener("input", () => { jump.value = jump.value.replace(/\D/g, ""); });
    jump.addEventListener("blur", () => { jump.value = String(index + 1); });
    const count = el("span", "viewer-count");
    count.append("[", jump, `/${entries.length}]`);
    title.append(el("strong", `context-block-type type-${block.viewerType.replace(" ", "-")}`, block.viewerType.toUpperCase()), " ", count);
    if (block.name) title.append(el("span", null, ` — ${block.name}`));
    title.append(el("small", null, ` · ${viewerWhere(block, all)}`));
  } else title.append(el("span", "muted", initial && !all.length ? "Loading…" : error ?? "No context blocks match the current filters."));
  pager.append(
    nav("«", "Back 10 messages (Alt+←)", () => hopViewer(-1), index <= 0),
    nav("‹", "Previous block (←)", () => moveViewer(-1), index <= 0),
    title,
    nav("›", "Next block (→)", () => moveViewer(1), index < 0 || index >= entries.length - 1),
    nav("»", "Forward 10 messages (Alt+→)", () => hopViewer(1), index < 0 || index >= entries.length - 1),
  );
  body.append(pager);

  const page = el("div", "viewer-body");
  page.tabIndex = 0;
  page.setAttribute("aria-label", "Block content (↑ ↓ Space B to scroll)");
  if (block && state.contextView.edit && state.contextView.target !== null && all.length) state.contextView.editKey = blockKey(block);
  if (block) page.append(contextCard(block, state.contextView.editKey === blockKey(block)));
  body.append(page);

  const foot = el("div", "viewer-foot");
  const deleteSelected = button("chip danger", `Delete selected (${state.contextView.selected.size})`, () => emit("context.delete", [...state.contextView.selected]));
  deleteSelected.disabled = state.contextView.selected.size === 0;
  foot.append(el("span", "muted small viewer-keys", VIEWER_KEYS), el("span", "muted small", `${all.length} blocks · ${state.contextBlocks.length} messages`), deleteSelected);
  body.append(foot);

  if (all.length) { state.contextView.target = null; state.contextView.edit = false; }
  if (searchFocused) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  else if (indexFocused && dialog.querySelector(".viewer-index")) dialog.querySelector(".viewer-index").focus();
  else if (dialog.querySelector(".context-edit textarea")) dialog.querySelector(".context-edit textarea").focus();
  else page.focus({ preventScroll: true });
}

/**
 * One context block card in the viewer: select checkbox, copy/edit/rollback/delete
 * actions, and either the edit form or the rendered content (Markdown or <pre>).
 * @param {object} block - viewer entry.
 * @param {boolean} editing - render the inline edit form.
 * @returns {HTMLElement}
 */
function contextCard(block, editing) {
  const card = el("article", "context-block");
  const meta = el("header", "context-block-meta");
  if (!block.virtual) {
    const select = el("input"); select.type = "checkbox"; select.checked = state.contextView.selected.has(block.messageIndex); select.setAttribute("aria-label", `Select message ${block.messageIndex + 1}`);
    select.addEventListener("change", () => { if (select.checked) state.contextView.selected.add(block.messageIndex); else state.contextView.selected.delete(block.messageIndex); renderContextViewer(); });
    meta.append(select, el("small", null, `Select message ${block.messageIndex + 1}`));
  } else meta.append(el("small", null, "Read-only publication snapshot"));
  const blockActions = el("div", "block-controls always");
  blockActions.append(button("block-icon", null, () => copyText(block.source, "Copied"), { title: "Copy", icon: "⧉" }));
  const canEdit = canEditViewerBlock(block);
  if (canEdit) blockActions.append(button("block-icon", null, () => { state.contextView.editKey = blockKey(block); renderContextViewer(); }, { title: "Edit", icon: "✎" }));
  if (!block.virtual) {
    blockActions.append(button("block-icon", null, () => { if (confirm(`Remove message #${block.messageIndex} and everything after it?`)) emit("server", { type: "context.rollback", messageIndex: block.messageIndex }); }, { title: "Roll back to here (drop this and later messages)", icon: "⤒" }));
    blockActions.append(button("block-icon block-delete", null, () => emit("context.delete", [block.messageIndex]), { title: "Delete message", icon: "⌫" }));
  }
  meta.append(blockActions);
  card.append(meta);
  if (editing && canEdit) {
    const form = el("form", "context-edit");
    const area = el("textarea"); area.value = block.text; area.rows = Math.min(20, Math.max(4, block.text.split("\n").length + 1)); area.setAttribute("aria-label", "Edit block text");
    const row = el("div", "button-row");
    row.append(button("chip", "Cancel", () => { state.contextView.editKey = null; renderContextViewer(); }), button("primary-button", "Save", null, { type: "submit" }));
    form.append(area, row);
    form.addEventListener("submit", (event) => { event.preventDefault(); state.contextView.editKey = null; emit("server", { type: "context.edit-text", messageIndex: block.messageIndex, blockIndex: block.blockIndex, text: area.value }); });
    area.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); } });
    card.append(form);
    queueMicrotask(() => area.focus());
  } else if (block.attachment) card.append(attachmentsNode([block.attachment]), el("pre", "context-pre", block.source));
  else if (["thinking", "assistant", "tool answer", "tool display", "user", "system"].includes(block.viewerType)) card.append(markdownNode("div", "md context-markdown", block.source));
  else card.append(el("pre", "context-pre", block.source));
  return card;
}

export { VIEWER_TYPES, contextEntries, filteredContextEntries, VIEWER_HOP, VIEWER_KEYS, blockKey, openContextViewer, closeContextViewer, refreshContextCatalog, viewerWhere, viewerIndex, gotoViewer, moveViewer, hopViewer, viewerKey, currentViewerBlock, renderContextViewer, contextCard };

let emit = () => {};
export function mount(_root, { emit: dispatch }) { emit = dispatch; }
