import { describe, expect, test } from "bun:test";
import { toolDescription as skillDescription } from "../tools/skill.js";
import { readQuerySchema } from "../tools/read/query.js";
import { readDescription } from "../tools/read/read.js";
import { toolDescription as writeDescription } from "../tools/write.js";
import { toolDescription as resourceDescription } from "../tools/skill-resource.js";
import { toolDescription as webDescription } from "../tools/web.js";
import { toolDescription as workerDescription } from "../tools/worker-create.js";
import { toolDescription as jobDescription } from "../tools/job-schedule.js";
import { toolDescription as noteDescription } from "../tools/note.js";
import { Env } from "../lib/env.js";
import { providerClass } from "./fakes.js";
import Anthropic from "../providers/anthropic.js";
import Kimi from "../providers/kimi.js";
import Ollama from "../providers/ollama.js";
import OpenAI from "../providers/openai.js";

function visitSchema(schema, inspect) {
  inspect(schema);
  for (const child of Object.values(schema.properties ?? {})) visitSchema(child, inspect);
  if (schema.items) visitSchema(schema.items, inspect);
  if (typeof schema.additionalProperties === "object") visitSchema(schema.additionalProperties, inspect);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    for (const child of schema[keyword] ?? []) visitSchema(child, inspect);
  }
}

function expectOperativeSchema(schema) {
  visitSchema(schema, (node) => {
    expect(node.description ?? "").not.toMatch(/filler|wrong.type|reinjection|round.trip|env\.cwd|isolated execution/i);
    for (const keyword of ["anyOf", "oneOf", "allOf", "not"]) expect(node[keyword]).toBeUndefined();
    expect(Array.isArray(node.type)).toBe(false);
  });
}

describe("intended model-facing tool inputs", () => {
  test("skill advertises arrays of names and omission for discovery", () => {
    const { description, inputSchema } = skillDescription().skill;
    expect(description).toMatch(/relevant/i);
    expect(description).toMatch(/omit/i);
    expect(description).not.toMatch(/atomic|disk edits|reloading/i);
    expect(inputSchema.additionalProperties).toBe(false);
    expect(inputSchema.required ?? []).not.toContain("names");
    expect(inputSchema.properties.names.type).toBe("array");
    expect(inputSchema.properties.names.items.type).toBe("string");
    expect(inputSchema.properties.names.anyOf).toBeUndefined();
    expectOperativeSchema(inputSchema);
  });

  test("read publishes only intended types, defaults and useful alternatives", () => {
    const schema = readQuerySchema();
    expect(schema).toEqual(readDescription().inputSchema);
    expectOperativeSchema(schema);
    for (const name of ["recursive", "ignore", "info", "annotate", "binary", "base64"]) {
      expect(schema.properties[name].type).toBe("boolean");
      expect(schema.properties[name].default).toBe(name === "annotate");
      expect(schema.properties[name].anyOf).toBeUndefined();
    }
    for (const name of ["lines", "characters", "bytes", "search"]) {
      expect(schema.properties[name].type).toBe("object");
    }
    for (const name of ["glob", "exclude"]) {
      expect(schema.properties[name].type).toBeUndefined();
      expect(schema.properties[name].items.type).toBe("string");
      expect(schema.properties[name].description).toMatch(/glob.*array/);
    }
    expect(schema.properties.lines.properties.from.type).toBe("integer");
    expect(schema.properties.lines.description).toContain("1-based");
    expect(schema.properties.target.type).toBe("string");
    expect(schema.properties.target.description).toMatch(/only if `write` is available/);
    expect(readDescription().readOnly({ path: "a" })).toBe(true);
    expect(readDescription().readOnly({ path: "a", target: "" })).toBe(true);
    expect(readDescription().readOnly({ path: "a", target: "b" })).toBe(false);
    expect(schema.properties.lines.properties.last.minimum).toBe(0);
    expect(schema.properties.characters.properties.from.type).toBe("integer");
    expect(schema.properties.search.properties.text.type).toBe("string");
    expect(schema.properties.search.properties.before.maximum).toBe(1000);
    expect(schema.properties.limit.minimum).toBe(0);
    expect(schema.properties.offset.minimum).toBe(0);
  });

  test("write takes text only; copying belongs to read.target", () => {
    const { description, inputSchema } = writeDescription().write;
    expect(description).not.toMatch(/round.trip|budget|effective/i);
    expect(description).toMatch(/read with target/);
    expectOperativeSchema(inputSchema);
    expect(inputSchema.required).toEqual(["path", "content"]);
    expect(Object.keys(inputSchema.properties)).toEqual(["path", "content", "ask"]);
    expect(inputSchema.properties.content.type).toBe("string");
    expect(inputSchema.properties.content.minLength).toBeUndefined();
    expect(inputSchema.properties.ask.type).toBe("boolean");
  });

  test("remaining tools describe caller choices without exposing recovery or registry internals", () => {
    const limit = webDescription({ settings: { web: { readability: false } } })["web-search"].inputSchema.properties.limit;
    expect(limit.minimum).toBe(1);
    expect(limit.maximum).toBe(40);
    expect(limit.default).toBe(40);
    expect(limit.description).not.toMatch(/zero|negative|absolute/i);
    expect(resourceDescription()["skill-resource"].description).not.toMatch(/layer/i);
    expectOperativeSchema(workerDescription()["worker-create"].inputSchema);
    const jobs = jobDescription()["job-schedule"];
    expect(jobs.description).not.toMatch(/admission|daemon|operational/i);
    expect(jobs.inputSchema.properties.action.description).not.toMatch(/replaces complete/i);
    expect(jobs.inputSchema.properties.schedule.type).toBeUndefined();
    expect(jobs.inputSchema.properties.schedule.properties.at.type).toBe("array");
    expect(jobs.inputSchema.properties.schedule.description).toMatch(/exactly one/);
    const notes = noteDescription().note;
    expect(notes.description.length).toBeLessThan(450);
    expect(notes.inputSchema.properties.notes.type).toBeUndefined();
    expect(notes.inputSchema.properties.notes.additionalProperties.description).toContain("null patch");
    expect(notes.inputSchema.properties.max.type).toBe("integer");
  });

  test("all package tool schemas avoid combinators and document every input field", async () => {
    const env = await Env.create({ settingsDir: null, settings: { mcp: { fixture: { command: "bun" } } } }, { providers: false, models: false });
    try {
      const tools = await env.tools();
      expect(tools.has("mcp")).toBe(true);
      expect(tools.has("tool-refresh")).toBe(true);
      expect(tools.size).toBeGreaterThan(15);
      for (const tool of tools.values()) {
        const { inputSchema, description } = tool.schema;
        expect(description.length).toBeGreaterThan(0);
        expectOperativeSchema(inputSchema);
        visitSchema(inputSchema, (node) => {
          for (const [name, field] of Object.entries(node.properties ?? {})) {
            if (!field.description) throw new Error(`${tool.name}.${name} needs an input description`);
          }
          expect(node.maxItems).not.toBe(0);
          expect(node.const).not.toBe("");
          for (const keyword of ["anyOf", "oneOf"]) expect(node[keyword]).toBeUndefined();
        });
      }
      const descriptors = [...tools].map(([name, tool]) => ({ name, ...tool.schema }));
      for (const [name, Plugin] of [["anthropic", Anthropic], ["kimi", Kimi], ["ollama", Ollama], ["openai", OpenAI]]) {
        const Protocol = await providerClass(Plugin, name);
        const io = { modelCurrent: "test/m", settings: {}, tools: () => descriptors };
        const connection = new Protocol("https://example.test/v1", io);
        const [, body] = connection.context2msg([]);
        const schemas = body.tools.map((tool) => tool.input_schema ?? tool.function?.parameters ?? tool.parameters);
        expect(schemas).toHaveLength(descriptors.length);
        schemas.forEach(expectOperativeSchema);
      }
    } finally { env.close(); }
  });
});
