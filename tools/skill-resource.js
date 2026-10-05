/** Read registered skill resources or copy exact bytes to a new project file. */
import { mkdir, open, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import Env from "../lib/env.js";
import { resolveCwdPath, rejectSymlinkPath, relativeCwdPath } from "./guard/resolve.js";
import { enforceContentPolicy } from "./guard/paths.js";

const MAX_TEXT_BYTES = 128 * 1024;

function resourceText(bytes) {
  if (bytes.length > MAX_TEXT_BYTES) throw new Error("Resource text exceeds 128 KiB; specify target to save the complete file");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("binary");
    return text;
  } catch { throw new Error("Resource is binary; specify target to save its exact bytes"); }
}

async function createTarget(path, bytes, context) {
  const cwd = context?.agent?.folder ?? context?.env?.cwd ?? process.cwd();
  const file = await rejectSymlinkPath(resolveCwdPath(path, { cwd }), { cwd });
  await enforceContentPolicy({ path, content: bytes.toString("utf8"), context, cwd, lax: true });
  await mkdir(dirname(file), { recursive: true });
  await rejectSymlinkPath(file, { cwd });
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { await handle.writeFile(bytes); }
  catch (error) { await unlink(file).catch(() => {}); throw error; }
  finally { await handle.close(); }
  return relativeCwdPath(path, { cwd });
}

async function saveTarget(target, bytes, context) {
  try { target = await createTarget(target, bytes, context); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Resource target already exists; choose a new project filename");
    if (error.code) throw new Error("Resource target could not be written");
    throw new Error(error.message.includes("symbolic") ? "Resource target symbolic links are refused" : error.message);
  }
  return `Saved skill resource to ${target}`;
}

/**
 * Read bounded UTF-8 text or export exact bytes (up to 16 MiB). Target is relative
 * to the agent folder, confined to that folder, and must not exist. Creates parents.
 * Safe mode permits reads only. Never activates or executes a resource.
 * @param {{name: string, path?: string, target?: string}} args Skill, optional resource identifier, and optional new project filename.
 * @param {object} context Env, safe flag, agent folder, and question capabilities.
 * @returns {Promise<string|string[]>} Resource identifiers when path is omitted, text, or saved-file confirmation.
 * @throws {Error} Missing/invalid/unreadable resource, size limit, unsafe target,
 * existing target, safe-mode save, or content-policy refusal. Fix input before
 * retrying; an existing target is never overwritten by a repeated export.
 */
export async function skillResource({ name, path, target } = {}, context) {
  if (target !== undefined && context?.safe === true) throw new Error("skill-resource: saving is unavailable in safe mode");
  if (path === undefined && target !== undefined) throw new TypeError("Resource path is required when saving a target");
  const run = async (env) => {
    if (path === undefined) return await env.skillResource(name);
    const bytes = await env.skillResource(name, path);
    return target === undefined ? resourceText(bytes) : await saveTarget(target, bytes, context ?? { env });
  };
  // Without an Agent's Env, the root folder's Env answers (Env.use).
  return context?.env ? run(context.env) : Env.use("/", run);
}

export function toolDescription() {
  return { "skill-resource": {
    fn: skillResource,
    safe: true,
    readOnly: (args) => args.target === undefined,
    trusted: true,
    description: "Access a skill's supporting files without loading or executing them. Supply name to list resources, add path to read one, or add path and target to save its exact bytes to a new file inside the Agent folder. Saving is available only if `write` is available.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Skill name from the skill catalog." },
      path: { type: "string", description: "Resource filename relative to the skill, e.g. examples/build.js. Omit to list resources. Do not use parent traversal or symlinks." },
      target: { type: "string", description: "Optional project filename/path to save exact bytes (up to 16 MiB); creates parents, refuses existing files. Omit to read UTF-8 text up to 128 KiB." },
    }, required: ["name"] },
  } };
}
