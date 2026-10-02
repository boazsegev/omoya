/**
 * Convert information rows into a terminal-neutral GTUI column.
 * Content rows are rendered as Markdown, with plain text assigned the
 * `information.text` role; other rows use `information.source`, and status
 * rows clip overflowing text at the end.
 *
 * @param {Array<{kind: string, text: unknown}> | null | undefined} rows Rows to render; `null` or `undefined` is treated as an empty array.
 * @returns {object} A GTUI column node containing the rendered rows.
 */

import { view } from "../gtui/gtui.js";
import { markdownRows } from "./markdown-view.js";

export function informationView(rows) {
  const nodes = [];
  for (const row of rows ?? []) {
    if (row.kind === "content") {
      for (const rendered of markdownRows(row.text)) {
        const role = rendered.role === "md.text" ? "information.text" : rendered.role;
        if (rendered.table) nodes.push(view.table({ role, align: rendered.table.align, headerRule: rendered.table.headerRule }, rendered.table.rows));
        else nodes.push(view.text({ role }, [{ text: "  ", role: "information.text" }, ...rendered.content]));
      }
    } else {
      nodes.push(view.text({ role: "information.source", overflow: row.kind === "status" ? "clip-end" : undefined }, row.text));
    }
  }
  return view.column({}, nodes);
}
