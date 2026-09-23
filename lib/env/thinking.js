/**
 * lib/env/thinking.js — the provider-neutral thinking vocabulary and its
 * translation to a model's native reasoning-effort symbols.
 *
 * The harness speaks one vocabulary (THINKING_LEVELS); Agent turns a
 * level into the `think` request option (undefined = default, false =
 * off, a level word otherwise — see lib/agent/thinking.js). Providers
 * translate `think` with resolveEffort() against what the MODEL accepts:
 * native symbols differ per model (OpenAI `none`/`minimal`/`xhigh`/`max`,
 * Anthropic `max`, Kimi `low`/`high`/`max`), and a level the model
 * lacks maps to its NEAREST supported symbol. A model that advertises
 * no default thinks at DEFAULT_THINKING.
 */

/** Selectable thinking levels, "default" first, then weakest → strongest. */
export const THINKING_LEVELS = ["default", "off", "low", "medium", "high", "xhigh"];

/** The effort used when the model advertises no default of its own. */
export const DEFAULT_THINKING = "high";

/** Every known native effort symbol, weakest → strongest. */
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Translate a `think` option to one native effort symbol.
 * @param {boolean|string|undefined} think - undefined/true: the model's
 *   default; false/"off": no reasoning; otherwise a level word
 * @param {object} [model]
 * @param {string[]} [model.levels] - native symbols the model accepts;
 *   unknown/empty: the translated word is trusted as-is
 * @param {string} [model.defaultLevel] - the model's advertised default
 * @returns {string} the native effort symbol to send
 */
export function resolveEffort(think, { levels, defaultLevel } = {}) {
  const word = think === false ? "none"
    : think === undefined || think === null || think === true ? defaultLevel ?? DEFAULT_THINKING
    : String(think).toLowerCase();
  const wanted = word === "off" ? "none"
    : word === "default" ? defaultLevel ?? DEFAULT_THINKING
    : word;
  const accepted = Array.isArray(levels) ? levels.filter((level) => typeof level === "string") : [];
  if (accepted.length === 0 || accepted.includes(wanted)) return wanted;
  return nearestEffort(wanted, accepted);
}

/**
 * The accepted symbol closest in strength to `wanted` (ties resolve to
 * the stronger symbol; unranked words count as DEFAULT_THINKING).
 */
function nearestEffort(wanted, accepted) {
  const rankOf = (symbol) => {
    const rank = EFFORT_RANK.indexOf(symbol);
    return rank >= 0 ? rank : EFFORT_RANK.indexOf(DEFAULT_THINKING);
  };
  const target = rankOf(wanted);
  let best = accepted[0];
  for (const symbol of accepted) {
    const distance = Math.abs(rankOf(symbol) - target);
    const bestDistance = Math.abs(rankOf(best) - target);
    if (distance < bestDistance || (distance === bestDistance && rankOf(symbol) > rankOf(best))) best = symbol;
  }
  return best;
}

/**
 * Order native effort symbols weakest → strongest, dropping duplicates
 * (unranked symbols keep their relative order at the end).
 * @param {string[]} levels
 * @returns {string[]}
 */
export function sortEfforts(levels) {
  const unique = [...new Set((levels ?? []).filter((level) => typeof level === "string" && level !== ""))];
  const rank = (symbol) => {
    const index = EFFORT_RANK.indexOf(symbol);
    return index >= 0 ? index : EFFORT_RANK.length;
  };
  return unique.sort((a, b) => rank(a) - rank(b));
}

/**
 * The effort symbols a models.dev registry entry declares
 * (`reasoning_options: [{type: "effort", values}]`), or undefined.
 * @param {object} entry - one registry model
 * @returns {string[]|undefined}
 */
export function registryEffortLevels(entry) {
  const options = Array.isArray(entry?.reasoning_options) ? entry.reasoning_options : [];
  const values = options
    .filter((option) => option?.type === "effort" && Array.isArray(option.values))
    .flatMap((option) => option.values);
  return values.length > 0 ? sortEfforts(values) : undefined;
}

/**
 * The values an API error lists as supported ("... Supported values
 * are: 'none', 'low', and 'high'."), or undefined.
 * @param {string} message
 * @returns {string[]|undefined}
 */
export function supportedValues(message) {
  const tail = /supported values are:?(.*)$/is.exec(String(message ?? ""))?.[1];
  const values = tail ? [...tail.matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
  return values.length > 0 ? values : undefined;
}
