/**
 * lib/io/thinking.js — the library thinking vocabulary and its mapping
 * to a model's NATIVE modes (private to IO).
 *
 * The harness speaks one vocabulary (THINKING_LEVELS). A provider
 * publishes its native modes (`capabilities.thinking`, least -> max, an
 * off mode such as `none` first when it has one); a model entry may
 * narrow them (`thinking: [...]`, `[]` = no thinking control); a model
 * entry or the provider's capabilities may name a default
 * (`thinkingDefault`). IO maps the `think` setting to one native mode
 * before a provider reads it, so providers never translate.
 */

/** Selectable thinking levels, weakest -> strongest. Undefined means provider default. */
export const THINKING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];

/** Known symbols on one effort scale; `none`/`off` mean no reasoning. */
const RANK = { none: 0, off: 0, minimal: 0.5, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6 };

/**
 * Report whether a native mode represents no reasoning.
 * @param {string} mode - native mode symbol to inspect
 * @returns {boolean} true for the known zero-rank modes `none` and `off`
 * @remarks Pure for string mode symbols; does not modify input or external state.
 */
const isOff = (mode) => RANK[mode] === 0;

/**
 * Assign an effort rank to each native mode in order.
 * Known symbols use their `RANK` value; unknown symbols rank just above the
 * preceding mode (starting at -0.5).
 * @param {string[]} modes - native mode symbols ordered weakest to strongest
 * @returns {number[]} corresponding effort ranks in input order
 * @throws {TypeError} if `modes` is not an array with a callable `map` method
 * @remarks Pure; does not modify the input or external state.
 */
function ranks(modes) {
  let previous = -0.5;
  return modes.map((mode) => (previous = RANK[mode] ?? previous + 0.5));
}

/**
 * Map a `think` setting to one native mode.
 * @param {boolean|string|undefined|null} think - setting to map; omitted,
 *   `undefined`, `null`, `true`, or `"default"` selects `defaultMode` (or
 *   `undefined` when none is declared); `false`, `"none"`, or `"off"` requests
 *   no reasoning; other values are lowercased as level words.
 * @param {string[]} [modes] (default: `undefined`) - model native modes,
 *   ordered weakest to strongest; absent, non-array, or empty input returns
 *   `undefined`.
 * @param {string} [defaultMode] (default: `undefined`) - declared default
 *   native/effort mode, recursively mapped onto `modes` when the setting
 *   selects the default.
 * @returns {string|undefined} selected native mode; `undefined` means send
 *   no mode and let the endpoint use its own default.
 * @throws {TypeError} if `modes` has unexpected methods or a mode cannot be
 *   used as a property key during ranking.
 * @remarks Pure; does not modify inputs or external state.
 */
export function thinkingNative(think, modes, defaultMode) {
  if (!Array.isArray(modes) || modes.length === 0) return undefined;
  if (think === undefined || think === null || think === true || think === "default") {
    return typeof defaultMode === "string" ? thinkingNative(defaultMode, modes) : undefined;
  }
  const word = think === false || think === "off" ? "none" : String(think).toLowerCase();
  if (modes.includes(word)) return word;
  if (word === "none") return modes[0];
  const rank = ranks(modes);
  const wanted = RANK[word] ?? RANK.high;
  let best;
  modes.forEach((mode, index) => {
    if (!isOff(mode) && rank[index] <= wanted) best = mode;
  });
  return best ?? modes.find((mode) => !isOff(mode)) ?? modes[0];
}

/**
 * Order native symbols weakest -> strongest, dropping duplicates.
 * @param {string[]|null|undefined} modes (default: `undefined`) - native
 *   symbols to order; nullish values are treated as an empty list, and
 *   non-string or empty-string entries are discarded.
 * @returns {string[]} unique mode symbols ordered by known effort rank;
 *   unknown symbols sort after known symbols, with ties retaining sort order.
 * @throws {TypeError} if a non-nullish `modes` value lacks a callable `filter` method or is not iterable.
 * @remarks Returns a new array and does not mutate the input or external state.
 */
export function thinkingSort(modes) {
  const unique = [...new Set((modes ?? []).filter((mode) => typeof mode === "string" && mode !== ""))];
  return unique.sort((a, b) => (RANK[a] ?? 7) - (RANK[b] ?? 7));
}

/**
 * The values an API error lists as supported ("... Supported values
 * are: 'none', 'low', and 'high'."), or undefined.
 * @param {string|null|undefined} message (default: `undefined`) - API error
 *   text to inspect; nullish values are treated as an empty string.
 * @returns {string[]|undefined} quoted values following the supported-values
 *   phrase, or `undefined` if none are found.
 * @remarks Pure; does not modify inputs or external state. Coercion to string
 *   may invoke user-defined conversion behavior for non-string values.
 */
export function thinkingFromError(message) {
  const tail = /supported values are:?(.*)$/is.exec(String(message ?? ""))?.[1];
  const values = tail ? [...tail.matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
  return values.length > 0 ? values : undefined;
}
