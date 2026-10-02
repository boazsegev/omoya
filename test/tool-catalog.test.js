import { describe, expect, test } from "bun:test";
import { toolCatalogText } from "../lib/app/shared/tool-catalog.js";
import { renderMarkdown } from "../lib/app/web/public/markdown.js";

const reader = {
  name: "read",
  description: "Read **files** and search their contents.\n\nSupports nested filters.",
  inputSchema: {
    type: "object",
    description: "Read arguments.",
    properties: { path: { type: "string", description: "File path." }, filter: { oneOf: [{ type: "null" }, { type: "object", properties: { pattern: { type: "string", examples: ["```"] } }, required: ["pattern"], additionalProperties: false }] } },
    required: ["path"],
    $defs: { mode: { type: "string", enum: ["text", "binary"] } },
    additionalProperties: false,
  },
  annotations: { title: "Read files" },
};
const writer = { name: "write", description: "Write a file.", inputSchema: { type: "object", properties: { content: { type: "string" } } } };

describe("published tool catalog Markdown", () => {
  test("renders Map entries as ordered headings, descriptions, and full per-tool JSON schemas", () => {
    const tools = new Map([[reader.name, reader], [writer.name, writer]]);
    const text = toolCatalogText(tools);
    expect(text).toStartWith("# Published tools (2)\n\n");
    expect(text).toContain(`## \`read\`\n\n${reader.description}\n\n\`\`\`json\n`);
    expect(text).toContain(`## \`write\`\n\n${writer.description}\n\n\`\`\`json\n`);
    expect(text.indexOf("## `read`")).toBeLessThan(text.indexOf("## `write`"));
    const schemas = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
    expect(schemas).toEqual([reader, writer]);
    expect(schemas.every((schema) => !Array.isArray(schema))).toBe(true);
    expect([...tools]).toEqual([[reader.name, reader], [writer.name, writer]]);
  });

  test("renders tool headings and prose as Markdown while retaining JSON code blocks", () => {
    const html = renderMarkdown(toolCatalogText(new Map([[reader.name, reader]])));
    expect(html).toContain("<h2><code>read</code></h2>");
    expect(html).toContain("<strong>files</strong>");
    expect(html).toContain("<pre");
    expect(html).toContain("inputSchema");
    expect(html).toContain("additionalProperties");
  });

  test("shows an explicit empty catalog without an array or a JSON code block", () => {
    const text = toolCatalogText(new Map());
    expect(text).toStartWith("# Published tools (0)");
    expect(text).toContain("No tools are currently published to this agent.");
    expect(text).not.toContain("```json");
    expect(text).not.toContain("[]");
  });

  test("includes a full schema even when the description is omitted", () => {
    const schema = { name: "minimal", inputSchema: { type: "object" } };
    const text = toolCatalogText(new Map([[schema.name, schema]]));
    expect(text).toContain("## `minimal`\n\n```json\n");
    expect(text).not.toContain("undefined");
    expect(JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1])).toEqual(schema);
  });
});
