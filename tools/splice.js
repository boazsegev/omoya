import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { toolRevision } from "../lib/tool-runtime.js";

const revision = toolRevision();
const { resolveCwdPath, relativeCwdPath } = await import(`./guard/resolve.js?now=${revision}`);
const { rejectSymlinkPath } = await import(`./guard/symlinks.js?now=${revision}`);
const { unifiedPatch, recordEdit } = await import(`./edit/diff.js?now=${revision}`);
const { queueEdit } = await import(`./edit/queue.js?now=${revision}`);

function linesOf(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineOffsets(text) {
  const lines = linesOf(text);
  const offsets = [0];
  for (let i = 0; i < lines.length; i++) offsets.push(offsets.at(-1) + lines[i].length + (i < lines.length - 1 || text.endsWith("\n") ? 1 : 0));
  return offsets;
}

function range(spec, offsets, { insert = false } = {}) {
  const count = offsets.length - 1;
  if (insert) {
    const hasRange = spec.from !== undefined || spec.to !== undefined;
    if (!Number.isSafeInteger(spec.at) || spec.at < 1 || spec.at > count + 1 ||
      (hasRange && (spec.from !== spec.at || spec.to !== spec.at))) {
      throw new RangeError("target.at must be a line position from 1 through line count + 1; from/to, if supplied, must both equal at.");
    }
    return { start: offsets[spec.at - 1], end: offsets[spec.at - 1] };
  }
  const { from, to } = spec;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > count || spec.at !== undefined) {
    throw new RangeError("from/to must be an existing 1-based inclusive line range; use target.at to insert.");
  }
  return { start: offsets[from - 1], end: offsets[to] };
}

/** Copy a source line range into a target line range. The source is unchanged; use edit-undo with the returned id to reverse. */
export async function splice(args = {}, context) {
  if (context?.safe === true) throw new Error("splice is unavailable in safe mode");
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !["source", "target"].includes(key))) {
    throw new TypeError("splice accepts only source and target.");
  }
  const { source, target } = args;
  if (!source || !target || typeof source !== "object" || typeof target !== "object" ||
    typeof source.path !== "string" || typeof target.path !== "string" ||
    source.path === "" || target.path === "") throw new TypeError("Give source and target paths and line ranges.");
  const cwd = context?.agent?.folder ?? context?.env?.folder ?? context?.agent?.env?.folder ?? process.cwd();
  const src = await rejectSymlinkPath(resolveCwdPath(source.path, { cwd }), { cwd });
  const dst = await rejectSymlinkPath(resolveCwdPath(target.path, { cwd }), { cwd });
  if (src === dst) throw new Error("source and target must be different files.");
  const label = relativeCwdPath(target.path, { cwd });
  // Read source once; subsequent source changes do not affect this operation or undo.
  const sourceRaw = await readFile(src, "utf8");
  const sourceText = sourceRaw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const sourceRange = range(source, lineOffsets(sourceText));
  const copied = sourceText.slice(sourceRange.start, sourceRange.end);
  return queueEdit(dst, async () => {
    const raw = await readFile(dst, "utf8");
    const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = raw.slice(bom.length);
    const ending = (body.match(/\r\n/g) ?? []).length > (body.match(/(?<!\r)\n/g) ?? []).length ? "\r\n" : "\n";
    const before = body.replace(/\r\n/g, "\n");
    const offsets = lineOffsets(before);
    const targetRange = range(target, offsets, { insert: target.at !== undefined });
    const removed = before.slice(targetRange.start, targetRange.end);
    // Source's selected lines are whole lines. Separate an unterminated last
    // source line from the untouched following target lines when necessary.
    const prefix = target.at !== undefined && targetRange.start === before.length && before.length > 0 && !before.endsWith("\n") ? "\n" : "";
    const suffix = copied && targetRange.end < before.length && !copied.endsWith("\n") ? "\n" : "";
    const inserted = prefix + copied + suffix;
    const after = before.slice(0, targetRange.start) + inserted + before.slice(targetRange.end);
    if (after === before) return { result: `No change to ${label}.`, display: "" };
    await writeFile(dst, bom + (ending === "\r\n" ? after.replace(/\n/g, "\r\n") : after), "utf8");
    const callId = context?.call?.callId;
    if (callId) recordEdit(callId, {
      path: label, ending,
      edits: [{ oldText: removed, newText: inserted, at: targetRange.start,
        ...(inserted === "" ? { postHash: createHash("sha256").update(after).digest("hex") } : {}) }],
    }, context);
    return {
      result: `Spliced lines into ${label}.${callId ? ` Edit id: ${callId}` : ""}`,
      display: unifiedPatch(label, before, after),
    };
  });
}

export function toolDescription() {
  return { splice: { trusted: true,
    description: "Copy source lines into target lines; source stays unchanged. Write a temporary source and use this tool for large edits. Use edit-undo with the returned edit id.",
    inputSchema: { type: "object", required: ["source", "target"], properties: {
      source: { type: "object", description: "Existing file and 1-based inclusive lines to copy.", required: ["path", "from", "to"], properties: {
        path: { type: "string", description: "Source file inside the Agent folder." },
        from: { type: "integer", description: "First source line." },
        to: { type: "integer", description: "Last source line." },
      } },
      target: { type: "object", description: "Existing file and 1-based inclusive lines to replace; at inserts before a line (or appends at line count + 1). If given with at, from and to must both equal at.", required: ["path"], properties: {
        path: { type: "string", description: "Target file inside the Agent folder." },
        from: { type: "integer", description: "First line to replace." },
        to: { type: "integer", description: "Last line to replace." },
        at: { type: "integer", description: "Insert before this line; line count + 1 appends." },
      } },
    } },
  } };
}
