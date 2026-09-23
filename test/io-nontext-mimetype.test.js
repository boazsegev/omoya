import { describe, expect, test } from "bun:test";
import Context from "../lib/context.js";
import { context2msg as openaiContext2msg } from "../lib/env/openai.js";
import KimiProvider from "../providers/kimi.js";
import AnthropicProvider from "../providers/anthropic.js";
import OllamaProvider from "../providers/ollama.js";

const binary = (mimetype, content = "QUJD") => ({
  type: Context.ContentType.Binary, mimetype, content,
});
const user = (block) => ({ type: Context.MessageType.User, content: [block] });
const io = { currentModel: "model", settings: {}, tools: () => [] };

describe("non-text context mimetype contract", () => {
  test("mimetype is a public content field and survives context edits", () => {
    const block = binary("image/webp");
    expect(Context.mimetypeOf(block)).toBe("image/webp");
    const context = [user(block)];
    Context.editBlock(context, 0, 0, block);
    expect(context[0].content[0]).toEqual(block);
  });

  test("Ollama sends every attachment through its documented images channel and labels non-images", () => {
    const context = [{ type: Context.MessageType.User, content: [
      { type: "text", text: "inspect" },
      { type: "binary", mimetype: "application/pdf", filename: "report.pdf", content: "UEZERg==" },
      binary("image/webp"),
    ] }];
    const [, ollama] = new OllamaProvider("https://example.test", io).context2msg(context, io);
    expect(ollama.messages[0]).toMatchObject({ content: "inspect\n[report.pdf]", images: ["UEZERg==", "QUJD"] });
  });

  test("public provider translators map mimetype without treating it as metadata", () => {
    const context = [user(binary("image/webp"))];
    const [, openai] = openaiContext2msg.call({}, context, io);
    const [, kimi] = new KimiProvider("https://example.test", io).context2msg(context, io);
    const [, anthropic] = new AnthropicProvider("https://example.test", io).context2msg(context, io);
    const [, ollama] = new OllamaProvider("https://example.test", io).context2msg(context, io);

    expect(openai.input[0].content[0].image_url).toContain("data:image/webp;base64,QUJD");
    expect(kimi.messages[0].content[0].image_url.url).toContain("data:image/webp;base64,QUJD");
    expect(anthropic.messages[0].content[0].source.media_type).toBe("image/webp");
    expect(ollama.messages[0].images).toEqual(["QUJD"]);
  });
});
