import { describe, it, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Agent from "../lib/agent.js";
import { context2msg as openaiWire } from "../lib/io/openai.js";
import Anthropic from "../providers/anthropic.js";
import { providerClass, scriptedIO, testEnv, TOOLCALL, TEXT, USER } from "./fakes.js";
import { toolsLoad } from "./env-internals.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pN8AAAAASUVORK5CYII=";
const PATH = "small.png";
const AnthropicProtocol = await providerClass(Anthropic, "anthropic");
const ioShape = { modelCurrent: "test/visual", settings: { auth: { type: "api_key", token: "test" } }, tools: () => [] };

const adapters = [
  ["OpenAI Responses", (context) => openaiWire(context, ioShape)[1].input, (wire) => {
    const output = wire.find((item) => item.type === "function_call_output").output;
    expect(output).toContainEqual({ type: "input_image", image_url: `data:image/png;base64,${PNG}` });
  }],
  ["Anthropic", (context) => new AnthropicProtocol("https://api.anthropic.com/v1", ioShape).context2msg(context, ioShape)[1].messages, (wire) => {
    const result = wire.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((block) => block.type === "tool_result");
    expect(result.content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } });
  }],
];

describe("scripted agent read PNG → next provider wire", () => {
  for (const [provider, serialize, assertImage] of adapters) {
    it(`sends the PNG read result to ${provider}`, async () => {
      mkdirSync("ai-tmp/visual", { recursive: true });
      const env = await testEnv();
      writeFileSync(join(env.cwd, PATH), Buffer.from(PNG, "base64"));
      await toolsLoad(env, { dirs: ["./tools"] });
      const io = scriptedIO([TOOLCALL(0, "shot", "read", { path: PATH, binary: true, annotate: false }), TEXT(0, "I saw it")]);
      const requestWires = [];
      const write = io.write.bind(io);
      io.write = async (context, callbacks, options) => {
        requestWires.push(serialize(context));
        return write(context, callbacks, options);
      };
      const agent = new Agent({ env, model: "test/visual", context: [USER("inspect the screenshot")], createIO: () => io });
      try {
        expect((await agent.run()).type).toBe("done");
        expect(requestWires).toHaveLength(2);
        expect(agent.context.messages().find((message) => message.type === 4)?.content).toEqual([{ type: "binary", mime: "image/png", content: PNG }]);
        assertImage(requestWires[1]);
      } finally {
        await agent.close();
        await env.close();
        rmSync(join(env.cwd, PATH), { force: true });
      }
    });
  }
});
