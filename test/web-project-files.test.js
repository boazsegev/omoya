import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { projectFilePath, projectFiles } from "../lib/app/web/project-files.js";

test("project files contain paths, hide escaping links, preview only Markdown and refuse overwrite", async () => {
  await mkdir("ai-tmp", { recursive: true });
  const base = await mkdtemp("ai-tmp/files-test-");
  const root = `${base}/project`;
  await mkdir(root); await writeFile(`${root}/notes.md`, "# Hello"); await writeFile(`${root}/secret.txt`, "secret");
  await symlink(process.cwd(), `${root}/escape`);
  const url = new URL("http://localhost/files");
  try {
    await expect(projectFilePath(root, "../outside")).rejects.toThrow();
    await expect(projectFilePath(root, "escape")).rejects.toThrow();
    const listing = await (await projectFiles(new Request(url), root, "list", url)).json();
    expect(listing.entries.map((entry) => entry.name)).toEqual(["notes.md", "secret.txt"]);
    url.searchParams.set("path", "notes.md");
    expect((await (await projectFiles(new Request(url), root, "markdown", url)).json()).text).toBe("# Hello");
    url.searchParams.set("path", "secret.txt");
    await expect(projectFiles(new Request(url), root, "markdown", url)).rejects.toThrow("Only Markdown");
    const form = new FormData(); form.set("path", ""); form.set("file", new File(["changed"], "notes.md"));
    expect((await projectFiles(new Request(url, { method: "POST", body: form }), root, "upload", url)).status).toBe(409);
    form.set("replace", "true");
    expect((await projectFiles(new Request(url, { method: "POST", body: form }), root, "upload", url)).status).toBe(200);
    const createFolder = (name, path = "") => projectFiles(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, name }) }), root, "mkdir", url);
    expect((await createFolder("nested")).status).toBe(201);
    expect((await createFolder("child", "nested")).status).toBe(201);
    expect((await createFolder("nested")).status).toBe(409);
    await expect(createFolder("../outside")).rejects.toThrow("folder name");
    await expect(createFolder("bad\\\\name")).rejects.toThrow("folder name");
    await expect(createFolder("escaped", "escape")).rejects.toThrow("outside");
    form.set("file", new File(["new"], "new.txt"));
    expect((await projectFiles(new Request(url, { method: "POST", body: form }), root, "upload", url)).status).toBe(200);
  } finally { await rm(base, { recursive: true, force: true }); }
});
