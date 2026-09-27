import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Agent from "../lib/agent.js";
import Env from "../lib/env.js";

describe("Agent.sendFile", () => {
  test("reads an existing file and assigns the extension MIME type", async () => {
    const dir = await mkdtemp("./ai-tmp/enqueue-file-");
    await writeFile(join(dir, "sample.pdf"), "%PDF-test");
    const agent = new Agent({ env: new Env({ cwd: dir, dir, settings: {} }), createIO: () => ({}) });
    agent.run = async () => ({ type: "done" });
    const terminal = await agent.sendFile("sample.pdf");
    const message = agent.context.at(-1);
    expect(terminal.type).toBe("done");
    expect(message.content[0]).toMatchObject({ type: "binary", mimetype: "application/pdf" });
    expect(Buffer.from(message.content[0].content, "base64").toString()).toBe("%PDF-test");
  });

  test("fails for a missing file without queueing", async () => {
    const dir = await mkdtemp("./ai-tmp/enqueue-file-");
    const agent = new Agent({ env: new Env({ cwd: dir, dir, settings: {} }) });
    await expect(agent.sendFile("missing.pdf")).rejects.toThrow();
    expect(agent.pending).toEqual([]);
  });

  test("uses the same Agent path boundary for attachment and tool paths", async () => {
    const dir = await mkdtemp("./ai-tmp/enqueue-file-");
    await writeFile(join(dir, "photo.webp"), "RIFF");
    const agent = new Agent({ env: new Env({ cwd: dir, dir, settings: {} }) });
    await expect(agent.pathInfo("../outside")).rejects.toThrow(/path traversal refused/);
    expect(await agent.pathInfo("photo.webp")).toEqual({ path: "./photo.webp", isFolder: false, mimetype: "image/webp" });
  });
});
