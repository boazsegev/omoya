import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { read } from "../tools/read/read.js";
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

const ROOT = `ai-tmp/read-images-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const name = Buffer.from(type);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([header, name, bytes, checksum]);
}

// A valid PNG exceeding the read tool's 64 KiB text-output budget.
function largePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("tEXt", Buffer.from(`Comment\0${"x".repeat(70 * 1024)}`)),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function setup(filename, bytes, settings = {}) {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(`${ROOT}/${filename}`, bytes);
  return { env: { cwd: ROOT, settings } };
}

function attachments(output) {
  return Array.isArray(output) ? output.filter((block) => block.type === "binary" || block.type === "image") : [];
}

function text(output) {
  return typeof output === "string" ? output : output.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function imageData(name, body) {
  if (name === "OpenAI") return body.input.flatMap((item) => item.output ?? item.content ?? [])
    .find((part) => part.type === "input_image").image_url.split(",")[1];
  if (name === "Kimi") return body.messages.flatMap((message) => message.content)
    .find((part) => part?.type === "image_url").image_url.url.split(",")[1];
  return body.messages.flatMap((message) => message.content)
    .flatMap((part) => part.type === "tool_result" ? part.content : [part])
    .find((part) => part.type === "image").source.data;
}

describe("read image integrity", () => {
  for (const filename of ["shot.png", "capture.unknown"]) {
    it(`returns complete ${filename} image bytes above the text output budget`, async () => {
      const bytes = largePng();
      const ctx = setup(filename, bytes);
      const output = await read({ path: filename, binary: true, annotate: false }, ctx);
      const image = attachments(output)[0];
      expect(image?.mime).toBe("image/png");
      expect(Buffer.from(image?.content ?? "", "base64").equals(bytes)).toBe(true);
    });
  }

  it("does not expose truncated bytes as an image when the file budget is exceeded", async () => {
    const ctx = setup("shot.png", largePng(), { read: { fileBytes: 32 } });
    const output = await read({ path: "shot.png", binary: true, annotate: false }, ctx);
    expect(attachments(output)).toHaveLength(0);
    expect(text(output)).toMatch(/image.*not sent|image.*omitted/i);
  });

  it("does not expose an empty image file as a vision block", async () => {
    const ctx = setup("empty.png", Buffer.alloc(0));
    const output = await read({ path: "empty.png", binary: true, annotate: false }, ctx);
    expect(attachments(output)).toHaveLength(0);
    expect(text(output)).toContain("image not sent: empty or incomplete file");
  });

  it("does not expose a byte range as a complete image", async () => {
    const ctx = setup("shot.png", largePng());
    const output = await read({ path: "shot.png", binary: true, bytes: { from: 0, to: 32 }, annotate: false }, ctx);
    expect(attachments(output)).toHaveLength(0);
    expect(text(output)).toMatch(/image.*not sent|image.*omitted/i);
  });

  it("preserves byte inspection and target copies for deliberate image ranges", async () => {
    const bytes = largePng();
    const ctx = setup("shot.png", bytes);
    const output = await read({ path: "shot.png", binary: true, base64: true, bytes: { to: 32 }, annotate: false }, ctx);
    expect(Buffer.from(output, "base64").equals(bytes.subarray(0, 32))).toBe(true);
    await read({ path: "shot.png", binary: true, bytes: { to: 32 }, target: "header.bin" }, ctx);
    expect(Buffer.from(await Bun.file(`${ROOT}/header.bin`).arrayBuffer()).equals(bytes.subarray(0, 32))).toBe(true);
  });

  it("omits images after scan-budget interruption without corrupting the context", async () => {
    const ctx = setup("shot.png", largePng(), { read: { scanBytes: 32 } });
    const output = await read({ path: "shot.png", binary: true }, ctx);
    expect(attachments(output)).toHaveLength(0);
    expect(text(output)).toContain("scanBytes budget exhausted");
  });

  it("sends complete bytes to every remote provider for user and tool messages", async () => {
    const bytes = largePng();
    const ctx = setup("shot.png", bytes);
    const content = await read({ path: "shot.png", binary: true, annotate: false }, ctx);
    const serialized = JSON.stringify(content);
    for (const [name, wire] of codecs) {
      const user = wire([{ type: 2, content }]);
      const tool = wire([
        { type: 3, content: [{ type: "toolCall", callId: "shot", name: "read", arguments: {} }] },
        { type: 4, callId: "shot", name: "read", content },
      ]);
      for (const body of [user, tool]) {
        expect(Buffer.from(imageData(name, body), "base64").equals(bytes)).toBe(true);
      }
    }
    expect(JSON.stringify(content)).toBe(serialized);
  });
});
