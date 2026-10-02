/**
 * lib/tui-helpers/completion.js — Tab completion (private to the TUI):
 * slash-command names, per-command argument candidates, and file-path
 * completion (split at the last "/" so only the trailing segment is
 * replaced and the directory prefix is preserved).
 */

/**
 * Return sorted, unique values from `list` that start with `prefix`.
 * @param {string[]} list - Candidate values to inspect.
 * @param {string} prefix - Required leading text.
 * @returns {string[]} Matching candidates, deduplicated and sorted.
 * @throws {TypeError} If `list` is not an array of strings or `prefix` is not a string.
 */
function matchPrefix(list, prefix) {
  return [...new Set(list.filter((c) => c.startsWith(prefix)))].sort();
}

/**
 * Namespace-INSIDE matching: "/po" also finds "/context-pop" — the
 * typed text (after the "/") prefix-matches the part of the name
 * after its FIRST "-". Candidates already prefix-matched are not
 * repeated. Sorted, appended after the direct prefix matches.
 * @param {string[]} commands - Slash-command names to inspect.
 * @param {string} word - The typed slash-prefixed command fragment.
 * @returns {string[]} Sorted namespace-inside matches, excluding direct prefix matches.
 * @throws {TypeError} If `commands` is not an array of strings or `word` is not a string.
 */
export function matchNamespaceInside(commands, word) {
  const needle = word.slice(1);
  if (needle === "" || needle.includes("-")) return [];
  return commands
    .filter((c) => {
      const dash = c.indexOf("-");
      return dash > 0 && !c.startsWith(word) && c.slice(dash + 1).startsWith(needle);
    })
    .sort();
}

/**
 * Provide an empty directory listing for callers that do not supply one.
 * @returns {string[]} An empty list; performs no I/O.
 */
const defaultListDir = () => [];

/**
 * Compute candidates and the text range to replace for the word under the cursor.
 * Slash commands, prompt names, shim names, per-command argument lists, model names,
 * or filesystem entries are selected according to the token and cursor position.
 * @param {string} line - Complete input line.
 * @param {number} cursor - Cursor offset in `line` (defaults to no value; caller must supply it).
 * @param {Object} [sources={}] - Completion sources; omitted properties use the defaults below.
 * @param {string[]} [sources.commands=[]] - Slash-command names.
 * @param {string[]} [sources.prompts=[]] - Prompt names offered after built-in commands.
 * @param {string[]} [sources.shims=[]] - Tool shim names offered after prompts.
 * @param {string[]} [sources.modelCandidates=[]] - Provider/model values for `/endpoint-model`.
 * @param {Object<string, string[]|(() => string[])>} [sources.argCandidates={}] - Per-command
 *   argument lists (or zero-argument list providers), consulted past the first token.
 * @param {(dir: string) => string[]} [sources.listDir=defaultListDir] - Directory-entry provider;
 *   called with `.` for an unqualified path or the path's directory prefix without its final slash.
 * @returns {{start: number, end: number, candidates: string[]}} Replacement range and candidates.
 * @throws {TypeError} For invalid input/source shapes or if a supplied source is not callable as expected.
 * @throws {*} Any error thrown by a lazy argument-candidate provider or `listDir` propagates to the caller.
 * @effects Calls a lazy argument-candidate provider or `listDir` when the matching completion branch is used.
 */
export function computeCompletions(line, cursor, {
  commands = [], prompts = [], shims = [], modelCandidates = [], argCandidates = {}, listDir = defaultListDir,
} = {}) {
  const before = line.slice(0, cursor);
  const wordStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t")) + 1;
  const word = before.slice(wordStart);
  const firstToken = line.trim().split(/\s+/)[0];
  const isFirstToken = wordStart === 0 || before.slice(0, wordStart).trim() === "";

  if (isFirstToken && word.startsWith("/")) {
    // Built-ins lead completion: flat controls, then namespaced commands.
    // Prompts follow, then tool shims, so command behavior stays predictable.
    const flat = commands.filter((name) => !name.slice(1).includes("-"));
    const scoped = commands.filter((name) => name.slice(1).includes("-"));
    const seen = new Set();
    /**
     * Append previously unseen names while recording them in the shared set.
     * @param {string[]} list - Names to filter in their existing order.
     * @returns {string[]} Names not already seen; the set is updated as a side effect.
     */
    const append = (list) => list.filter((name) => !seen.has(name) && (seen.add(name), true));
    return {
      start: wordStart,
      end: cursor,
      candidates: append([
        ...matchPrefix(flat, word),
        ...matchPrefix(scoped, word),
        ...matchNamespaceInside(commands, word),
        ...matchPrefix(prompts, word),
        ...matchPrefix(shims, word),
      ]),
    };
  }
  if (!isFirstToken && firstToken in argCandidates) {
    const source = argCandidates[firstToken];
    const list = typeof source === "function" ? source() : source;
    return { start: wordStart, end: cursor, candidates: matchPrefix(list ?? [], word) };
  }
  if (firstToken === "/endpoint-model" && !isFirstToken) {
    return { start: wordStart, end: cursor, candidates: matchPrefix(modelCandidates, word) };
  }

  // File path completion: split at the last "/" so only the trailing
  // segment is replaced, and the directory prefix is preserved.
  const slash = word.lastIndexOf("/");
  const dir = slash >= 0 ? word.slice(0, slash + 1) : "";
  const base = slash >= 0 ? word.slice(slash + 1) : word;
  const dirArg = dir === "" ? "." : dir.replace(/\/$/, "");
  const entries = matchPrefix(listDir(dirArg), base);
  return { start: wordStart + dir.length, end: cursor, candidates: entries };
}

