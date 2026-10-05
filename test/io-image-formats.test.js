import { describe, expect, it } from "bun:test";
import Context from "../lib/context.js";
import { context2msg as openaiWire } from "../lib/io/openai.js";
import { providerClass } from "./fakes.js";
import Anthropic from "../providers/anthropic.js";
import Claude from "../providers/claude.js";
import Kimi from "../providers/kimi.js";

const io = { modelCurrent: "test/vision", settings: { auth: { type: "oauth", token: "test" } }, tools: () => [] };
const codecs = [["OpenAI", (messages) => openaiWire(messages, io)[1]]];
for (const [name, Plugin] of [["Anthropic", Anthropic], ["Claude", Claude], ["Kimi", Kimi]]) {
  const Protocol = await providerClass(Plugin, name.toLowerCase());
  codecs.push([name, (messages) => new Protocol("https://provider.test/v1", io).context2msg(messages, io)[1]]);
}

function context(mime, role, type = "binary") {
  const block = { type, mimetype: mime, content: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>").toString("base64") };
  if (role === "user") return [{ type: Context.MessageType.User, content: [block] }];
  return [
    { type: Context.MessageType.Assistant, content: [{ type: "toolCall", callId: "shot", name: "read", arguments: {} }] },
    { type: Context.MessageType.ToolResult, callId: "shot", name: "read", content: [block] },
  ];
}

describe("provider image formats match official API contracts", () => {
  for (const [name, wire] of codecs) {
    for (const role of ["user", "tool result"]) {
      for (const type of ["binary", "image"]) {
        it(`${name} refuses unsupported SVG ${role} ${type} blocks before HTTP`, () => {
          expect(() => wire(context("image/svg+xml", role, type))).toThrow(/image\/svg\+xml.*convert|convert.*image\/svg\+xml/i);
        });
      }
    }
    it(`${name} leaves context unchanged on refusal`, () => {
      const messages = context("image/svg+xml", "tool result");
      const before = JSON.stringify(messages);
      try { wire(messages); } catch {}
      expect(JSON.stringify(messages)).toBe(before);
    });
    it(`${name} uses its documented format list, not every image MIME`, () => {
      const mime = name === "Kimi" ? "image/avif" : "image/bmp";
      expect(() => wire(context(mime, "user"))).toThrow(/convert/i);
    });
  }
  it("Kimi retains its additional documented BMP and HEIC inputs", () => {
    const wire = codecs.find(([name]) => name === "Kimi")[1];
    for (const mime of ["image/bmp", "image/heic", "image/heif"]) {
      expect(wire(context(mime, "user")).messages[0].content[0].image_url.url).toStartWith(`data:${mime};base64,`);
    }
  });
});
