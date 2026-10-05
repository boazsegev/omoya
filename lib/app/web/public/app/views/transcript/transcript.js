import { markdownSources, markdownNode, updateMarkdownNode, installCopyListener, copyText } from "../../markdown-copy.js";
import { statusWord } from "../../text.js";
/** transcript.js — Incremental transcript rendering, Markdown, block actions, and native selection copy. */
import { state, isMac } from "../../state.js";
import { kbd, el, button, toast } from "../../dom.js";
import { toolLabel, argsText } from "../../logic/tool-label.js";
import { selectedTheme } from "../../theme-service.js";
import { brandWordmark } from "../../wordmark.js";
import { isNearBottom, jumpVisibility, shouldStickToBottom } from "../../logic/transcript-scroll.js";
import { readPreview } from "../../../read-preview.js";
import { previewWindow } from "../../logic/preview.js";
import { sameBubble as sameRowBubble, reconcileRows, reconcileCardChildren, patchStreamingCard } from "../../logic/transcript-rows.js";
import { formatDuration } from "../../../format.js";
import { attachmentsNode } from "../../attachments.js";
/* ------------------------------------------------------------- transcript */
// One mounted row per bubble. Stream patches and same-agent history refreshes
// retain rows so entrance/hover motion is independent of their content.

/**
 * Mark a block dirty and schedule a render.
 * @param {object} block - transcript block that changed.
 * @returns {void}
 */
function touch(block) { state.dirty.add(block); scheduleRender(); }
/**
 * Schedule a transcript repaint on the next animation frame, or a timer when
 * the browser withholds frames (hidden tab, occluded/minimized window, Safari
 * low-power): otherwise a stream piles up unseen and then lands all at once.
 * @param {boolean} [full=false] - force every block to re-render, not just dirty ones.
 * @returns {void}
 */
function scheduleRender(full = false) {
  if (full) state.fullRender = true;
  if (state.frame) return;
  state.frame = requestAnimationFrame(flushRender);
  state.frameTimer = setTimeout(flushRender, 100);
}
/**
 * Whether the transcript is scrolled to (within 80 px of) the bottom.
 * @returns {boolean} true when there is no scroll element yet.
 */
function nearBottom() { return isNearBottom(document.querySelector(".transcript-scroll")); }
/**
 * Show the jump-to-latest button off the bottom and the jump-to-oldest
 * button once the transcript is scrolled down past one viewport.
 * @returns {void}
 */
function syncJumpButtons() {
  const { topHidden, bottomHidden } = jumpVisibility(document.querySelector(".transcript-scroll"));
  document.querySelector(".jump-bottom").hidden = bottomHidden;
  document.querySelector(".jump-top").hidden = topHidden;
}

/**
 * Wrap a rendered block in its stable hover frame row (one mounted row per bubble).
 * @param {object} block - transcript block.
 * @returns {HTMLElement} the `.message-row` element.
 */
function messageFrame(block) {
  const row = el("div", `${messageRowClass(block)} entering`);
  state.rowBlocks.set(row, block);
  row.append(renderBlock(block));
  return row;
}

/**
 * CSS classes for a block's row, including the tool state class for tool cards.
 * @param {object} block
 * @returns {string}
 */
function messageRowClass(block) {
  return `message-row message-${block.kind}${block.kind === "tool" ? ` tool-${block.state ?? (block.done ? "ok" : "running")}` : ""}`;
}

/**
 * Whether a mounted row still hosts the same bubble (same kind and call id),
 * so it can be patched instead of replaced.
 * @param {HTMLElement} row
 * @param {object} block
 * @returns {boolean}
 */
function sameBubble(row, block) {
  const previous = state.rowBlocks.get(row);
  return sameRowBubble(previous, block);
}

/**
 * Patch one mounted row in place for a changed block. Card handlers close over
 * the block; a history replacement needs fresh handlers, while deltas on the
 * same block patch thinking text or preserve tool indicators via `patchStreamingCard`.
 * @param {HTMLElement} row
 * @param {object} block
 * @returns {void}
 */
function patchMessage(row, block) {
  const previous = state.rowBlocks.get(row);
  if (previous !== block && previous?.open !== undefined) block.open ??= previous.open;
  row.className = `${messageRowClass(block)}${row.classList.contains("entering") ? " entering" : ""}`;
  state.rowBlocks.set(row, block);
  if (previous === block && block.kind === "text" && !block.done) {
    const md = row.firstElementChild.querySelector(".md");
    updateMarkdownNode(md, block.text);
    appendStreamingCaret(md);
    return;
  }
  if (previous === block && block.kind === "thinking" && !block.done) {
    patchThinkingText(row.firstElementChild, block);
    return;
  }
  const next = renderBlock(block);
  // Card handlers close over the block; a history replacement needs fresh
  // handlers, while deltas on the same block preserve spinner/shimmer nodes.
  if (previous === block && block.kind === "tool" && !block.done && row.firstElementChild?.className === next.className) patchStreamingCard(row, next);
  else row.replaceChildren(next);
}

/**
 * Reconcile the mounted rows with the block list: append/replace/patch as needed.
 * @param {boolean} refresh - patch every retained row regardless of dirty state.
 * @returns {void}
 */
function renderMessages(refresh) {
  reconcileRows({ blocks: state.blocks, nodes: state.nodes, rowBlocks: state.rowBlocks, container: document.querySelector(".transcript"), makeFrame: messageFrame, patch: patchMessage, refresh, dirty: state.dirty });
}

/**
 * Keep the empty-state welcome pinned above the first non-system block.
 * @returns {void}
 */
function syncWelcome() {
  const welcome = document.querySelector(".transcript")?.querySelector(".empty-state");
  const firstUser = state.blocks.findIndex((block) => block.kind === "user");
  const boundary = firstUser < 0 ? state.blocks.findIndex((block) => block.kind !== "system") : firstUser;
  const next = boundary < 0 ? null : state.nodes[boundary];
  if (welcome && welcome.nextElementSibling === (next ?? null)) return;
  document.querySelector(".transcript")?.insertBefore(welcome ?? emptyState(), next ?? null);
}

/**
 * Flush the scheduled render: reconcile rows, sync the welcome, render the
 * working indicator, and keep the scroll pinned when already near the bottom.
 * @returns {void}
 */
function flushRender() {
  cancelAnimationFrame(state.frame);
  clearTimeout(state.frameTimer);
  state.frame = 0;
  if (!document.querySelector(".transcript")) return;
  // Reset drops every row, so nearBottom() measured against the emptied
  // container lies — stickBottom carries the intent to land at the bottom.
  const stick = shouldStickToBottom(state, nearBottom());
  state.stickBottom = false;
  if (state.resetTranscript) {
    state.resetTranscript = false;
    state.nodes.length = 0;
    document.querySelector(".transcript")?.replaceChildren();
  }
  renderMessages(state.fullRender);
  state.fullRender = false;
  state.dirty.clear();
  syncWelcome();
  renderWorkingIndicator();
  if (stick) document.querySelector(".transcript-scroll").scrollTop = document.querySelector(".transcript-scroll").scrollHeight;
  syncJumpButtons();
}

/**
 * Show a "Working" indicator when the agent is busy but nothing is streaming yet.
 * @returns {void}
 */
function renderWorkingIndicator() {
  document.querySelector(".transcript")?.querySelector(".working-row")?.remove();
  const working = state.agent?.state === "working" || state.agent?.busy === true;
  const last = state.blocks.at(-1);
  const streaming = last && !last.done && (last.kind === "text" || last.kind === "thinking" || last.kind === "tool");
  if (!working || streaming) return;
  const row = el("div", "working-row");
  row.append(el("span", "dots"), statusWord("Working"));
  document.querySelector(".transcript")?.append(row);
}

/**
 * The empty-state hero: wordmark, endpoint/model lead, prompt suggestions, and key hints.
 * @returns {HTMLElement} the `.empty-state` element.
 */
function emptyState() {
  const empty = el("div", "empty-state");
  const title = el("h1", null);
  title.append(brandWordmark());
  empty.append(title);
  const model = state.settings.endpoint ? `${state.settings.endpoint}/${state.settings.model ?? "?"}` : null;
  empty.append(el("p", "empty-lead", model ? `Talking to ${model}` : "Pick a model or sign in to an endpoint to begin."));
  if (!model) empty.append(button("primary-button", "Sign in to an endpoint", () => emit("login.open")));
  const tips = el("div", "empty-tips");
  const prompts = state.catalog.prompts.slice(0, 6);
  for (const name of prompts) tips.append(button("suggestion", `/${name}`, () => emit("composer.insert", `/${name} `), { title: "Insert this prompt" }));
  if (prompts.length) empty.append(el("p", "muted small", "Your prompts"), tips);
  empty.append(el("p", "muted small", state.settings.sessionSave === true ? "This conversation is saved — resume it any time." : "Unlogged: nothing is written to disk until you turn logging on."));
  const keys = el("p", "muted small keys-line");
  keys.append(kbd("/"), document.createTextNode(" commands · "), kbd(isMac ? "⌘K" : "Ctrl K"), document.createTextNode(" palette · "), kbd("Shift ↵"), document.createTextNode(" new line"));
  empty.append(keys);
  return empty;
}
/**
 * A `<kbd>` element for a key label.
 * @param {string} text
 * @returns {HTMLElement}
 */


/**
 * Render a transcript block to DOM, dispatching on its kind.
 * @param {object} block - `{ kind: "user"|"thinking"|"tool"|"system"|"error"|"command"|…, … }`.
 * @returns {HTMLElement} the message bubble.
 */
function renderBlock(block) {
  switch (block.kind) {
    case "user": return renderUser(block);
    case "thinking": return renderThinking(block);
    case "tool": return renderTool(block);
    case "system": return renderSystem(block);
    case "error": {
      const node = el("div", "msg msg-error");
      node.append(el("span", "msg-error-icon", "!"), el("span", "msg-error-text", block.text));
      if (block.retry) node.append(button("chip", "Retry", () => emit("server", { type: "chat.continue" }), { title: "Continue over the current context" }));
      return node;
    }
    case "command": {
      const node = el("div", "msg msg-command");
      node.append(el("pre", null, block.text));
      return node;
    }
    default: {
      const node = el("div", "msg msg-assistant" + (block.done ? "" : " streaming"));
      const md = markdownNode("div", "md", block.text);
      if (!block.done) appendStreamingCaret(md);
      node.append(md);
      node.append(blockControls(block));
      return node;
    }
  }
}

/** Append a stream caret without putting it inside block widgets. */
function appendStreamingCaret(md) {
  const tail = md.lastElementChild;
  (tail && !/^(PRE|TABLE|UL|OL|DIV|HR)$/.test(tail.tagName) ? tail : md).append(el("span", "caret"));
}

/**
 * Render a user message bubble, including attachment chips and block controls.
 * @param {object} block - `{ text, attachments?, … }`.
 * @returns {HTMLElement}
 */
function renderUser(block) {
  const node = el("div", "msg msg-user");
  const body = markdownNode("div", "md user-text", block.text);
  node.append(body);
  if (block.attachments?.length) node.append(attachmentsNode(block.attachments));
  node.append(blockControls(block));
  return node;
}


/**
 * Preview row cap for a block kind under the selected theme (theme
 * `<role>.preview.maxRows`, shared with the TUI); false = uncapped.
 * @param {string} kind - "system" | "thinking" | "tool".
 * @returns {number|false}
 */
function previewRows(kind) {
  const rows = state.prefs.previewRows?.[selectedTheme()] ?? state.prefs.previewRows?.default;
  return rows?.[kind] ?? false;
}

/**
 * TUI preview window: the first line, an omission marker, then the last
 * `rows - 2` lines — so a streaming block shows its tail with the head
 * cropped. Windowed BEFORE any Markdown parsing so a cut fence cannot
 * swallow the tail. Thinking previews render each visible window as Markdown.
 * @param {*} text - block text.
 * @param {number|false} rows - row cap; false = uncapped.
 * @param {string} [className=""] - extra classes.
 * @param {boolean} [markdown=false] - render each window as Markdown.
 * @returns {HTMLElement} the `.block-preview` element.
 */
function previewNode(text, rows, className = "", markdown = false) {
  const { head, hidden, tail } = previewWindow(text, rows);
  const node = el("div", `block-preview ${className}${markdown ? " md markdown-preview" : ""}`.trim());
  if (!hidden) {
    if (markdown) node.append(markdownNode("div", "", head));
    else node.textContent = head;
    return node;
  }
  const gap = el("span", "preview-gap", `⋯ ${hidden} more line${hidden === 1 ? "" : "s"}`);
  if (markdown) {
    node.append(markdownNode("div", "", head), gap);
    if (tail) node.append(markdownNode("div", "", tail));
  } else node.append(document.createTextNode(`${head}\n`), gap, document.createTextNode(tail ? `\n${tail}` : ""));
  return node;
}

/**
 * A collapsible card: <summary> holds the header row plus the collapsed
 * preview (a closed <details> renders nothing but its summary).
 * @param {object} block - transcript block; `block.open` persists the toggle state.
 * @param {string} className - card classes.
 * @param {boolean} isOpen - default open state when the block has no remembered one.
 * @returns {{node: HTMLElement, summary: HTMLElement, head: HTMLElement}}
 */
function cardShell(block, className, isOpen) {
  const node = el("details", className);
  node.open = block.open ?? isOpen;
  node.addEventListener("toggle", () => { block.open = node.open; });
  const summary = el("summary", null);
  const head = el("span", "card-head");
  summary.append(head);
  node.append(summary);
  return { node, summary, head };
}

/**
 * Render a system block as a collapsed card.
 * @param {object} block - `{ text, … }`.
 * @returns {HTMLElement}
 */
function renderSystem(block) {
  const { node, summary, head } = cardShell(block, "msg msg-system", false);
  head.append(el("span", "block-kind", "System"));
  summary.append(previewNode(block.text, previewRows("system")));
  node.append(markdownNode("div", "md system-body", block.text), blockControls(block));
  return node;
}

/**
 * Render a thinking block as a card with elapsed-time header and Markdown preview.
 * @param {object} block - `{ text, done, started?, ended?, … }`.
 * @returns {HTMLElement}
 */
function renderThinking(block) {
  const { node, summary, head } = cardShell(block, "msg msg-thinking" + (block.done ? "" : " streaming"), !state.prefs.collapse.thinking);
  const seconds = block.started && block.ended ? Math.max(1, Math.round((block.ended - block.started) / 1000)) : null;
  head.append(el("span", "block-kind", block.done ? (seconds ? `Thought for ${seconds}s` : "Thought") : "Thinking"));
  if (!block.done) head.append(el("span", "shimmer-dots"));
  summary.append(previewNode(block.text, previewRows("thinking"), "thinking-preview", true));
  node.append(markdownNode("div", "md thinking-body", block.text), blockControls(block));
  return node;
}

/** Keep the animated shell mounted; only the preview/body text changes. */
function patchThinkingText(card, block) {
  const preview = card.querySelector(".thinking-preview");
  const next = previewNode(block.text, previewRows("thinking"), "thinking-preview", true);
  preview.replaceChildren(...next.childNodes);
  updateMarkdownNode(card.querySelector(".thinking-body"), block.text);
}

const TOOL_STATE = { composing: ["…", "writing call"], queued: ["◌", "queued"], running: ["◌", "running"], ok: ["✓", "done"], error: ["✕", "failed"], skipped: ["–", "not run"] };
/**
 * Render a tool card: state glyph, name, args summary, duration, windowed output
 * preview, and a lazily filled body (Input/Output sections, display payloads).
 * @param {object} block - tool block `{ name, args, state, output, done, … }`.
 * @returns {HTMLElement}
 */
function renderTool(block) {
  const toolState = block.state ?? (block.done ? "ok" : "running");
  const { node, summary, head } = cardShell(block, `msg msg-tool tool-${toolState}`, !state.prefs.collapse.tools || toolState === "error");
  node.addEventListener("toggle", () => { if (node.open) fillToolBody(); });
  const { name, summary: argSummary } = toolLabel({ name: block.name, arguments: block.args });
  const [glyph, label] = TOOL_STATE[toolState] ?? TOOL_STATE.running;
  const icon = el("span", "tool-state", glyph);
  icon.setAttribute("aria-label", label);
  head.append(icon, el("span", "tool-name", name));
  if (argSummary) head.append(el("span", "tool-args-summary", argSummary));
  const meta = el("span", "tool-meta");
  if (block.ended && block.runStarted) meta.textContent = formatDuration(block.ended - block.runStarted);
  else meta.textContent = toolState === "ok" || toolState === "error" ? "" : label;
  head.append(meta);
  // Collapsed: the output's preview window — or the arguments while the
  // model is still writing the call (the payload streaming right now).
  const rows = previewRows("tool");
  const payload = block.output || (toolState === "composing" || toolState === "queued" ? argsText(block.args) : "");
  if (payload) {
    const preview = readPreview(toolState === "ok" ? block.name : "", payload);
    if (preview.mime) head.append(el("span", "tool-meta", preview.mime));
    summary.append(previewNode(preview.text, rows, `tool-preview${toolState === "error" ? " error" : ""}`, preview.markdown));
  }
  // Display is meant for the user, not the model: keep it visible even when
  // the tool's input/output details are collapsed (notably edit diffs).
  for (const text of block.display ?? []) summary.append(markdownNode("div", "md tool-display", text));
  if (block.attachments?.length) summary.append(attachmentsNode(block.attachments));
  // The body renders lazily: collapsed cards in a long history cost nothing.
  const fillToolBody = () => {
    if (node.querySelector(".tool-body")) return;
    const body = el("div", "tool-body");
    const args = argsText(block.args);
    if (args) {
      const section = el("div", "tool-section");
      section.append(el("div", "tool-section-label", "Input"), toolState === "composing" ? previewNode(args, rows, "tool-args") : el("pre", "tool-args", args));
      body.append(section);
    }
    if (block.output) {
      const section = el("div", "tool-section");
      section.append(el("div", "tool-section-label", toolState === "error" ? "Error" : "Output"));
      // Streaming output stays windowed even when open (TUI parity: a huge
      // live payload never re-renders in full per frame); settled output is
      // shown complete.
      section.append(block.done ? markdownNode("div", "md tool-output", block.output) : previewNode(block.output, rows, "tool-output"));
      body.append(section);
    }
    if (!args && !block.output && !(block.display ?? []).length) body.append(el("p", "muted small", toolState === "running" ? "Waiting for output…" : "No output"));
    body.append(blockControls(block));
    node.append(body);
  };
  if (node.open) fillToolBody();
  return node;
}

/**
 * Per-block action icons: copy, view-in-context, edit (when editable),
 * edit-&-resend (user blocks), and delete.
 * @param {object} block
 * @returns {HTMLElement} the `.block-controls` row.
 */
function blockControls(block) {
  const controls = el("div", "block-controls");
  controls.append(button("block-icon", null, () => {
    const text = block.kind === "tool" ? [argsText(block.args), block.output].filter(Boolean).join("\n\n") : block.text;
    copyText(String(text ?? ""), "Copied");
  }, { title: "Copy", icon: "⧉" }));
  const index = Number.isInteger(block.messageIndex) ? block.messageIndex : Number.isInteger(block.resultIndex) ? block.resultIndex : null;
  if (index === null) return controls;
  const blockIndex = Number.isInteger(block.blockIndex) ? block.blockIndex : 0;
  controls.append(button("block-icon", null, () => emit("viewer.open", { messageIndex: index, blockIndex }), { title: "View in context", icon: "⌕" }));
  if (block.editable) controls.append(button("block-icon", null, () => emit("viewer.open", [{ messageIndex: index, blockIndex }, true]), { title: "Edit", icon: "✎" }));
  if (block.kind === "user") controls.append(button("block-icon", null, () => { if (confirm("Remove this message and everything after it, and put its text back in the composer?")) { emit("server", { type: "context.rollback", messageIndex: index }); emit("composer.insert", [block.text, true]); } }, { title: "Edit & resend from here", icon: "↺" }));
  controls.append(button("block-icon block-delete", null, () => deleteContextMessages([index]), { title: "Delete message", icon: "⌫" }));
  return controls;
}

/**
 * Delete messages from context after confirmation (single message or batch).
 * @param {number[]} messageIndexes
 * @returns {void}
 */
function deleteContextMessages(messageIndexes) {
  const unique = [...new Set(messageIndexes)].sort((a, b) => a - b);
  const label = unique.length === 1 ? "this message" : `${unique.length} messages`;
  if (!confirm(`Delete ${label} from context? This cannot be undone.`)) return;
  emit("server", { type: "context.delete", messageIndexes: unique });
}

export { touch, scheduleRender, nearBottom, syncJumpButtons, messageFrame, messageRowClass, sameBubble, patchMessage, renderMessages, reconcileCardChildren, patchStreamingCard, syncWelcome, flushRender, renderWorkingIndicator, emptyState, kbd, renderBlock, renderUser, previewRows, previewNode, cardShell, renderSystem, renderThinking, TOOL_STATE, renderTool, markdownSources, markdownNode, blockControls, installCopyListener, copyText, deleteContextMessages };

let emit = () => {};
export function mount(_root, { emit: dispatch }) { emit = dispatch; }
