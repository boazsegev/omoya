import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import Env from "../lib/env.js";

for (const [label, folders] of [
  ["empty", { "": true }],
  ["unsafe", JSON.parse('{"__proto__":true}')],
]) {
  test(`Env.open rejects ${label} executable tool root before graph sanitization`, async () => {
    const cwd = mkdtempSync("ai-tmp/tool-root-invalid-");
    try {
      await expect(Env.open(cwd, { settingsDir: null, settings: { tools: { folders } } })).rejects.toThrow(/tools\.folders: invalid path preference/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
