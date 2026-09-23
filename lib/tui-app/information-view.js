/** Render terminal-neutral tool information through GTUI nodes. */

import { view } from "../gtui/gtui.js";
import { markdownRows } from "./markdown-view.js";

export function informationView(rows) {
  const nodes = [];
  for (const row of rows ?? []) {
    if (row.kind === "content") {
      for (const rendered of markdownRows(row.text)) {
        const role = rendered.role === "md.text" ? "information.text" : rendered.role;
        if (rendered.table) nodes.push(view.table({ role }, rendered.table.rows));
        else nodes.push(view.text({ role }, [{ text: "  ", role: "information.text" }, ...rendered.content]));
      }
    } else {
      nodes.push(view.text({ role: "information.source", overflow: row.kind === "status" ? "clip-end" : undefined }, row.text));
    }
  }
  return view.column({}, nodes);
}
