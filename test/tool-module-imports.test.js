// Tool modules must import in a fresh process, without a pre-initialized Env.
import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";

function modulesIn(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return modulesIn(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  });
}

describe("shipped tool modules import independently on the current API", () => {
  for (const file of modulesIn("tools")) {
    it(`${file} needs no prior library initialization`, async () => {
      const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(`./${file}`)});`], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env },
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit, stderr).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    });
  }
});
