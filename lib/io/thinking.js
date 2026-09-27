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

const isOff = (mode) => RANK[mode] === 0;

/** Each mode's rank: known symbols by RANK, unknown ones just above their predecessor. */
function ranks(modes) {
  let previous = -0.5;
  return modes.map((mode) => (previous = RANK[mode] ?? previous + 0.5));
}

/**
 * Map a `think` setting to one native mode.
 * @param {boolean|string|undefined} think - undefined/true/"default": the
 *   declared default (none declared: undefined, the endpoint's own
 *   default); false/"none"/"off": no reasoning; otherwise a level word
 * @param {string[]} [modes] - the model's native modes, least -> max
 * @param {string} [defaultMode] - the declared default (mapped onto modes)
 * @returns {string|undefined} the native mode; undefined = send nothing
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
 * @param {string[]} modes
 * @returns {string[]}
 */
export function thinkingSort(modes) {
  const unique = [...new Set((modes ?? []).filter((mode) => typeof mode === "string" && mode !== ""))];
  return unique.sort((a, b) => (RANK[a] ?? 7) - (RANK[b] ?? 7));
}

/**
 * The values an API error lists as supported ("... Supported values
 * are: 'none', 'low', and 'high'."), or undefined.
 * @param {string} message
 * @returns {string[]|undefined}
 */
export function thinkingFromError(message) {
  const tail = /supported values are:?(.*)$/is.exec(String(message ?? ""))?.[1];
  const values = tail ? [...tail.matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
  return values.length > 0 ? values : undefined;
}
