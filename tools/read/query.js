/** Shared model-facing query schema and normalization for read and write.read. */
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

function optional(schema, description) {
  return { anyOf: [schema, { type: "null" }, { type: "boolean" }, { type: "string", const: "" }, { type: "array", maxItems: 0 }, { type: "integer", enum: [0, -1] }], description };
}

function numberSchema(description) { return optional({ type: "integer" }, description); }
function flag(description, fallback) { return optional({ type: "boolean" }, `${description} Default ${fallback}; valid true/false are preserved.`); }
function objectSchema(properties, description) { return optional({ type: "object", additionalProperties: false, properties }, description); }

/** Return a fresh JavaScript JSON Schema; consumers may inline it without sharing mutable state. */
export function readQuerySchema() {
  const rangeProperties = (unit) => ({
    from: numberSchema(`First ${unit}; negative indexes count from end (-1 is last).`),
    to: numberSchema(`Last ${unit}${unit === "line" ? ", inclusive" : " offset, exclusive"}; negative indexes count from end.`),
  });
  const pattern = (description) => optional({ type: "string", maxLength: MAX_PATTERN }, description);
  const glob = (description) => optional({ anyOf: [{ type: "string", maxLength: MAX_PATTERN }, { type: "array", maxItems: MAX_GLOBS, items: { type: "string", maxLength: MAX_PATTERN } }] }, description);
  return {
    type: "object", additionalProperties: false, required: ["path"],
    description: "Read query. Null/empty/wrong-type scalar fillers are absent; meaningful booleans, zero offsets/limits and negative range indexes are preserved. Unknown fields fail.",
    properties: {
      path: { type: "string", maxLength: 4096, description: "Relative file/folder path within the project. Empty string means current folder. Explicit files bypass ignore rules." },
      recursive: flag("Descend into subfolders for listings/searches.", false),
      ignore: flag("Opt into .gitignore then .ignore and system-file exclusions; never disables security guards. Git exclusion is not a relevance verdict.", false),
      glob: glob("Include filenames/relative paths matching any glob, e.g. *.md or src/**/*.js. Slashless patterns match basenames. Filters files, not traversal directories."),
      exclude: glob("Exclude matching paths/subtrees; exclusions win over glob. Supports *, ?, ** and {a,b}."),
      lines: objectSchema({ ...rangeProperties("line"), last: numberSchema("Select last N lines (tail); excludes from/to. Zero selects nothing.") }, "File lines: positive indexes are 1-based inclusive; zero is absent. Negative indexes count from end. Applies before characters/search."),
      characters: objectSchema(rangeProperties("character"), "Unicode code-point slice within selected lines: 0-based, exclusive to. Zero is meaningful."),
      bytes: objectSchema(rangeProperties("byte"), "Positioned byte slice with binary:true: 0-based, exclusive to. Zero is meaningful."),
      search: objectSchema({
        text: pattern("Literal substring, ORed with regex if both supplied. Empty is absent."),
        regex: pattern("JavaScript global multiline regular expression; isolated execution has a hard time budget."),
        ignoreCase: flag("Case-insensitive literal and regex matching.", false),
        invert: flag("Select lines matched by neither condition.", false),
        before: optional({ type: "integer", minimum: 0, maximum: 1000 }, "Context lines before selected lines, 0–1000; overlapping context merges."),
        after: optional({ type: "integer", minimum: 0, maximum: 1000 }, "Context lines after selected lines, 0–1000; overlapping context merges."),
      }, "Search selected text or raw bytes (binary:true); OR conditions select unique source lines. No effective expression means no search."),
      limit: optional({ type: "integer", minimum: 0 }, "Maximum listing entries/selected search lines (matching paths in info), default 100. Context is additional but budgeted. Zero intentionally selects nothing; -1 is absent."),
      offset: optional({ type: "integer", minimum: 0 }, "Skip listing entries/selected search lines (matching paths in info), default 0. Zero is meaningful; -1 is absent."),
      info: flag("Return contextual metadata/counts: file totals, listing counts, or matching paths and per-file selected-line counts. Scans are bounded; incomplete counts are labeled.", false),
      annotate: flag("Decorate payload with MIME/ranges/locations/sizes. False returns plain selected text or newline-separated paths. Execution status stays separate.", true),
      binary: flag("Select raw bytes using bytes; without search return binary content, with search return a text report.", false),
      base64: flag("Encode selected payload as base64 text, including when saved by write.read. Excludes info.", false),
    },
  };
}
