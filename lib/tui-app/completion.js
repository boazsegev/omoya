/**
 * lib/tui-helpers/completion.js — Tab completion (private to the TUI):
 * slash-command names, per-command argument candidates, and file-path
 * completion (split at the last "/" so only the trailing segment is
 * replaced and the directory prefix is preserved).
 */

/** @param {string[]} list @param {string} prefix */
function matchPrefix(list, prefix) {
  return [...new Set(list.filter((c) => c.startsWith(prefix)))].sort();
}

/**
 * Namespace-INSIDE matching: "/po" also finds "/context-pop" — the
 * typed text (after the "/") prefix-matches the part of the name
 * after its FIRST "-". Candidates already prefix-matched are not
 * repeated. Sorted, appended after the direct prefix matches.
 * @param {string[]} commands @param {string} word - the typed "/..."
 * @returns {string[]}
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

/** The matcher is deliberately I/O-free. The app supplies discovered entries. */
const defaultListDir = () => [];

/**
 * Compute completion candidates for the word under the cursor.
 * @param {string} line
 * @param {number} cursor
 * @param {Object} [sources]
 * @param {string[]} [sources.commands] - slash-command names
 * @param {string[]} [sources.modelCandidates] - provider/model completion values
 * @param {Object<string, string[]|(() => string[])>} [sources.argCandidates]
 *   - per-command argument completion lists (e.g. "/endpoint-model" →
 *   models, "/context-edit" → context indexes); consulted when the
 *   cursor sits past a command's first token
 * @param {(dir: string) => string[]} [sources.listDir]
 * @returns {{start: number, end: number, candidates: string[]}}
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

