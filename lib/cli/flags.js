/**
 * lib/cli/flags.js — the shared `--flag value` grammar of the three
 * executables (private to CLI). One parser, one error vocabulary.
 */

import Env from "../env.js";
const { parseDuration } = Env;

/**
 * Parse argv into a flat options object.
 *
 * Grammar: `--name value` for every name in `flags`; `--name` alone for
 * every name in `bools`; `--help`/`-h` short-circuits to `{help: true}`.
 * Names in `durations` parse as durations (a ms numeral or a unit
 * string: "500ms", "20s", "20m", "1h"); names in `numbers` must be
 * positive numbers. Anything else throws an Error whose message names the
 * offender. Relationships between flags and value-specific transforms are
 * executable policy and belong to the caller.
 * @param {string[]} argv - process.argv.slice(2)
 * @param {Object} spec
 * @param {string[]} spec.flags - value-taking flag names
 * @param {string[]} [spec.bools] - boolean flag names
 * @param {string[]} [spec.durations] - flags parsed as durations
 * @param {string[]} [spec.numbers] - flags parsed as positive numbers
 * @returns {Object} the parsed options (`{help: true}` for --help)
 */
export function parseFlags(argv, { flags, bools = [], durations = ["timeout"], numbers = ["max-turns", "max-tool-calls"] }) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    const key = flag.slice(2);
    if (bools.includes(key)) {
      args[key] = true;
      continue;
    }
    if (!flags.includes(key)) {
      throw new Error(`unknown flag: ${flag}`);
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    args[key] = value;
  }
  for (const name of durations) {
    if (args[name] === undefined) continue;
    try {
      args[name] = parseDuration(args[name]);
    } catch (err) {
      throw new Error(`--${name}: ${err.message}`);
    }
  }
  for (const name of numbers) {
    if (args[name] === undefined) continue;
    args[name] = Number(args[name]);
    if (!Number.isFinite(args[name]) || args[name] <= 0) {
      throw new Error(`--${name} must be a positive number`);
    }
  }
  return args;
}
