import { expect, test } from "bun:test";
import { informationData } from "../lib/tui-app/information-data.js";

test("live tool output is a rolling newest-lines viewport without a trailing ellipsis", () => {
  const rows = informationData(null, null, [
    { tool: "bash", text: "one" },
    { tool: "bash", text: "two" },
    { tool: "bash", text: "three" },
    { tool: "bash", text: "four" },
    { tool: "bash", text: "five" },
  ]);

  expect(rows.map((row) => row.text)).toEqual([
    "▸ bash output:", "two", "three", "four", "five",
  ]);
  expect(rows.map((row) => row.text)).not.toContain("…");
});
