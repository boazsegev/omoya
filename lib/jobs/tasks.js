/** Pure Markdown/frontmatter parsing with wholesale fallback and task-local rejection. */
import { createHash } from "node:crypto";
import { JobsError } from "./errors-base.js";
import { normalizeDays } from "./days.js";

const KNOWN = new Set(["id", "enabled", "schedule", "tools", "timeout", "model"]);
const CREDENTIAL = /(?:api[_-]?key|token|secret|password|credential|auth(?:orization)?)/i;
const ACTIONABLE = /[^\s#]/;

/** Throw a JobsError with the supplied code, message, and optional details.
 * @param {string} code
 * @param {string} message
 * @param {object} [details={}]
 * @returns {never}
 * @throws {JobsError}
 */
function fail(code, message, details = {}) { throw new JobsError(code, message, details); }
/** Throw a task-scoped JobsError, attaching its filename.
 * @param {string} filename
 * @param {string} code
 * @param {string} message
 * @returns {never}
 * @throws {JobsError}
 */
function taskFail(filename, code, message) { fail(code, message, { filename }); }
/** Test whether a value is a non-null, non-array object.
 * @param {*} value
 * @returns {boolean}
 */
function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Create an immutable task diagnostic.
 * @param {string} filename
 * @param {string} code
 * @param {string} message
 * @returns {Readonly<{filename: string, code: string, message: string}>}
 */
function diagnostic(filename, code, message) { return Object.freeze({ filename, code, message }); }

/** Bun discards tags, so reject tag properties before parsing.
 * @param {string} text
 * @returns {boolean}
 */
function hasYamlTag(text) {
  let blockIndent = null;
  for (const line of text.split(/\r?\n/)) {
    const indent = line.match(/^\s*/)[0].length;
    if (blockIndent !== null) {
      if (!line.trim() || indent > blockIndent) continue;
      blockIndent = null;
    }
    let quote = null;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (quote === "'") { if (character === "'" && line[index + 1] === "'") index++; else if (character === "'") quote = null; continue; }
      if (quote === '"') { if (character === "\\") index++; else if (character === '"') quote = null; continue; }
      if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) break;
      if ((character === "'" || character === '"') && scalarStart(line, index)) { quote = character; continue; }
      if (character === "!" && scalarStart(line, index)) return true;
      if ((character === "|" || character === ">") && scalarStart(line, index) && /^[|>][1-9+-]*\s*(?:#.*)?$/.test(line.slice(index))) { blockIndent = indent; break; }
    }
  }
  return false;
}
/** Determine whether a character begins a YAML scalar.
 * @param {string} line
 * @param {number} index
 * @returns {boolean}
 */
function scalarStart(line, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/.test(line[previous])) previous--;
  return previous < 0 || /[:[,\{?]/.test(line[previous]) || (line[previous] === "-" && (previous === 0 || /\s/.test(line[previous - 1])));
}
/** Parse task YAML and require a mapping; YAML tags and malformed/non-mapping input reject.
 * @param {string} text
 * @returns {object}
 * @throws {JobsError} For tags, malformed YAML, or a non-mapping value.
 */
function yaml(text) {
  if (hasYamlTag(text)) fail("JOBS_TASK_YAML_TAG", "task frontmatter cannot contain YAML tags");
  try {
    const value = Bun.YAML.parse(text);
    if (!plainObject(value)) fail("JOBS_TASK_YAML", "task frontmatter must be a mapping");
    return value;
  } catch (cause) {
    if (cause instanceof JobsError) throw cause;
    fail("JOBS_TASK_YAML", `task frontmatter is malformed YAML: ${cause?.message ?? cause}`);
  }
}

/** Check whether text looks like a YAML metadata declaration.
 * @param {string} text
 * @returns {boolean}
 */
function looksDeclaredMetadata(text) {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    return /^(?:[A-Za-z][A-Za-z0-9_-]*|["'][^"']+["'])\s*:/.test(trimmed) || /^[{[]/.test(trimmed);
  });
}

/** Detect an initial known task key when frontmatter delimiters are absent.
 * Ordinary `word:` Markdown prose is not treated as metadata.
 * @param {string} source
 * @returns {boolean}
 */
function hasUndelimitedTaskMetadata(source) {
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return new RegExp(`^(?:${[...KNOWN].join("|")})\\s*:`).test(trimmed);
  }
  return false;
}
/** Split source into metadata and prompt, preserving invalid-declaration status.
 * @param {string} source
 * @returns {{metadata?: undefined, prompt: string} | {raw: string, prompt: string, error?: string}}
 * An unclosed opening delimiter with declared metadata yields an error result.
 */
function splitFrontmatter(source) {
  if (!/^---(?:\r?\n|$)/.test(source)) {
    if (hasUndelimitedTaskMetadata(source)) return { raw: "", prompt: source.trim(), error: "JOBS_TASK_YAML" };
    return { metadata: undefined, prompt: source.trim() };
  }
  const opening = source.match(/^---\r?\n?/)[0].length;
  const close = /(?:^|\n)---(?:\r?\n|$)/g;
  close.lastIndex = opening;
  const match = close.exec(source);
  if (!match) {
    const rest = source.slice(opening);
    if (!looksDeclaredMetadata(rest)) return { metadata: undefined, prompt: source.trim() };
    return { raw: "", prompt: rest.trim(), error: "JOBS_TASK_YAML" };
  }
  const delimiterStart = match.index + (match[0].startsWith("\n") ? 1 : 0);
  const bodyStart = match.index + match[0].length;
  const raw = source.slice(opening, delimiterStart);
  if (!looksDeclaredMetadata(raw)) return { metadata: undefined, prompt: source.trim() };
  return { raw, prompt: source.slice(bodyStart).trim() };
}
/** Convert a positive whole-minute duration string to milliseconds.
 * @param {string} value Duration with m, h, d, or w suffix.
 * @param {string} name Field name used in validation errors.
 * @returns {number}
 * @throws {JobsError} If invalid or beyond the safe integer range.
 */
function duration(value, name) {
  if (typeof value !== "string") fail("JOBS_TASK_SCHEDULE", `${name} must be a duration string`);
  const match = value.match(/^(\d+)([mhdw])$/);
  if (!match) fail("JOBS_TASK_SCHEDULE", `${name} must be a positive whole-minute duration`);
  const count = BigInt(match[1]);
  const milliseconds = count * { m: 60_000n, h: 3_600_000n, d: 86_400_000n, w: 604_800_000n }[match[2]];
  if (count < 1n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) fail("JOBS_TASK_SCHEDULE", `${name} must be a positive whole-minute duration`);
  return Number(milliseconds);
}
const SCHEDULE_KEYS = new Set(["at", "every", "days"]);
/** Parse an HH:MM time with optional GMT basis.
 * @param {string} value
 * @returns {Readonly<{minutes: number, timeZone: string}>}
 * @throws {JobsError} If the time is invalid.
 */
function atTime(value) {
  if (typeof value !== "string") fail("JOBS_TASK_SCHEDULE", "at entries must be HH:MM optionally followed by GMT");
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)(?: (GMT))?$/i);
  if (!match) fail("JOBS_TASK_SCHEDULE", "at entries must be HH:MM optionally followed by GMT");
  return Object.freeze({ minutes: Number(match[1]) * 60 + Number(match[2]), timeZone: match[3] ? "gmt" : "local" });
}
/** Validate and normalize a structured at/every schedule.
 * @param {object} value
 * @returns {Readonly<object>}
 * @throws {JobsError} For unknown keys, invalid times/durations, or inconsistent schedules.
 */
function structuredSchedule(value) {
  for (const key of Object.keys(value)) if (!SCHEDULE_KEYS.has(key)) fail("JOBS_TASK_SCHEDULE", `schedule has an unknown key ${JSON.stringify(key)} (known: ${[...SCHEDULE_KEYS].join(", ")})`);
  const hasAt = Object.hasOwn(value, "at"), hasEvery = Object.hasOwn(value, "every");
  if (hasAt === hasEvery) fail("JOBS_TASK_SCHEDULE", "structured schedule must contain exactly one of at or every");
  const dayFilter = normalizeDays(value.days, "JOBS_TASK_SCHEDULE");
  if (hasEvery) {
    const every = value.every;
    return Object.freeze({ kind: "every", every, milliseconds: duration(every, "every"), days: dayFilter, timeZone: "local" });
  }
  if (!Array.isArray(value.at) || value.at.length === 0) fail("JOBS_TASK_SCHEDULE", "at must be a non-empty array of times");
  const times = value.at.map(atTime);
  const timeZone = times[0].timeZone;
  const minutes = new Set();
  for (const time of times) {
    if (time.timeZone !== timeZone) fail("JOBS_TASK_SCHEDULE", "at times cannot mix local and GMT bases");
    if (minutes.has(time.minutes)) fail("JOBS_TASK_SCHEDULE", "at times must be unique");
    minutes.add(time.minutes);
  }
  return Object.freeze({ kind: "at", minutes: Object.freeze([...minutes].sort((left, right) => left - right)), days: dayFilter, timeZone });
}
/** Normalize an optional schedule (defaulting to once).
 * @param {*} value
 * @returns {Readonly<object>}
 * @throws {JobsError} If the schedule is invalid.
 */
function schedule(value) {
  if (value === undefined || value === "once") return Object.freeze({ kind: "once" });
  if (plainObject(value)) return structuredSchedule(value);
  if (typeof value !== "string" || !value.startsWith("every ")) fail("JOBS_TASK_SCHEDULE", "schedule must be once or every <duration>");
  const every = value.slice(6);
  return Object.freeze({ kind: "every", every, milliseconds: duration(every, "every") });
}
/** Require and trim a nonempty string, identifying the field in errors.
 * @param {*} value
 * @param {string} key
 * @returns {string}
 * @throws {JobsError} If the value is not a nonempty string.
 */
function string(value, key) {
  if (typeof value !== "string" || !value.trim()) fail("JOBS_TASK_METADATA", `${key} must be a non-empty string`);
  return value.trim();
}
/** Reject credential-like keys and cyclic YAML aliases recursively.
 * @param {*} value
 * @param {WeakSet<object>} [ancestors=new WeakSet()]
 * @returns {void}
 * @throws {JobsError} For credential-like keys or cycles.
 */
function rejectCredentials(value, ancestors = new WeakSet()) {
  if (!Array.isArray(value) && !plainObject(value)) return;
  if (ancestors.has(value)) fail("JOBS_TASK_YAML_CYCLE", "task frontmatter cannot contain cyclic YAML aliases");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const nested of value) rejectCredentials(nested, ancestors);
  } else {
    for (const [key, nested] of Object.entries(value)) {
      if (CREDENTIAL.test(key)) fail("JOBS_TASK_CREDENTIAL", `frontmatter key ${JSON.stringify(key)} looks like a credential; credentials belong in settings, not task metadata`);
      rejectCredentials(nested, ancestors);
    }
  }
  ancestors.delete(value);
}
/** Recursively clone and freeze metadata containers.
 * @param {*} value
 * @param {WeakSet<object>} [ancestors=new WeakSet()]
 * @returns {*}
 * @throws {JobsError} For cyclic YAML aliases.
 */
function cloneAndFreeze(value, ancestors = new WeakSet()) {
  if (!Array.isArray(value) && !plainObject(value)) return value;
  if (ancestors.has(value)) fail("JOBS_TASK_YAML_CYCLE", "task frontmatter cannot contain cyclic YAML aliases");
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? value.map((nested) => cloneAndFreeze(nested, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneAndFreeze(nested, ancestors)]));
  ancestors.delete(value);
  return Object.freeze(copy);
}
/** Validate known task metadata and return normalized fields.
 * @param {object} metadata
 * @returns {Readonly<object>}
 * @throws {JobsError} For credential, key, type, or schedule validation failures.
 */
function validateMetadata(metadata) {
  rejectCredentials(metadata);
  for (const key of Object.keys(metadata)) if (!KNOWN.has(key)) fail("JOBS_TASK_UNKNOWN_KEY", `task frontmatter has an unknown key ${JSON.stringify(key)} (known: ${[...KNOWN].join(", ")})`);
  const id = metadata.id === undefined ? undefined : string(metadata.id, "id");
  if (metadata.enabled !== undefined && typeof metadata.enabled !== "boolean") fail("JOBS_TASK_METADATA", "enabled must be boolean");
  if (metadata.tools !== undefined && (!Array.isArray(metadata.tools) || metadata.tools.some((tool) => typeof tool !== "string" || !tool.trim()))) fail("JOBS_TASK_METADATA", "tools must be an array of non-empty strings");
  return Object.freeze({ id, enabled: metadata.enabled, schedule: schedule(metadata.schedule), tools: metadata.tools?.map((tool) => tool.trim()), timeout: metadata.timeout === undefined ? undefined : duration(metadata.timeout, "timeout"), model: metadata.model === undefined ? undefined : string(metadata.model, "model") });
}

/** Validate and return a nonempty filename-derived default task ID.
 * @param {string} filename
 * @returns {string}
 * @throws {JobsError} If filename is empty or not a string.
 */
export function taskId(filename) { return string(filename, "filename"); }
/** Map opaque IDs to bounded safe ledger filenames; unsafe IDs use a stable hash.
 * @param {string} id
 * @returns {string}
 * @throws {JobsError} If id is empty or not a string.
 */
export function taskStateKey(id) {
  const text = string(id, "id");
  const safe = text.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === text && safe.length <= 96 && ![".", ".."].includes(safe) ? safe : `task-${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}

/** Parse one task without filesystem side effects; declared bad frontmatter rejects the task.
 * @param {string} filename
 * @param {string} source
 * @returns {Readonly<object>}
 * @throws {JobsError} For invalid source, prompt, frontmatter, or metadata.
 */
export function parseTask(filename, source) {
  if (typeof source !== "string") fail("JOBS_TASK_SOURCE", "task source must be a string", { filename });
  const part = splitFrontmatter(source);
  if (!ACTIONABLE.test(part.prompt)) fail("JOBS_TASK_PROMPT", "task has no actionable prompt", { filename });
  if (part.metadata === undefined && part.raw === undefined) return defaultPlain(filename, part.prompt);
  if (part.error) taskFail(filename, part.error, "task frontmatter delimiter is invalid");
  try {
    const metadata = yaml(part.raw);
    const valid = validateMetadata(metadata);
    return Object.freeze({ id: valid.id ?? taskId(filename), filename: taskId(filename), prompt: part.prompt, enabled: valid.enabled ?? true, schedule: valid.schedule, tools: valid.tools === undefined ? undefined : Object.freeze(valid.tools), timeout: valid.timeout, model: valid.model, metadata: cloneAndFreeze(metadata), diagnostics: Object.freeze([]) });
  } catch (error) {
    if (!(error instanceof JobsError)) throw error;
    fail(error.code, error.message, { filename });
  }
}
/** Construct a frozen task using default metadata for plain Markdown.
 * @param {string} filename
 * @param {string} prompt
 * @returns {Readonly<object>}
 * @throws {JobsError} If filename is not a nonempty string.
 */
function defaultPlain(filename, prompt) {
  return Object.freeze({ id: taskId(filename), filename: taskId(filename), prompt, enabled: true, schedule: Object.freeze({ kind: "once" }), tools: undefined, timeout: undefined, model: undefined, metadata: Object.freeze({}), diagnostics: Object.freeze([]) });
}

/** Parse independently so duplicate ids and empty prompts remain task-local rejections.
 * @param {Array<{filename: string, source: string}>} tasks
 * @returns {Readonly<{tasks: ReadonlyArray<object>, diagnostics: ReadonlyArray<object>}>}
 * @throws {JobsError} If tasks is not an array; task-level JobsErrors become diagnostics.
 */
export function parseTasks(tasks) {
  if (!Array.isArray(tasks)) fail("JOBS_TASKS_TYPE", "tasks must be an array");
  const parsed = [], diagnostics = [], ids = new Map(), duplicateIds = new Set();
  for (const entry of tasks) {
    const filename = entry?.filename;
    try {
      const task = parseTask(filename, entry?.source);
      const previous = ids.get(task.id);
      if (previous || duplicateIds.has(task.id)) {
        const duplicate = `task id ${JSON.stringify(task.id)} is used by more than one task file; none of them run until the ids differ`;
        diagnostics.push(diagnostic(filename, "JOBS_TASK_DUPLICATE_ID", duplicate));
        if (previous) { diagnostics.push(diagnostic(previous.filename, "JOBS_TASK_DUPLICATE_ID", duplicate)); parsed.splice(parsed.indexOf(previous), 1); ids.delete(task.id); }
        duplicateIds.add(task.id);
      } else { ids.set(task.id, task); parsed.push(task); }
      diagnostics.push(...task.diagnostics);
    } catch (error) {
      if (!(error instanceof JobsError)) throw error;
      diagnostics.push(diagnostic(filename, error.code, error.message));
    }
  }
  return Object.freeze({ tasks: Object.freeze(parsed), diagnostics: Object.freeze(diagnostics) });
}

/** Split task source into frontmatter and prompt using the parser's fallback rules.
 * @param {string} source
 * @returns {object}
 */
export { splitFrontmatter };
