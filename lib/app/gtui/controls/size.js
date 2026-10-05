// Natural sizes of input, menu, and toolbar controls.
import { inputRows, completionWindow } from "./input.js";
import { menuItemRows } from "./menu.js";
import { toolbarButtons, toolbarGap } from "./toolbar.js";
/**
 * Natural size for controls, shared with the semantic layout engine.
 */
export function controlNaturalSize(node, width, height) {
  if (node.type === "input") {
    const textRows = Math.min(Number(node.maxRows ?? 8), inputRows(node, width).rows.length);
    const completionRows = completionWindow(node.completions, node.completionIndex, Infinity, node.maxCompletionRows).length;
    return { w: width, h: Math.min(height, Math.max(3, textRows + 2 + completionRows)) };
  }
  if (node.type === "menu") {
    const rows = (node.items ?? []).reduce((count, item) => count + menuItemRows(item, width), 0);
    return { w: width, h: Math.min(height, Math.max(5, rows + 4)) };
  }
  if (node.type === "toolbar") {
    const items = toolbarButtons(node);
    const natural = items.reduce((sum, item) => sum + item.w, 0) + toolbarGap(node) * Math.max(0, items.length - 1);
    return { w: Math.min(width, natural), h: Math.min(height, items.length > 0 ? 1 : 0) };
  }
  return null;
}

