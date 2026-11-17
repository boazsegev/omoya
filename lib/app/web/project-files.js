/** Project-scoped file browser. Never follows a link outside its project. */
import { realpath, readdir, stat, readFile, writeFile, lstat, open, mkdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, join, basename } from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:fs";

const markdown = (path) => /\.(md|markdown)$/i.test(path);
const limit = 10 * 1024 * 1024;
const inside = (root, path) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel); };
/** Resolve an existing project-relative path; reject traversal and escaping links. */
export async function projectFilePath(root, path = "") {
  root = await realpath(root);
  if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) throw new Error("Invalid project path");
  const target = await realpath(resolve(root, path));
  if (!inside(root, target)) throw new Error("Path is outside the project");
  return target;
}
/** Handle a validated project's file request. Inputs are not retained. */
export async function projectFiles(request, root, action, url) {
  const data = request.method === "POST" ? action === "upload" ? await request.formData() : await request.json() : null;
  const path = data instanceof FormData ? data.get("path") ?? "" : data?.path ?? url.searchParams.get("path") ?? "";
  const target = await projectFilePath(root, path);
  if (action === "list") {
    const entries = [];
    for (const item of await readdir(target, { withFileTypes: true })) {
      const child = join(path, item.name);
      try {
        const resolved = await projectFilePath(root, child);
        const info = await stat(resolved);
        if (info.isDirectory() || info.isFile()) entries.push({ name: item.name, path: child, directory: info.isDirectory(), markdown: info.isFile() && markdown(item.name) });
      } catch { /* inaccessible or outside project */ }
    }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return Response.json({ path, entries, revealSupported: ["darwin", "linux", "win32"].includes(process.platform) });
  }
  if (action === "markdown") {
    if (!markdown(target) || !(await stat(target)).isFile()) throw new Error("Only Markdown files can be previewed");
    if ((await stat(target)).size > limit) throw new Error("Markdown preview exceeds 10 MB");
    return Response.json({ name: basename(target), text: await readFile(target, "utf8") });
  }
  if (action === "mkdir") {
    const name = data?.name;
    if (typeof name !== "string" || !name.trim() || name !== name.trim() || name.length > 255 || /[\\/\x00-\x1f]/.test(name) || [".", ".."].includes(name) || isAbsolute(name)) throw new Error("Enter a folder name without path separators");
    if (!(await stat(target)).isDirectory()) throw new Error("Choose a destination folder");
    try { await mkdir(join(target, name)); }
    catch (error) { if (error.code === "EEXIST") return Response.json({ error: "A file or folder with this name already exists." }, { status: 409 }); throw error; }
    return Response.json({ path: join(path, name) }, { status: 201 });
  }
  if (action === "upload") {
    const file = data.get("file");
    if (!(file instanceof File) || !file.name || basename(file.name) !== file.name || /[\\/\0]/.test(file.name) || [".", ".."].includes(file.name)) throw new Error("Choose a file with a valid name");
    if (file.size > limit) throw new Error("Upload exceeds 10 MB");
    if (!(await stat(target)).isDirectory()) throw new Error("Choose a destination folder");
    const destination = join(target, file.name);
    // Create exclusively; replacement requires explicit confirmation and refuses symlinks.
    try { await writeFile(destination, new Uint8Array(await file.arrayBuffer()), { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (data.get("replace") !== "true") return Response.json({ error: "A file with this name already exists.", conflict: true }, { status: 409 });
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Cannot replace a folder or symbolic link");
      const handle = await open(destination, constants.O_WRONLY | constants.O_NOFOLLOW);
      try { await handle.truncate(0); await handle.writeFile(new Uint8Array(await file.arrayBuffer())); } finally { await handle.close(); }
    }
    return Response.json({ path: join(path, file.name) });
  }
  if (action === "reveal") {
    const directory = (await stat(target)).isDirectory();
    const command = process.platform === "darwin" ? ["open", directory ? [target] : ["-R", target]] : process.platform === "win32" ? ["explorer.exe", directory ? [target] : [`/select,${target}`]] : process.platform === "linux" ? ["xdg-open", [directory ? target : resolve(target, "..")]] : null;
    if (!command) throw new Error("Host file explorer is not supported");
    await new Promise((accept, reject) => { const child = spawn(command[0], command[1], { stdio: "ignore" }); child.once("error", reject); child.once("close", (code) => code === 0 ? accept() : reject(new Error("Could not open the host file explorer"))); });
    return Response.json({ opened: true });
  }
  throw new Error("Unknown file action");
}
