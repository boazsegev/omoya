import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const runtimeFiles = ["tools/read/read.js", "tools/read/grep.js", "tools/edit.js", "tools/write.js", "tools/guard/symlinks.js", "tools/guard/paths.js"];
for (const file of runtimeFiles) {
  test(`${file} does not perform blocking filesystem calls during a tool invocation`, async () => {
    const source = await readFile(file, "utf8");
    expect(source).not.toMatch(/\b(?:readFileSync|writeFileSync|readdirSync|statSync|lstatSync|mkdirSync|realpathSync|existsSync)\s*\(/);
  });
}
