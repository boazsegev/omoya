import { describe, it, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findDeadLib } from "../ai-tools/ai-dead-lib.js";

async function fixture(files, check) {
  await mkdir("ai-tmp", { recursive: true });
  const root = await mkdtemp("ai-tmp/dead-lib-");
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(root, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text);
    }
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("dead lib detector", () => {
  it("follows static, re-export, dynamic literal and worker URL edges but not comments", async () => {
    await fixture({
      "lib/index.js": 'export * from "./live.js"; import("./lazy.js"); new URL(' + '"./worker.js", import.meta.url);',
      "lib/live.js": 'import "./deep/child.js";',
      "lib/lazy.js": "",
      "lib/worker.js": "",
      "lib/deep/child.js": "",
      "lib/deep/dead.js": '// import "../live.js"',
      "lib/orphan/deep.js": "",
    }, async (root) => {
      expect((await findDeadLib(root)).dead).toEqual(["lib/deep/dead.js", "lib/orphan/deep.js"]);
    });
  });

  it("reports tool imports without treating tools as root modules", async () => {
    await fixture({
      "lib/index.js": "",
      "lib/private/dead.js": "",
      "tools/scan.js": 'import "../lib/private/dead.js";',
      "ai-tools/probe.js": 'import "../lib/private/dead.js";',
    }, async (root) => {
      expect(await findDeadLib(root)).toEqual({
        dead: ["lib/private/dead.js"],
        warnings: [
          { tool: "ai-tools/probe.js", module: "lib/private/dead.js" },
          { tool: "tools/scan.js", module: "lib/private/dead.js" },
        ],
      });
    });
  });

  it("keeps the independently served browser app and its imports alive", async () => {
    await fixture({
      "lib/index.js": "",
      "lib/app/web/public/app.js": 'import "./view.js";',
      "lib/app/web/public/view.js": "",
      "lib/app/web/public/dead.js": "",
    }, async (root) => {
      expect((await findDeadLib(root)).dead).toEqual(["lib/app/web/public/dead.js"]);
    });
  });
});
