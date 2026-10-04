/** Isolated filesystem fault/counter fixture; never prints host paths. */
import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const root = `./ai-tmp/read-fs-fixture-${process.pid}`;
const mode = process.argv[2];
const operation = mode.replace("write-", "").replace("auxiliary", "open");
mkdirSync(`${root}/sub`, { recursive: true });
writeFileSync(`${root}/sub/README.md`, "hit\n");
writeFileSync(`${root}/sub/other.txt`, "miss\n");
writeFileSync(`${root}/saved.txt`, "unchanged");
if (mode === "auxiliary") writeFileSync(`${root}/sub/.ignore`, "*.txt\n");
if (mode === "bulk-count") writeFileSync(`${root}/large.txt`, "ordinary text\n".repeat(150000));
function fault(path, syscall) {
  const error = new Error(`ETIMEDOUT: connection timed out, ${syscall} '${path}'`);
  Object.assign(error, { code: "ETIMEDOUT", syscall, path });
  return error;
}
const counters = {};
for (const name of ["lstat", "open", "opendir"]) {
  const original = fs[name];
  spyOn(fs, name).mockImplementation(async (...args) => {
    counters[name] = (counters[name] ?? 0) + 1;
    const suffix = mode === "auxiliary" ? "/sub/.ignore" : operation === "open" ? "README.md" : "/sub";
    if (operation === name && String(args[0]).endsWith(suffix)) throw fault(args[0], name === "opendir" ? "scandir" : name);
    const value = await original(...args);
    if (name === "open") {
      const read = value.read.bind(value);
      spyOn(value, "read").mockImplementation(async (...params) => {
        counters.read = (counters.read ?? 0) + 1;
        if (operation === "read") throw fault(args[0], "read");
        return await read(...params);
      });
    }
    return value;
  });
}
try {
  const { read } = await import("../tools/read/read.js");
  const { executeReadQuery } = await import("../tools/read/engine.js");
  const { write } = await import("../tools/write.js");
  const ctx = { env: { cwd: root, settings: {} } };
  if (["count", "bulk-count"].includes(mode)) {
    await executeReadQuery(mode === "count" ? { path: "", recursive: true, glob: ["**/README.md"], info: true }
      : { path: "large.txt", search: { text: "absent" } }, ctx);
    console.log(JSON.stringify(counters));
  } else {
    try {
      const query = mode !== "auxiliary" && ["open", "read"].includes(operation) ? { path: "sub/README.md" } : { path: "", recursive: true, glob: "**/README.md", info: true, ignore: mode === "auxiliary" };
      if (mode.startsWith("write-")) await write({ path: "saved.txt", source: query }, ctx);
      else await read(query, ctx);
      throw new Error("injected failure did not occur");
    } catch (error) {
      console.log(JSON.stringify({ leaked: JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(error).map((key) => [key, error[key]]))).includes(resolve(root)),
        message: error.message.replaceAll(resolve(root), "[HOST ROOT]"), code: error.code, relativePath: error.path && !String(error.path).startsWith("/") }));
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
