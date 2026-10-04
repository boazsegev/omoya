/** Shared model-facing query schema and normalization for read and write.source. */
import { toolRevision } from "../../lib/tool-runtime.js";
const { validateGlob } = await import(`./glob.js?revision=${toolRevision()}`);
const EMPTY = (value) => value == null || value === "" || (Array.isArray(value) && value.length === 0);
const FILLER = (value) => EMPTY(value) || typeof value === "boolean" || value === 0 || value === -1;
const BOOLEAN_FIELDS = { recursive: false, ignore: false, info: false, annotate: true, binary: false, base64: false };
const MAX_PATTERN = 4096;
const MAX_GLOBS = 128;

function record(value, name, keys) {
  if (FILLER(value)) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${name} field: ${key}`);
  return value;
}

function boolean(value, name, fallback) {
  if (typeof value === "boolean") return value;
  if (FILLER(value)) return fallback;
  throw new TypeError(`${name} must be a boolean`);
}

function integer(value, name, { negative = false, zero = true, fallback } = {}) {
  if (EMPTY(value) || typeof value === "boolean" || (!zero && value === 0) || (!negative && value === -1)) return fallback;
  if (!Number.isSafeInteger(value) || (!negative && value < 0)) throw new TypeError(`${name} must be a safe integer${negative ? "" : " >= 0"}`);
  return value;
}

function expression(value, name) {
  if (FILLER(value)) return undefined;
  if (typeof value !== "string" || value.length > MAX_PATTERN) throw new TypeError(`${name} must be a string of at most ${MAX_PATTERN} characters`);
  return value;
}

function globs(value, name) {
  if (FILLER(value)) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > MAX_GLOBS) throw new Error(`${name} accepts at most ${MAX_GLOBS} patterns`);
  const patterns = list.map((item) => expression(item, name)).filter((item) => item !== undefined);
  for (const pattern of patterns) validateGlob(pattern);
  return patterns;
}

function range(value, name, line = false) {
  const source = record(value, name, line ? ["from", "to", "last"] : ["from", "to"]);
  const result = {};
  for (const key of ["from", "to"]) {
    const number = integer(source[key], `${name}.${key}`, { negative: true, zero: !line });
    if (number !== undefined) result[key] = number;
  }
  if (line) {
    const last = integer(source.last, "lines.last");
    if (last !== undefined) result.last = last;
    if (last !== undefined && (result.from !== undefined || result.to !== undefined)) throw new Error("lines.last excludes lines.from/to");
  }
  if (result.from >= 0 && result.to >= 0 && result.from > result.to) throw new Error(`${name}.from must not exceed ${name}.to`);
  return Object.keys(result).length ? result : undefined;
}

function searchQuery(value) {
  const source = record(value, "search", ["text", "regex", "ignoreCase", "invert", "before", "after"]);
  const text = expression(source.text, "search.text");
  const regex = expression(source.regex, "search.regex");
  const ignoreCase = boolean(source.ignoreCase, "search.ignoreCase", false);
  const invert = boolean(source.invert, "search.invert", false);
  const before = integer(source.before, "search.before", { fallback: 0 });
  const after = integer(source.after, "search.after", { fallback: 0 });
  if (before > 1000 || after > 1000) throw new Error("Search context is limited to 1000 lines on each side");
  if (regex !== undefined) {
    try { new RegExp(regex, `gm${ignoreCase ? "i" : ""}`); }
    catch { throw new Error("Invalid search.regex. Use a valid regular expression."); }
  }
  return text === undefined && regex === undefined ? undefined : { text, regex, ignoreCase, invert, before, after };
}

/** Normalize model fillers without erasing meaningful zero, negative indexes, or booleans. */
export function normalizeReadQuery(args) {
  const names = ["path", ...Object.keys(BOOLEAN_FIELDS), "glob", "exclude", "lines", "characters", "bytes", "search", "limit", "offset"];
  const source = record(args, "read", names);
  if (typeof source.path !== "string") throw new TypeError("read.path must be a relative path string");
  if (source.path.length > 4096 || source.path.includes("\0")) throw new Error("read.path exceeds path limits or contains NUL");
  const query = { path: source.path === "" ? "." : source.path };
  for (const [key, fallback] of Object.entries(BOOLEAN_FIELDS)) query[key] = boolean(source[key], key, fallback);
  for (const key of ["glob", "exclude"]) query[key] = globs(source[key], key);
  for (const key of ["lines", "characters", "bytes"]) query[key] = range(source[key], key, key === "lines");
  query.search = searchQuery(source.search);
  query.limit = integer(source.limit, "limit", { fallback: 100 });
  query.offset = integer(source.offset, "offset", { fallback: 0 });
  if (query.bytes && !query.binary) throw new Error("bytes requires binary: true");
  if (query.binary && (query.lines || query.characters)) throw new Error("Binary reads use bytes, not lines/characters");
  if (query.info && query.base64) throw new Error("Use either info or base64, not both");
  return query;
}

function numberSchema(description, bounds = {}) { return { type: "integer", ...bounds, description }; }
function flag(description, fallback) { return { type: "boolean", default: fallback, description }; }
function objectSchema(properties, description) { return { type: "object", additionalProperties: false, properties, description }; }

/** Return a fresh schema of intended inputs; recovery stays in normalizeReadQuery. */
export function readQuerySchema() {
  const rangeProperties = (unit) => ({
    from: numberSchema(`Start ${unit}${unit === "line" ? " (1-based)" : " offset (0-based)"}; negative indexes count from the end (-1 is last).`),
    to: numberSchema(`End ${unit}, ${unit === "line" ? "inclusive" : "exclusive"}; negative indexes count from the end.`),
  });
  const pattern = (description) => ({ type: "string", minLength: 1, maxLength: MAX_PATTERN, description });
  const glob = (description) => ({ minLength: 1, maxLength: MAX_PATTERN, maxItems: MAX_GLOBS, items: { type: "string", minLength: 1, maxLength: MAX_PATTERN }, description });
  return {
    type: "object", additionalProperties: false, required: ["path"],
    description: "Select a file or folder, then add filters, ranges, or search. Omit options you do not need.",
    properties: {
      path: { type: "string", maxLength: 4096, description: "File or folder relative to the working folder. Use . for the current folder." },
      recursive: flag("Include subfolders in listings and searches.", false),
      ignore: flag("Apply .gitignore, .ignore, and system-file exclusions to folder scans. Explicit file paths bypass these filters.", false),
      glob: glob("Include files matching a glob or any glob in an array, e.g. *.md or src/**/*.js. Slashless patterns match filenames."),
      exclude: glob("Exclude files or subtrees matching a glob or any glob in an array; overrides glob. Supports *, ?, ** and {a,b}."),
      lines: objectSchema({ ...rangeProperties("line"), last: numberSchema("Read the last N lines instead of from/to. Use 0 for no lines.", { minimum: 0 }) }, "Select file lines before character slicing or search. Use from/to or last, not both."),
      characters: objectSchema(rangeProperties("character"), "Slice Unicode characters within the selected lines. Use 0-based offsets and an exclusive end; do not combine with binary."),
      bytes: objectSchema(rangeProperties("byte"), "Read a byte range with binary: true. Use 0-based offsets and an exclusive end."),
      search: objectSchema({
        text: pattern("Match this literal substring. With regex, select lines matching either expression."),
        regex: pattern("Match a JavaScript regular expression with global and multiline behavior; omit / delimiters."),
        ignoreCase: flag("Match text and regex without case sensitivity.", false),
        invert: flag("Select lines matching neither text nor regex.", false),
        before: numberSchema("Include this many lines before each match; overlapping context is merged.", { minimum: 0, maximum: 1000, default: 0 }),
        after: numberSchema("Include this many lines after each match; overlapping context is merged.", { minimum: 0, maximum: 1000, default: 0 }),
      }, "Search selected text, or raw bytes with binary: true. Supply text, regex, or both."),
      limit: numberSchema("Return at most this many listing entries or matching lines (matching paths with info). Context lines are additional. Use 0 for none.", { minimum: 0, default: 100 }),
      offset: numberSchema("Skip this many listing entries or matching lines (matching paths with info).", { minimum: 0, default: 0 }),
      info: flag("Return file metadata, listing counts, or matching paths with per-file match counts. Check incomplete-scan notices before treating counts as totals.", false),
      annotate: flag("Include MIME types, ranges, and locations. Set false for plain text or newline-separated paths.", true),
      binary: flag("Read raw bytes; use bytes instead of lines/characters. With search, return a text report of matches.", false),
      base64: flag("Encode selected data as base64 text. Do not combine with info.", false),
    },
  };
}
