/**
 * tools/read/read.js — INTERNAL module of the `read` tool (never a
 * tool itself: the scan is not recursive — tools/read.js is the
 * published wrapper). read: read-only, cwd-rooted file access.
 * Reading a FOLDER lists its entries (directories suffixed with "/");
 * recursive: true nests sub-folder entries, and a folder PATTERN greps
 * every matching file in the folder (again descending only with recursive: true).
 *
 * Beyond whole-file reads, an agent can narrow what it gets back:
 *   - a LINE range (startLine/endLine, 1-based, both inclusive);
 *   - a CHARACTER range (startChar/endChar, 0-based, endChar
 *     exclusive) over UTF-8 characters (code points) — or, with
 *     binary: true, a BYTE range;
 *   - a grep-like PATTERN (pattern: a regular expression; ignoreCase;
 *     maxMatches) returning matching lines with their 1-based line
 *     numbers; glob filters candidate file names/relative paths. Ranges apply first, the pattern runs within them (line
 *     numbers stay true for line ranges; char-sliced searches number
 *     from the slice).
 * Narrowings COMBINE instead of conflicting (simple models stack
 * guards): a line range AND a character range is a valid request
 * ("up to 200 lines but no more than 4K characters") — the line
 * range selects first, the character range caps the selection. On a
 * FOLDER, a line range is accepted as an entry/match cap (an initial
 * maxMatches: `startLine:1, endLine:20` lists/searches at most 20);
 * an explicit non-zero maxMatches always wins.
 * Two RELEVANCE layers keep searches meaningful. grep is a text-only
 * operation: a file whose CONTENT sniffs as binary (bytes above 127
 * that decode as neither valid UTF-8 nor valid UTF-16 — never a mime
 * map or an extension) is refused on a direct grep and skipped (with
 * a count) in a folder grep, unless binary: true explicitly searches
 * raw bytes. And known system files (.DS_Store and friends) plus
 * anything matched by a `.ignore` file (gitignore syntax, `.gitignore`
 * itself NOT consulted) never appear in LISTINGS and never match in
 * searches — .ignore is a relevance indicator, not an access wall:
 * a file asked for BY NAME still reads, and a direct search reports
 * no matches with a hint rather than refusing.
 * Output form is a separate concern from read mode:
 *   - default: UTF-8 text (or a folder listing);
 *   - binary: true: the byte range as BINARY content (a mime-detected
 *     binary content block) for models that accept binary input —
 *     vision models consume binary data but fail on base64 text;
 *   - base64: true: the result encoded as base64 TEXT (the byte range
 *     in binary mode, the text result otherwise) for models without
 *     binary support.
 * With no options the raw file content is returned, exactly as before;
 * a FOLDER listing shows each file entry's approximate size in bytes
 * (a directory's own "size" is inode bookkeeping, never its content,
 * so it's never shown). With info: true the tool returns a SUMMARY
 * instead of the payload: the file's metadata (type, size, created,
 * modified) — a FILE's summary always adds the WHOLE file's character
 * and line counts too, regardless of any narrowing requested — and
 * what the requested read/grep/ls/find would have returned (bytes,
 * matches, entries) — the way to size a query before running it.
 */

import { lstat, open, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { toolRevision } from "../../lib/tool-runtime.js"; // the tool-runtime leaf: one instance across cache-busted imports — no whole-library load for a timestamp
const guardTimestamp = toolRevision();
const { rejectSymlinkPath, resolveCwdPath } = await import(`../guard/resolve.js?now=${guardTimestamp}`);
import { grep, grepFolder, DEFAULT_MAX_MATCHES, DEFAULT_GREP_FILE_SIZE_LIMIT } from "./grep.js";
import { matchesGlob } from "./glob.js";
import { isBinary } from "./binary.js";
import { ancestorIgnores, isIgnored, isSystemFile, loadIgnore } from "./ignore.js";
import { detectMime } from "./mime-detection.js";
import { intArg, encodeIf, infoBlock } from "./util.js";

// The root-folder hint, or null when the agent folder IS the project
// root (nothing more to reach). Shared by the ENOENT error path and by
// current-folder listings: a `read({ path: "." })` from a sub-folder
// shows only the sub-folder, so the listing itself points upward.
function subfolderHint({ cwd, boundary }) {
  if (resolve(cwd) === resolve(boundary)) return null;
  const folder = relative(boundary, cwd);
  const up = relative(cwd, boundary);
  // Agent folders are constrained to the project boundary. Keep the hint
  // defensive for embedded callers that pass an inconsistent context.
  if (!folder || folder === ".." || folder.startsWith(`..${sep}`) || !up) return null;
  const rootPrefix = `${up.split(sep).join("/")}/`;
  return `Hint: you're in \`./${folder.split(sep).join("/")}\`, use \`${rootPrefix}\` to read files from the root project.`;
}

function missingPathHint(error, { cwd, boundary }) {
  if (error?.code !== "ENOENT") return error;
  // Policy: relative paths always — never leak the container's absolute
  // folder layout through a raw fs error ("stat '/abs/work/dir/x'").
  const shown = relative(cwd, resolvedFrom(error)).split(sep).join("/");
  error.message = `ENOENT: no such file or directory, stat '${shown === "" ? "." : shown}'`;
  const hint = subfolderHint({ cwd, boundary });
  if (hint) error.message += ` ${hint}`;
  return error;
}

/** The absolute path a failed fs call was aimed at (errno carries it). */
function resolvedFrom(error) {
  return typeof error?.path === "string" ? error.path : process.cwd();
}

export function readSettingsSchema() {
  return {
    read: {
      default: { grepFileSizeLimit: DEFAULT_GREP_FILE_SIZE_LIMIT },
      description: "read tool: grepFileSizeLimit caps the file size a folder grep will search, in bytes (bigger files are skipped, counted, and reported; a direct file grep is never capped).",
    },
  };
}

export function readDescription() {
  return {
    // READ-ONLY: published as safe (safe-mode Agents may read files)
    safe: true,
    description: "Use `read` to read a file (cat), grep it, list a folder (ls), or filter folder files (find).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "relative path to folder or file." },
        startLine: { type: "integer", description: "first line to include (1-based, inclusive); default 1. On a folder: with endLine, an entry/match cap (an initial maxMatches — an explicit maxMatches wins)" },
        endLine: { type: "integer", description: "last line to include (1-based, inclusive); default: end of file. On a folder: the cap's upper line" },
        startChar: { type: "integer", description: "first character to include (0-based, inclusive); with binary:true, first BYTE. Combines with a line range: the line range selects first, the character range caps the selection" },
        endChar: { type: "integer", description: "character offset to stop at (0-based, exclusive); with binary:true, a byte offset. A character CAP alongside a line range is valid (e.g. 200 lines but at most 4K characters)" },
        binary: { type: "boolean", description: "treat the file as bytes: startChar/endChar become byte offsets and the range is returned as BINARY content (mime-detected) for models that accept binary input, e.g. vision" },
        base64: { type: "boolean", description: "encode the result as base64 TEXT (with binary:true, the byte range; otherwise the text result) for models without binary support" },
        pattern: { type: "string", description: "grep-like regular expression: return matching lines with line numbers instead of file content; on a folder, searches matching files and prefixes each match with its file path" },
        glob: { type: "string", description: "optional glob filtering file names (for example '*.ts') or relative paths (for example 'src/**/*.ts'); applies to folder listings/searches and verifies a file path matches" },
        ignoreCase: { type: "boolean", description: "case-insensitive pattern matching" },
        maxMatches: { type: "integer", description: `cap on grep matches (default ${DEFAULT_MAX_MATCHES}); on a folder also caps ls/find output (overrides a line range's cap)` },
        recursive: { type: "boolean", description: "on a folder: include sub-folders — ls/find output nests the sub-folder's entries and grep descends into the sub-folder itself (an ignored sub-folder is never entered)" },
        info: { type: "boolean", description: "return information about the file/query instead of the content: metadata (type, size, created, modified — for a file, also its WHOLE character and line counts) and how many bytes (or matches/entries) the requested read would return" },
      },
      required: ["path"],
    },
  };
}

/**
 * @param {{path: string, startLine?: number, endLine?: number,
 *   startChar?: number, endChar?: number, binary?: boolean,
 *   base64?: boolean, pattern?: string, glob?: string, ignoreCase?: boolean,
 *   maxMatches?: number, recursive?: boolean, info?: boolean}} args
 * @returns {Promise<string|Array>} the file contents, a narrowed selection,
 *   grep matches, binary content blocks (binary: true), or clearly-labeled
 *   ls/find output
 */
export async function read({
  path, startLine, endLine, startChar, endChar,
  binary = false, base64 = false, pattern, glob, ignoreCase = false, maxMatches,
  recursive = false, info = false,
} = {}, context) {
  // FALSEY-FILLED optionals are ABSENT: some models always fill every
  // schema field, using 0 / null / false / "" for "no value" — a
  // filled startLine: 0 or pattern: "" must not throw or change the
  // query (optionality is expressed by absence from `required`, and a
  // falsey fill is how a model says "absent"). For every optional
  // here the falsey value coincides with the default, so nothing is
  // lost: startChar: 0 IS the range start, startLine: 0 is never a
  // valid line (1-based).
  const absent = (v) => (v === null || v === false || v === 0 || v === "" ? undefined : v);
  startLine = absent(startLine);
  endLine = absent(endLine);
  startChar = absent(startChar);
  endChar = absent(endChar);
  pattern = absent(pattern);
  glob = absent(glob);
  maxMatches = absent(maxMatches);
  // An EMPTY path is the model asking for the current folder (a falsey
  // fill of the one required field) — list it rather than reject it.
  // A truly ABSENT path stays a TypeError (the field is required).
  if (path === "") path = ".";
  // The agent-local folder is the actual working directory. The enclosing
  // environment project is the read boundary, so an agent may inspect
  // project siblings with ../ but never escape the project.
  const cwd = context?.agent?.folder ?? context?.env?.cwd ?? context?.agent?.env?.cwd ?? process.cwd();
  const boundary = context?.env?.cwd ?? context?.agent?.env?.cwd ?? cwd;
  const resolved = await rejectSymlinkPath(resolveCwdPath(path, { cwd, boundary }), { cwd: boundary });
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch (error) {
    throw missingPathHint(error, { cwd, boundary });
  }
  let stack = null; // the .ignore stack: loaded lazily, only when a pattern is given
  const ignores = async () => (stack ??= await ancestorIgnores(boundary, resolved));
  const boundaryRel = relative(boundary, resolved).split(sep).join("/");
  // A search of an ignored file or folder FINDS NOTHING, but it never
  // refuses: the content stays directly readable, the .ignore only
  // speaks to relevance (a .ignore'd file search hints why; a system
  // file like .git or .DS_Store simply has no matches).
  let ignoredFolder = false;
  if (pattern !== undefined) {
    if (fileStat.isDirectory()) {
      const rel = `${boundaryRel}/`;
      ignoredFolder = isSystemFile(rel) || isIgnored(await ignores(), rel);
    } else {
      if (isIgnored(await ignores(), boundaryRel)) {
        return `grep: no matches for /${pattern}/${ignoreCase ? "i" : ""} in ${path} (the file may be ignored — .ignore marks project-irrelevant files)`;
      }
      if (isSystemFile(boundaryRel)) return `grep: no matches for /${pattern}/${ignoreCase ? "i" : ""} in ${path}`;
    }
  }
  if (info && base64) throw new Error("Use either info or base64, not both.");
  if (fileStat.isDirectory()) {
    return await folderRead(resolved, {
      path, pattern, glob, ignoreCase, maxMatches, recursive, info,
      binary, base64, startLine, endLine, startChar, endChar,
      rootHint: subfolderHint({ cwd, boundary }), ignoredFolder,
      sizeLimit: grepFileSizeLimit(context?.env?.settings),
    });
  }
  // FILE-specific info always reports the WHOLE file's character and
  // line counts (never just the requested narrowing) — sizing a
  // narrower follow-up query is the documented point of info:true.
  // Captured before any text/lines reassignment below, so a line- or
  // char-range request still reports the FILE's totals, not the slice's.
  let fullTextCounts = null;
  const summary = (query) => infoBlock(path, fileStat, "file", query, fullTextCounts ?? undefined);

  const lineRange = startLine !== undefined || endLine !== undefined;
  const charRange = startChar !== undefined || endChar !== undefined;
  // a PATTERN with binary: true redefines binary: a raw-BYTE grep
  // (latin1 — one character per byte — so \x89PNG works), not a byte
  // range; binary without a pattern keeps the byte-range mode
  const byteGrep = binary && pattern !== undefined;
  // a line range AND a character range is NOT a conflict: the line
  // range selects first, the character range caps the selection
  // ("up to 200 lines, but no more than 4K characters" is a valid ask)
  if (binary && lineRange) {
    throw new Error("Binary reads use startChar/endChar, not startLine/endLine.");
  }
  // grep is a TEXT operation: sniff the content (never the name or a
  // mime map — bytes only) and refuse actual binary files up front,
  // unless binary: true explicitly asks to search the raw bytes
  if (pattern !== undefined && !byteGrep && await isBinaryFile(resolved)) {
    throw new Error("grep applies only to text files; this file looks binary (use binary: true to search its bytes).");
  }
  if (glob !== undefined && !matchesGlob(relative(cwd, resolved), glob)) {
    throw new Error(`The file does not match glob "${glob}".`);
  }

  /* ------------------------------------------------ binary byte range */

  if (binary && !byteGrep) {
    const buf = await readFile(resolved);
    const s = intArg(startChar ?? 0, "startChar", 0);
    const e = intArg(endChar ?? buf.length, "endChar", 0);
    if (s > e) throw new Error("startChar must not be greater than endChar.");
    const slice = buf.subarray(Math.min(s, buf.length), Math.min(e, buf.length));
    const last = slice.length === 0 ? s : s + slice.length - 1;
    const mime = detectMime({ path: resolved, buffer: slice });
    const encoded = slice.toString("base64");
    if (info) {
      return summary(`read would return ${slice.length} bytes (byte range ${s}–${last} of ${buf.length}, ${mime})`);
    }
    if (base64) return `[bytes ${s}–${last} of ${buf.length} total, base64]\n${encoded}`;
    return [
      { type: "text", text: `[bytes ${s}–${last} of ${buf.length} total, ${mime}]` },
      { type: "binary", mime, content: encoded },
    ];
  }

  /* ------------------------------------------------------ text modes */

  let text = await readFile(resolved, byteGrep ? "latin1" : "utf8");
  // only counted when actually needed (info:true) — a plain read of a
  // huge file never pays for a full code-point scan it doesn't ask for
  if (info) fullTextCounts = { characters: [...text].length, lines: text.split("\n").length };
  let header = "";
  let lineOffset = 1; // first line number of the searched/returned text

  let lines = null;
  if (lineRange) {
    const all = text.split("\n");
    const s = intArg(startLine ?? 1, "startLine", 1);
    const e = Math.min(intArg(endLine ?? all.length, "endLine", 1), all.length);
    if (s > e) {
      if (pattern === undefined) {
        const empty = `[lines ${s}–${e} of ${all.length} total]\n`;
        if (info) return summary(`read would return ${Buffer.byteLength(empty, "utf8")} bytes (lines ${s}–${e} of ${all.length})`);
        return encodeIf(base64, empty);
      }
      lines = [];
    } else {
      lines = all.slice(s - 1, e);
    }
    lineOffset = s;
    header = `[lines ${s}–${e} of ${all.length} total]\n`;
  }

  if (charRange) {
    const base = lines ? lines.join("\n") : text; // within the line range when both are given
    const chars = [...base]; // UTF-8 characters (code points)
    const s = intArg(startChar ?? 0, "startChar", 0);
    const e = intArg(endChar ?? chars.length, "endChar", 0);
    if (s > e) throw new Error("startChar must not be greater than endChar.");
    text = chars.slice(s, e).join("");
    header += `[characters ${s}–${Math.max(s, e - 1)} of ${chars.length}${lineRange ? " in the line range" : " total"}]\n`;
    // both ranges: the grep/result works on the capped selection,
    // still numbered from the line range's first line
    if (lines) lines = text === "" ? [] : text.split("\n");
  }

  if (pattern !== undefined) {
    const stats = {};
    const result = grep(text, { pattern, ignoreCase, maxMatches, path, lines, lineOffset, header, stats });
    if (info) return summary(`grep would return ${stats.matches} matches (${Buffer.byteLength(result, "utf8")} bytes)`);
    return encodeIf(base64, result);
  }
  const result = header !== "" ? header + (lines ? lines.join("\n") : text) : text;
  if (info) {
    const scope = lineRange ? `lines ${lineOffset}–${lineOffset + (lines?.length ?? 1) - 1}`
      : charRange ? "character range" : "whole file";
    return summary(`read would return ${Buffer.byteLength(result, "utf8")} bytes (${scope})`);
  }
  return encodeIf(base64, result); // header === "": the unchanged fast path
}

/** Sniff up to 64 KiB and judge text vs. binary by CONTENT alone. */
async function isBinaryFile(abs) {
  const handle = await open(abs, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return isBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/* -------------------------------------------------------- folders */

/** ls/find listing or grep over a folder's entries. */
async function folderRead(resolved, options) {
  const { path, pattern, glob, recursive, info, ignoreCase, binary } = options;
  // LENIENCY (simple models stack guards): a line range on a folder
  // is accepted as an entry/match CAP — `startLine:1, endLine:20`
  // means "at most 20 entries/matches" (an initial maxMatches; an
  // explicit non-zero maxMatches always wins). binary/base64 and a
  // starting character offset stay meaningless on a listing. `endChar`
  // is deliberately useful: it caps the final rendered listing, just
  // like it caps a file read's output.
  for (const name of ["binary", "base64", "startChar"]) {
    const value = options[name];
    if (value !== undefined && value !== false) {
      throw new Error(`${name} applies only to files. Choose a file path or remove ${name}.`);
    }
  }
  let lineCap;
  if (options.startLine !== undefined || options.endLine !== undefined) {
    const s = intArg(options.startLine ?? 1, "startLine", 1);
    const e = intArg(options.endLine ?? s, "endLine", 1);
    lineCap = Math.max(1, e - s + 1);
  }
  const explicit = options.maxMatches !== undefined
    ? intArg(options.maxMatches, "maxMatches", 1) : undefined;
  const cap = explicit ?? lineCap; // the explicit maxMatches overrides the line range's cap
  const shown = path === "" || path === "." ? "." : path.replace(/\/+$/, "");
  // A plain listing never pays for content sniffs: the walk opens
  // files only when a search will actually need the binary verdict.
  const sniff = pattern !== undefined;
  const entries = await walk(resolved, "", recursive, [], await loadIgnore(resolved, ""), sniff);
  const folderStat = await stat(resolved);
  let filtered = glob === undefined ? entries : entries.filter((e) => !e.dir && matchesGlob(e.rel, glob));
  if (pattern === undefined) {
    const suffix = `${recursive ? " (recursive)" : ""}${glob === undefined ? "" : ` (glob: ${glob})`}`;
    const capped = cap !== undefined && filtered.length > cap;
    const listing = capped ? filtered.slice(0, cap) : filtered;
    if (info) {
      return infoBlock(shown, folderStat, "folder",
        `ls/find would return ${capped ? `${cap} of ${filtered.length} (capped)` : filtered.length} entries${suffix}`);
    }
    const more = capped ? `\n… (${filtered.length - cap} more — capped at ${cap})` : "";
    // A listing of the CURRENT folder from a sub-folder shows only the
    // sub-folder — point upward so project-root files are not invisible.
    const upward = shown === "." && options.rootHint ? `\n${options.rootHint}` : "";
    // approximate size in bytes per FILE entry (a directory's own
    // "size" is inode bookkeeping, not its content — never shown)
    const lines = [];
    for (const e of listing) {
      if (e.dir) { lines.push(e.rel); continue; }
      let size;
      try { size = (await stat(e.abs)).size; } catch { size = undefined; }
      lines.push(size === undefined ? e.rel : `${e.rel} (${size} bytes)`);
    }
    const mode = glob === undefined ? "ls" : "find";
    const result = `${mode} ${shown}${suffix}:\n${lines.join("\n")}${more}${upward}`;
    if (options.endChar === undefined) return result;
    const end = intArg(options.endChar, "endChar", 0);
    return [...result].slice(0, end).join("");
  }
  // A search never descends into an ignored folder: it FINDS NOTHING
  // instead (a relevance verdict, not a refusal — a direct read of
  // the folder still lists, and the hint points at the file modes).
  if (options.ignoredFolder) {
    const flags = ignoreCase ? "i" : "";
    const no = `grep: no matches for /${pattern}/${flags} in ${shown}`;
    if (info) {
      return infoBlock(shown, folderStat, "folder",
        `grep would return 0 matches in 0 file(s), ${filtered.length} ignored skipped`);
    }
    return `${no} (${filtered.length} ignored skipped)`;
  }
  const files = filtered.filter((e) => !e.dir);
  return await grepFolder(files, { shown, pattern, ignoreCase, maxMatches: cap, info, stat: folderStat, infoBlock, binary, sizeLimit: options.sizeLimit });
}

/**
 * A folder's entries, sorted by name within each folder; sub-folders
 * are entered only when recursive. Directories carry a "/" suffix.
 * System files and `.ignore`d entries are skipped as if absent (each
 * visited folder's own `.ignore` joins the stack — nested rules
 * refine deeper paths). When `sniff` is set (a folder SEARCH), file
 * entries are pre-sniffed: `binary` marks content the search will
 * skip. A plain listing never sniffs — open + 64 KiB read per file
 * is search-only cost.
 * @returns {Array<{rel: string, abs: string, dir: boolean, binary?: boolean}>}
 */
async function walk(abs, prefix, recursive, ignores, own, sniff) {
  const stack = own ? [...ignores, own] : ignores;
  const entries = (await readdir(join(abs, prefix || "."), { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const target = join(abs, rel);
    // Dirent/lstat identify a link without following it. A recursive
    // read must refuse rather than present or grep a link target.
    if (e.isSymbolicLink() || (await lstat(target)).isSymbolicLink()) {
      throw new Error("Choose a regular file or folder instead of a symbolic link.");
    }
    if (e.isDirectory()) {
      const shown = `${rel}/`;
      if (isSystemFile(rel) || isIgnored(stack, shown)) continue;
      // the sub-folder's own .ignore loads ONLY when the walk will
      // actually descend — a plain listing names the folder without
      // ever opening its .ignore
      const deeper = recursive ? await loadIgnore(target, rel) : null;
      out.push({ rel: shown, abs: join(abs, rel), dir: true });
      if (recursive) out.push(...(await walk(abs, rel, true, stack, deeper, sniff)));
    } else {
      if (isSystemFile(rel) || isIgnored(stack, rel)) continue;
      out.push({ rel, abs: join(abs, rel), dir: false, binary: sniff ? await isBinaryFile(target) : undefined });
    }
  }
  return out;
}

/**
 * The folder-grep file size ceiling from settings
 * (read.grepFileSizeLimit; default 5 MB). 0 (or a negative value)
 * disables the cap; a non-number or invalid value falls back to the
 * default. A DIRECT file grep is never capped — the agent asked for
 * that specific file.
 */
function grepFileSizeLimit(settings) {
  const raw = settings?.read?.grepFileSizeLimit;
  if (raw === undefined) return DEFAULT_GREP_FILE_SIZE_LIMIT;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_GREP_FILE_SIZE_LIMIT;
  if (raw <= 0) return Infinity;
  return Math.floor(raw);
}
