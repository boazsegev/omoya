/** AI overlay views composed from GTUI's shared menu/scroll viewport controls. */

import { view } from "../gtui/gtui.js";
import { transcriptItems } from "./transcript.js";
import { questionView } from "./questionnaire-view.js";
import { VIEWER_FILTERS } from "./overlay-controller.js";
import { markdownRows } from "./markdown-view.js";

export const MENU_ID = "overlay-menu";
export const VIEWER_ID = "overlay-viewer";

export function splitMenuLabel(value) {
  const text = String(value ?? "");
  const pipe = text.indexOf("|");
  const paren = text.indexOf("(");
  const split = pipe < 0 ? paren : paren < 0 ? pipe : Math.min(pipe, paren);
  if (split < 0) return { label: text.trim() };
  const label = text.slice(0, split).trim();
  const note = text.slice(split + (text[split] === "|" ? 1 : 0)).trim();
  return note ? { label, note } : { label };
}

const MARKDOWN_SAMPLE = "# Heading\n**Bold**, _italic_, `inline code`, and a [link](https://example.com)\n1. Ordered item\n- List item\n> Quoted context\n```js\nconst themed = true;\n```";

function themePreview(name) {
  const markdown = markdownRows(MARKDOWN_SAMPLE).map(({ role, content }) => view.text({ role, content }));
  return view.column({}, [
    view.text({ role: "menu.header" }, ` ${name} preview `),
    view.text({ role: "message.system" }, "System › concise guidance"),
    view.text({ role: "message.user" }, "User › Can you summarize this?"),
    view.text({ role: "message.text" }, "Assistant › Certainly — here is the result."),
    view.text({ role: "message.thinking" }, "Thinking › reviewing context…"),
    view.text({ role: "tool.call" }, "Tool call › read settings"),
    view.text({ role: "tool.result" }, "Tool result ✓ completed"),
    view.text({ role: "tool.display" }, "Tool display › rendered output"),
    view.text({ role: "tool.error" }, "Tool error ✕ failed"),
    ...markdown,
  ]);
}

function agentDescriptionPreview(description) {
  return view.text({ role: "menu.footer", overflow: "clip-end" }, description);
}

function menuView(overlay) {
  const level = overlay.stack.at(-1);
  const stateKey = overlay.stack.map(({ title }) => title).join(" › ");
  const items = level.items.map((item) => {
    const parts = splitMenuLabel(item.label);
    return { ...item, ...parts, note: item.note ?? parts.note };
  });
  const menu = view.menu({ id: MENU_ID, stateKey, focus: true, title: level.title, items });
  return level.preview?.type === "theme" ? view.column({}, [menu, themePreview(level.preview.name)]) : menu;
}

export function viewerTitle(block, index, total) {
  if (!block) return " Block View [0/0] ";
  const label = block.label && block.label !== block.type ? ` — ${block.label}` : "";
  const numbered = Number.isInteger(block.messageNumber) && Number.isInteger(block.messagePart)
    ? `${block.messageNumber}.${block.messagePart}${block.section ? ` ${block.section}` : ""}`
    : null;
  const where = numbered ? ` · ${numbered}` : Number.isInteger(block.message) ? ` · message ${block.message + 1}` : "";
  return ` ${String(block.type).toUpperCase()} [${index + 1}/${total}]${label}${where} `;
}

function viewerView(overlay, blocks) {
  const index = Math.max(0, Math.min(overlay.index ?? 0, Math.max(0, blocks.length - 1)));
  const block = blocks[index];
  const body = block
    ? transcriptItems([block], 0, { previews: false }).at(0)?.node
    : view.text({ role: "menu.footer" }, "(no context blocks)");
  return view.scroll({
    id: VIEWER_ID,
    offset: overlay.offset,
    focus: true,
    title: viewerTitle(block, index, blocks.length),
    footer: " ← → blocks · Alt+←/→ 10 messages · ↑ ↓ / Space B / wheel scroll · F filter/search · C copy · Esc close ",
  }, [body]);
}

function viewerFilterView(overlay) {
  const options = [
    ...VIEWER_FILTERS.map((label) => ({ label, description: `show ${label} messages` })),
    { label: "Clear filters", description: "show every message type and clear search" },
  ];
  return questionView({ question: "Choose message types and/or enter a search pattern.", header: "Block View filters", details: "No selected types means all message types.", multiSelect: true, options }, overlay.draft, overlay.focus, overlay.filters, null, overlay.caret, overlay.selection);
}

/** The modal owns the viewport in both terminal modes. */
export function overlayView(overlay, blocks) {
  if (overlay.type === "viewer-filter") return viewerFilterView(overlay);
  const body = overlay.type === "menu" ? menuView(overlay) : viewerView(overlay, blocks);
  const preview = overlay.type === "menu" ? overlay.stack.at(-1)?.preview : null;
  const layers = preview?.type === "agent-description"
    ? [{ position: "top-right", node: agentDescriptionPreview(preview.description) }]
    : [];
  return view.overlay({ fill: true, layers }, [body]);
}
