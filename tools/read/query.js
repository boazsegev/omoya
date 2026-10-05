/** Read query schema and normalization; read.target saves the same payload. */
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
export function normalizeReadQuery(args, { artifact = false } = {}) {
  const names = ["path", ...Object.keys(BOOLEAN_FIELDS), "glob", "exclude", "lines", "characters", "bytes", "search", "limit", "offset"];
  const source = record(args, "read", names);
  if (typeof source.path !== "string") throw new TypeError("read.path must be a relative path string");
  if (source.path.length > 4096 || source.path.includes("\0")) throw new Error("read.path exceeds path limits or contains NUL");
  const query = { path: source.path === "" ? "." : source.path };
  for (const [key, fallback] of Object.entries(BOOLEAN_FIELDS)) query[key] = boolean(source[key], key, fallback);
  for (const key of ["glob", "exclude"]) query[key] = globs(source[key], key);
  for (const key of ["lines", "characters", "bytes"]) query[key] = range(source[key], key, key === "lines");
  query.search = searchQuery(source.search);
  query.limit = integer(source.limit, "limit", { fallback: artifact ? Number.MAX_SAFE_INTEGER : 100 });
  query.offset = integer(source.offset, "offset", { fallback: 0 });
  if (query.bytes && !query.binary) throw new Error("bytes requires binary: true");
  if (query.binary && (query.lines || query.characters)) throw new Error("Binary reads use bytes, not lines/characters");
  if (query.info && query.base64) throw new Error("Use either info or base64, not both");
  return query;
}

function numberSchema(description, bounds = {}) { return { type: "integer", ...bounds, description }; }
function flag(description, fallback) { return { type: "boolean", default: fallback, description }; }
function objectSchema(properties, description) { return { type: "object", additionalProperties: false, properties, description }; }

/** Return a fresh read input schema of intended inputs; recovery stays in normalizeReadQuery. */
export function readQuerySchema() {
  const range = () => ({ from: numberSchema("Start."), to: numberSchema("End.") });
  const pattern = (description) => ({ type: "string", minLength: 1, maxLength: MAX_PATTERN, description });
  const glob = (description) => ({ minLength: 1, maxLength: MAX_PATTERN, maxItems: MAX_GLOBS, items: { type: "string", minLength: 1, maxLength: MAX_PATTERN }, description });
  return {
    type: "object", additionalProperties: false, required: ["path"],
    properties: {
      path: { type: "string", maxLength: 4096, description: "File or folder, relative to the Agent folder or absolute inside the project. . is the current folder; ../ reaches project siblings." },
      recursive: flag("Include subfolders.", false),
      ignore: flag("Skip .gitignore/.ignore matches and system files in folder scans.", false),
      glob: glob("Only files matching a glob string or array, e.g. *.md, src/**/*.js, {a,b}. Slashless patterns match filenames."),
      exclude: glob("Skip files or subtrees matching a glob string or array; overrides glob."),
      lines: objectSchema({ ...range(), last: numberSchema("Last N lines instead of from/to.", { minimum: 0 }) }, "1-based inclusive line range; negative counts from the end (-1 is last)."),
      characters: objectSchema(range(), "0-based, end-exclusive character slice of the selected lines; negative counts from the end."),
      bytes: objectSchema(range(), "0-based, end-exclusive byte slice; negative counts from the end. Requires binary."),
      search: objectSchema({
        text: pattern("Literal substring."),
        regex: pattern("JavaScript regex, without / delimiters."),
        ignoreCase: flag("Case-insensitive.", false),
        invert: flag("Select non-matching lines.", false),
        before: numberSchema("Context lines before each match.", { minimum: 0, maximum: 1000, default: 0 }),
        after: numberSchema("Context lines after each match.", { minimum: 0, maximum: 1000, default: 0 }),
      }, "Select lines matching text or regex (either)."),
      limit: numberSchema("Maximum listing entries or matching lines (matching paths with info); context lines are extra. Omit with target to save all results within host budgets.", { minimum: 0, default: 100 }),
      offset: numberSchema("Skip this many entries or matches.", { minimum: 0, default: 0 }),
      info: flag("Return metadata, counts, or matching paths with per-file match counts instead of content.", false),
      annotate: flag("Include MIME types, ranges, and locations; false gives plain text or paths.", true),
      binary: flag("Read raw bytes; search then returns a match report.", false),
      base64: flag("Base64-encode the selected data. Not with info.", false),
      target: { type: "string", description: "Save the complete selected result to this project file instead of returning it; refuse incomplete output. Available only if `write` is available." },
    },
  };
}
