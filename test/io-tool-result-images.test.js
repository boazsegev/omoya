import { describe, it, expect } from "bun:test";
import Context from "../lib/context.js";
import { context2msg as openaiWire } from "../lib/io/openai.js";
import { providerClass } from "./fakes.js";
import Anthropic from "../providers/anthropic.js";
import Claude from "../providers/claude.js";
import Kimi from "../providers/kimi.js";
import Ollama from "../providers/ollama.js";

const { MessageType: M, ContentType: C } = Context;
const image = { type: C.Binary, mimetype: "image/png", filename: "capture.png", content: "aGVsbG8=" };
const call = (id) => ({ type: C.ToolCall, callId: id, name: "read", arguments: {} });
const context = (blocks = [image], calls = ["one"]) => [
  { type: M.Assistant, content: calls.map(call) },
  ...calls.map((id, index) => ({ type: M.ToolResult, callId: id, name: "read", content: index ? [{ type: C.Text, text: "ok" }] : blocks })),
];
const io = (input) => ({ modelCurrent: "test/example", settings: { ...(input ? { models: { example: { input } } } : {}), auth: { type: "oauth", token: "sk-ant-oat-test" } }, tools: () => [] });
const protocols = [
  ["anthropic", Anthropic, "https://api.anthropic.com/v1"],
  ["claude", Claude, "https://api.anthropic.com/v1"],
  ["kimi", Kimi, "https://api.moonshot.ai/v1"],
  ["ollama", Ollama, "http://localhost:11434"],
];

for (const [label, Plugin, url] of protocols) {
  const Protocol = await providerClass(Plugin, label);
  const wire = (messages, input) => new Protocol(url, io(input)).context2msg(messages, io(input))[1].messages;
  describe(`${label} tool result images`, () => {
    it("preserves an image in the documented wire shape after the tool call", () => {
      const messages = wire(context(), undefined);
      if (label === "anthropic" || label === "claude") {
        expect(messages[1].content[0].content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: image.content } }]);
      } else if (label === "ollama") {
        expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
        expect(messages[1].images).toBeUndefined();
        expect(messages[2].images).toEqual([image.content]);
      } else {
        expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
        expect(messages[2].content).toEqual([{ type: "text", text: "Image or file from read (one):" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.content}` } }]);
      }
    });
    it("preserves supported document files instead of dropping them", () => {
      const file = { type: C.Binary, mimetype: "application/pdf", filename: "report.pdf", content: "aGVsbG8=" };
      const messages = wire(context([file]));
      if (label === "anthropic" || label === "claude") {
        expect(messages[1].content[0].content).toEqual([{
          type: "document", source: { type: "base64", media_type: "application/pdf", data: file.content },
        }]);
      } else if (label === "kimi") {
        expect(messages[2].content[1]).toEqual({ type: "file", file: {
          data: file.content, mimetype: "application/pdf", filename: "report.pdf",
        } });
      } else {
        expect(messages[2].images).toEqual([file.content]);
        expect(messages[2].content).toContain("[report.pdf]");
      }
    });
    it("does not change text-only results", () => {
      const messages = wire(context([{ type: C.Text, text: "ok" }]), undefined);
      expect(messages.length).toBe(2);
      expect(JSON.stringify(messages[1])).toContain("ok");
    });
    it("replaces images for known text-only models; unknown capability sends them", () => {
      const messages = wire(context(), ["text"]);
      expect(JSON.stringify(messages)).toContain("[image: image/png, 5 bytes — not sent: model has no image input]");
      expect(JSON.stringify(messages)).not.toContain(image.content);
      expect(JSON.stringify(wire(context(), undefined))).toContain(image.content);
    });
    it("keeps multiple tool answers contiguous before a follow-up user image", () => {
      if (label !== "kimi" && label !== "ollama") return;
      expect(wire(context([image], ["one", "two"])).map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"]);
    });
  });
}

describe("OpenAI Responses tool result images", () => {
  const wire = (messages, input) => openaiWire(messages, io(input))[1].input;
  it("uses function_call_output content arrays for image and file, preserving block order", () => {
    const blocks = [{ type: C.Text, text: "first" }, image, { type: C.Binary, mimetype: "application/pdf", filename: "a.pdf", content: "aGVsbG8=" }];
    expect(wire(context(blocks))[1].output).toEqual([
      { type: "input_text", text: "first" },
      { type: "input_image", image_url: `data:image/png;base64,${image.content}` },
      { type: "input_file", file_data: "data:application/pdf;base64,aGVsbG8=", filename: "a.pdf" },
    ]);
  });
  it("leaves text-only output a string and notes text-only models; unknown sends", () => {
    expect(wire(context([{ type: C.Text, text: "ok" }]))[1].output).toBe("ok");
    expect(wire(context(), ["text"])[1].output).toBe("[image: image/png, 5 bytes — not sent: model has no image input]");
    expect(wire(context())[1].output[0].type).toBe("input_image");
  });
});
