// test/io-root-record.test.js — IO.write takes the Context and keeps its
// "io-root" record (qualified model + tool-definition hash) current, so a
// model or tool change shows as context.dirty while the provider builds
// the request.
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Context } from "../lib/context.js";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";
import TestPlugin from "../providers/test.js";
import { providerAdd, toolsLoad } from "./env-internals.js";
import { providerClass } from "./fakes.js";

const TestProvider = await providerClass(TestPlugin, "test");


async function env() {
  const root = mkdtempSync("./ai-tmp/io-root-env-");
  const value = await Env.open(root, { dir: root, settings: { providers: { test: { provider: "test", url: "test://script", secret: true } } }, init: { providers: false, tools: false, detect: false, models: false } });
  providerAdd(value, "test", TestPlugin);
  await toolsLoad(value, { dirs: ["./tools"] });
  return value;
}

/** An IO whose provider records context.dirty when it builds each request. */
async function io(model) {
  const seen = [];
  const environment = await env();
  environment.settings.providers.test.script = [[{ text: "ok" }]];
  const aiio = new IO({ env: environment, model });
  aiio.Provider = class extends TestProvider {
    context2msg(context, current) {
      seen.push(current.context.dirty);
      return super.context2msg(context, current);
    }
  };
  return { aiio, seen };
}

const user = (text) => ({ type: 2, content: [{ type: "text", text }] });

describe("IO root record", () => {
  test("write requires a Context and never sends the record", async () => {
    const { aiio } = await io("test/test-model");
    await expect(aiio.write([user("hi")])).rejects.toThrow(/must be a Context/);
    const context = new Context({ messages: [user("hi")] });
    const terminal = await aiio.write(context);
    expect(terminal.type).toBe("done");
    expect(context.at(0)).toMatchObject({ type: "io-root", model: "test/test-model" });
    expect(context.at(0).tools).toMatch(/^[0-9a-f]{32}$/);
    expect(aiio.context).toBeNull();
  });


});
